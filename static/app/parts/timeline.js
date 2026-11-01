/* Keep playback scheduling separate from DOM repainting so live edits retain the transport. */

import { el, glyph, panelHead, voiceColor } from "../dom.js";

export const TL = {
  tabs: [], active: null, pxPerSec: 14, rowH: 44, minLanes: 3, collapsed: false,
  playing: false, ctx: null, master: null, sources: [], bufCache: {},
  playStart: 0, scheduled: 0, loopLen: 1, raf: 0, revealId: null, revealTimer: 0,
  clipGains: {}, resyncTimer: 0, seekPos: 0, pushTimer: 0,
  type: null, api: null, mount: null, dirty: new Set(), flushed: {},
};

const _tlLanes = (t) => t.clips.reduce((m, c) => Math.max(m, (c.track || 0) + 1), 0);
const _fmtLen = (s) => (Math.round((+s || 0) * 10) / 10) + "s";

function tlAc() {
  if (!TL.ctx) {
    TL.ctx = new (window.AudioContext || window.webkitAudioContext)();
    TL.master = TL.ctx.createGain();
    TL.master.gain.value = 0.9;
    TL.master.connect(TL.ctx.destination);
  }
  if (TL.ctx.state === "suspended") TL.ctx.resume();
  return TL.ctx;
}

async function tlBuf(url) {
  if (!url) return null;
  if (TL.bufCache[url]) return TL.bufCache[url];
  const ab = await (await fetch(url)).arrayBuffer();
  TL.bufCache[url] = await tlAc().decodeAudioData(ab);
  return TL.bufCache[url];
}

export function tlActive() {
  return TL.tabs.find((x) => x.id === TL.active) || TL.tabs[0] || null;
}

function _tlGrow() {
  const t = tlActive(); if (!t) return;
  t.length = Math.max(40, ...t.clips.map((c) => c.start + c.len + 5));
}

const _tlContentLen = (t) =>
  t.clips.reduce((m, c) => Math.max(m, (c.start || 0) + (c.len || 0)), 0);

/* Stretch positions, trims and fades together, then request audio at the new lengths. */

function _tlStretch(newTotal) {
  const t = tlActive(); if (!t) return;
  const cur = _tlContentLen(t);
  if (cur <= 0 || !(newTotal > 0)) return;
  const s = newTotal / cur;
  if (Math.abs(s - 1) < 1e-3) return;
  for (const c of t.clips) {
    c.start = Math.max(0, Math.round(c.start * s * 4) / 4);
    c.len = Math.max(0.5, Math.round(c.len * s * 4) / 4);
    c.offset = (c.offset || 0) * s;
    c.fadeIn = Math.min(c.len, (c.fadeIn || 0) * s);
    c.fadeOut = Math.min(c.len, (c.fadeOut || 0) * s);
    TL.dirty.add(c.id);
  }
  _tlGrow(); tlSave(); renderTimeline(); _tlQueueResync();
  for (const c of t.clips) _tlEnsureLength(c);
}

/* Debounce changed clip snapshots only; writing every clip per drag bloats the append-only log. */

function _snap(c) {
  return JSON.stringify([c.track, c.start, c.len, c.offset, c.gain,
                         c.fadeIn, c.fadeOut, c.label]);
}

export function tlSave() {
  const t = tlActive();
  if (!t || !TL.api) return;
  clearTimeout(TL.pushTimer);
  TL.pushTimer = setTimeout(async () => {
    const cur = tlActive();
    if (!cur) return;
    for (const c of cur.clips) {
      const s = _snap(c);
      if (!TL.dirty.has(c.id) && TL.flushed[c.id] === s) continue;
      TL.dirty.delete(c.id);
      TL.flushed[c.id] = s;
      try {
        await TL.api.putClip(cur.id, {
          clip: c.id, ref: c.ref, track: c.track, start: c.start, len: c.len,
          offset: c.offset, gain: c.gain, fadeIn: c.fadeIn, fadeOut: c.fadeOut,
          src_len: c.dur || 0, label: c.label,
        });
      } catch (e) { console.warn("timeline save:", e.message); }
    }
  }, 400);
}

/* Server clips are resolved already; fill only editor-specific defaults. */

export function tlAdopt(arrangements, { type, api, keepActive = true } = {}) {
  if (type) TL.type = type;
  if (api) TL.api = api;
  const was = keepActive ? TL.active : null;
  TL.tabs = (arrangements || []).map((a) => ({
    id: a.id, name: a.name, loop: true, length: Math.max(40, a.length || 0),
    clips: (a.clips || []).map((c) => ({
      id: c.id, ref: c.ref, label: c.label, name: c.name || null, audio: c.audio || null,
      missing: !!c.missing,
      track: c.track || 0, start: c.start || 0,
      len: c.len == null ? (c.src_len || 18) : c.len,
      dur: c.src_len || 0, offset: c.offset || 0,
      fadeIn: c.fadeIn || 0, fadeOut: c.fadeOut || 0,
      gain: c.gain == null ? 1 : c.gain,
      renderUrl: null, renderLen: 0, rendering: false,
    })),
  }));
  TL.flushed = {};
  for (const t of TL.tabs) for (const c of t.clips) TL.flushed[c.id] = _snap(c);
  TL.active = (was && TL.tabs.some((t) => t.id === was)) ? was
            : (TL.tabs[0] && TL.tabs[0].id) || null;
}

export function tlStop() {
  TL.playing = false;
  TL.sources.forEach((s) => { try { s.stop(); } catch (_) {} });
  TL.sources = [];
  Object.values(TL.clipGains).forEach((g) => { try { g.disconnect(); } catch (_) {} });
  TL.clipGains = {};
  if (TL.raf) cancelAnimationFrame(TL.raf);
  TL.raf = 0;
  TL.seekPos = 0;
  const ph = TL.mount && TL.mount.querySelector(".tl-playhead");
  if (ph) ph.style.left = "0px";
  const pb = TL.mount && TL.mount.querySelector(".tl-play");
  if (pb) { pb.replaceChildren(glyph("play", 14)); pb.classList.remove("on"); }
}

/* Keep gain nodes across loop iterations and rescheduling so volume edits do not glitch. */

function _tlClipGain(id, gv) {
  let g = TL.clipGains[id];
  if (!g) {
    g = TL.ctx.createGain(); g.gain.value = gv;
    g.connect(TL.master); TL.clipGains[id] = g;
  }
  return g;
}

/* Resume intersecting clips mid-buffer with the correct fade envelope after seeks. */

function _tlScheduleIter(i) {
  const ctx = TL.ctx, t = tlActive(), now = ctx.currentTime;
  if (!t) return;
  const base = TL.playStart + i * TL.loopLen;
  for (const c of t.clips) {
    /* Use extended renders when available; never loop a shorter source to fake an extension. */

    const buf = TL.bufCache[c.renderUrl || c.audio];
    if (!buf) continue;
    const off = c.offset || 0, t0 = base + c.start, t1 = t0 + c.len;
    if (t1 <= now + 0.005) continue;
    const src = ctx.createBufferSource(); src.buffer = buf;
    const fade = ctx.createGain();
    const fi = Math.min(c.fadeIn || 0, c.len);
    const fo = Math.min(c.fadeOut || 0, c.len);
    const foStart = c.len - fo;
    let startAt = t0, bufOff = off, head = 0;            /* head = seconds already in */
    if (t0 < now) { head = now - t0; startAt = now; bufOff = off + head; }
    const unitAt = (x) => {
      let g = 1;
      if (fi > 0 && x < fi) g = x / fi;
      if (fo > 0 && x > foStart) g = Math.min(g, (c.len - x) / fo);
      return Math.max(0.0001, g);
    };
    fade.gain.setValueAtTime(unitAt(head), startAt);
    if (head < fi) fade.gain.linearRampToValueAtTime(1, t0 + fi);
    if (head < foStart) fade.gain.setValueAtTime(1, t0 + foStart);
    if (fo > 0) fade.gain.linearRampToValueAtTime(0.0001, t1);
    src.connect(fade).connect(_tlClipGain(c.id, c.gain == null ? 1 : c.gain));
    try { src.start(startAt, bufOff); }
    catch (_) { try { src.start(now, bufOff); } catch (_) {} }
    src.stop(t1 + 0.02);
    TL.sources.push(src);
  }
}

/* Reschedule from the current position without stopping transport playback. */

function _tlResyncAt(loopPos) {
  const ctx = TL.ctx, t = tlActive();
  if (!ctx || !TL.playing || !t) return;
  TL.sources.forEach((s) => { try { s.stop(); } catch (_) {} });
  TL.sources = [];
  if (!t.clips.length) { tlStop(); renderTimeline(); return; }
  TL.loopLen = Math.max(...t.clips.map((c) => c.start + c.len), 1);
  loopPos = t.loop ? ((loopPos % TL.loopLen) + TL.loopLen) % TL.loopLen
                   : Math.max(0, Math.min(loopPos, TL.loopLen));
  TL.playStart = ctx.currentTime - loopPos;
  TL.scheduled = 0;
  _tlScheduleIter(0); TL.scheduled = 1;
  if (t.loop) { _tlScheduleIter(1); TL.scheduled = 2; }
  _tlPlayhead(loopPos);
}

function _tlLiveResync() {
  if (!TL.playing || !TL.ctx) return;
  const t = tlActive(); if (!t) return;
  const elapsed = TL.ctx.currentTime - TL.playStart;
  _tlResyncAt(t.loop ? ((elapsed % TL.loopLen) + TL.loopLen) % TL.loopLen : elapsed);
}

function _tlQueueResync() {     /* Coalesce bursts of edits before rescheduling. */
  if (!TL.playing) return;
  clearTimeout(TL.resyncTimer);
  TL.resyncTimer = setTimeout(_tlLiveResync, 90);
}

/* Seeking while stopped updates the next start; seeking while playing reschedules immediately. */

function _tlSeek(pos) {
  const t = tlActive(); if (!t || !t.clips.length) return;
  TL.loopLen = Math.max(...t.clips.map((c) => c.start + c.len), 1);
  pos = Math.max(0, Math.min(pos, TL.loopLen));
  if (TL.playing) _tlResyncAt(pos);
  else { TL.seekPos = pos; _tlPlayhead(pos); }
}

export async function tlPlay() {
  if (TL.playing) { tlStop(); return; }
  const t = tlActive();
  if (!t || !t.clips.length) return;
  const ctx = tlAc();
  await Promise.all([...new Set(t.clips.map((c) => c.renderUrl || c.audio))]
    .map((u) => tlBuf(u).catch(() => null)));
  TL.playing = true; TL.sources = []; TL.clipGains = {};
  TL.loopLen = Math.max(...t.clips.map((c) => c.start + c.len), 1);
  const startPos = Math.max(0, Math.min(TL.seekPos || 0, TL.loopLen));
  TL.playStart = ctx.currentTime + 0.08 - startPos;
  TL.scheduled = 0;
  _tlScheduleIter(0); TL.scheduled = 1;
  if (t.loop) { _tlScheduleIter(1); TL.scheduled = 2; }
  const pb = TL.mount && TL.mount.querySelector(".tl-play");
  if (pb) { pb.replaceChildren(glyph("stop", 14)); pb.classList.add("on"); }
  const tick = () => {
    if (!TL.playing) return;
    const elapsed = ctx.currentTime - TL.playStart;
    if (t.loop) {
      const needed = Math.floor(elapsed / TL.loopLen) + 2;
      while (TL.scheduled < needed) { _tlScheduleIter(TL.scheduled); TL.scheduled++; }
      _tlPlayhead(((elapsed % TL.loopLen) + TL.loopLen) % TL.loopLen);
    } else {
      _tlPlayhead(elapsed);
      if (elapsed >= TL.loopLen) { tlStop(); return; }
    }
    TL.raf = requestAnimationFrame(tick);
  };
  TL.raf = requestAnimationFrame(tick);
}

function _tlPlayhead(pos) {
  const ph = TL.mount && TL.mount.querySelector(".tl-playhead");
  if (ph) ph.style.left = (pos * TL.pxPerSec) + "px";
}

/* Snapshot drag state at pointerdown so moves do not accumulate rounding errors. */
function _tlDrag(handle, start, apply, done) {
  handle.addEventListener("pointerdown", (e) => {
    if (e.button) return;
    e.preventDefault(); e.stopPropagation();
    const sx = e.clientX, sy = e.clientY, o = start ? start() : null;
    try { handle.setPointerCapture(e.pointerId); } catch (_) {}
    const mv = (ev) => apply(o, (ev.clientX - sx) / TL.pxPerSec, ev.clientY - sy);
    const up = () => {
      try { handle.releasePointerCapture(e.pointerId); } catch (_) {}
      handle.removeEventListener("pointermove", mv);
      handle.removeEventListener("pointerup", up);
      if (done) done();
    };
    handle.addEventListener("pointermove", mv);
    handle.addEventListener("pointerup", up);
  });
}

/* Preserve horizontal scroll and playback across complete DOM rebuilds. */

export function tlSetOpen(open) {
  TL.collapsed = !open;
  /* Report through injected hooks; the renderer must not import the data layer. */

  if (TL.api && TL.api.setOpen) TL.api.setOpen(open);
}

export function renderTimeline() {
  const host = TL.mount;
  if (!host) return;
  const prevBody = host.querySelector(".tl-body");
  const prevScroll = prevBody ? prevBody.scrollLeft : 0;
  host.replaceChildren();

  const head = panelHead({
    label: "timelines",
    open: !TL.collapsed,
    onToggle: (open) => { tlSetOpen(open); renderTimeline(); },
  });
  host.append(head);
  if (TL.collapsed) return;

  const tabbar = el("div.tl-tabs");
  for (const t of TL.tabs) {
    const tab = el("span.tl-tab" + (t.id === TL.active ? ".active" : ""));
    const nm = el("button.tl-tab-nm", { type: "button",
      text: t.name + (t.clips.length ? ` · ${t.clips.length}` : "") });
    nm.onclick = () => {
      if (TL.playing) tlStop();
      TL.active = t.id; tlSetOpen(true); renderTimeline();
    };
    nm.ondblclick = async () => {
      const n = prompt("Rename timeline", t.name);
      if (n && TL.api) {
        t.name = n;
        try { await TL.api.rename(t.id, n); } catch (e) { console.warn(e.message); }
        renderTimeline();
      }
    };
    const xb = el("button.tl-tab-x", { type: "button", title: "delete this timeline" }, [glyph("cut", 12)]);
    xb.onclick = async (e) => {
      e.stopPropagation();
      if (!confirm(`Delete timeline "${t.name}"?`)) return;
      if (TL.playing) tlStop();
      try { await TL.api.remove(t.id); } catch (err) { console.warn(err.message); }
      await TL.api.refresh();
    };
    tab.append(nm, xb);
    tabbar.append(tab);
  }
  const add = el("button.tl-tab-add", { type: "button" }, [glyph("plus", 12), "new"]);
  add.onclick = async () => {
    if (!TL.api) return;
    try {
      const made = await TL.api.create(TL.type, `timeline ${TL.tabs.length + 1}`);
      await TL.api.refresh();
      TL.active = made.id; tlSetOpen(true); renderTimeline();
    } catch (e) { console.warn(e.message); }
  };
  const dup = el("button.tl-tab-add", { type: "button",
    title: "duplicate the current timeline into a new tab" }, [glyph("dup", 12), "dup"]);
  dup.onclick = () => tlDuplicate();
  tabbar.append(add, dup);
  host.append(tabbar);

  const t = tlActive();
  if (!t) {
    host.append(el("div.tl-ctrl", {}, [
      el("span.tl-hint", { text: "no timeline yet — press + new" })]));
    return;
  }

  const ctrl = el("div.tl-ctrl");
  const play = el("button.tl-play" + (TL.playing ? ".on" : ""), { type: "button" },
    [glyph(TL.playing ? "stop" : "play", 14)]);
  play.onclick = tlPlay;
  const loop = el("button.tl-loop" + (t.loop ? ".on" : ""),
    { type: "button", title: "loop" }, [glyph("loop", 14)]);
  loop.onclick = () => { t.loop = !t.loop; renderTimeline(); };

  /* Scale all clip timing together and regenerate audio at the stretched lengths. */

  const stretch = el("span.tl-stretch", {}, [
    el("span.tl-stretch-lab", { text: "⟺ total" })]);
  const sinp = el("input.tl-stretch-inp", { type: "number", min: "1", step: "1",
    title: "set total length — all clips scale to fit" });
  sinp.value = Math.round(_tlContentLen(t)) || "";
  const applyStretch = () => {
    const v = parseFloat(sinp.value);
    if (v > 0) _tlStretch(v);
  };
  sinp.addEventListener("change", applyStretch);
  sinp.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); applyStretch(); }
  });
  const mkMul = (f, lab) => {
    const b = el("button.tl-stretch-x", { type: "button", text: lab, title: "×" + f });
    b.onclick = () => _tlStretch(_tlContentLen(t) * f);
    return b;
  };
  stretch.append(sinp, el("span.tl-stretch-lab", { text: "s" }),
                 mkMul(0.5, "÷2"), mkMul(2, "×2"));

  /* Relayout during zoom drag without rebuilding the slider; repaint fully on release. */

  const zoom = el("span.tl-zoom", {}, [el("span.tl-stretch-lab", { text: "⇔ zoom" })]);
  const zin = el("input.tl-zoom-in", { type: "range", min: "3", max: "80",
    step: "1", title: "x-axis scale (px per second)" });
  zin.value = String(TL.pxPerSec);
  zin.addEventListener("input", () => {
    TL.pxPerSec = Number(zin.value) || 14;
    try { localStorage.setItem("tl.px", zin.value); } catch (_) {}
    _tlZoomLayout();
  });
  zin.addEventListener("change", () => renderTimeline());
  zoom.append(zin);

  ctrl.append(play, loop, stretch, zoom, el("span.tl-hint", {
    text: "＋ adds a part · body = move (lanes grow) · left edge = trim · "
        + "right edge = length · corners = fades · line = volume · × = remove" }));
  host.append(ctrl);

  const body = el("div.tl-body");
  const w = Math.max(t.length, 20) * TL.pxPerSec;
  const ruler = el("div.tl-ruler", { title: "click / drag to move the playhead" });
  ruler.style.width = w + "px";
  for (let s = 0; s <= t.length; s += 5) {
    const m = el("span.tl-tick", { text: s + "s" });
    m.style.left = (s * TL.pxPerSec) + "px";
    ruler.append(m);
  }
  const seekTo = (clientX) => {
    const r = ruler.getBoundingClientRect();
    _tlSeek((clientX - r.left) / TL.pxPerSec);
  };
  ruler.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    try { ruler.setPointerCapture(e.pointerId); } catch (_) {}
    seekTo(e.clientX);
    const mv = (ev) => seekTo(ev.clientX);
    const up = () => {
      try { ruler.releasePointerCapture(e.pointerId); } catch (_) {}
      ruler.removeEventListener("pointermove", mv);
      ruler.removeEventListener("pointerup", up);
    };
    ruler.addEventListener("pointermove", mv);
    ruler.addEventListener("pointerup", up);
  });
  body.append(ruler);

  const wrap = el("div.tl-tracks");
  wrap.style.width = w + "px";
  /* Keep one spare lane so clips can be dragged beyond the current stack. */
  const lanes = Math.max(TL.minLanes, _tlLanes(t) + 1);
  wrap.style.height = (lanes * TL.rowH) + "px";
  for (let i = 0; i < lanes; i++) {
    const r = el("div.tl-track");
    r.dataset.track = String(i);
    wrap.append(r);
  }
  for (const c of t.clips) _tlRenderClip(c, wrap);
  const ph = el("div.tl-playhead");
  ph.style.left = ((TL.playing ? 0 : (TL.seekPos || 0)) * TL.pxPerSec) + "px";
  wrap.append(ph);
  body.append(wrap);
  host.append(body);
  if (prevScroll) body.scrollLeft = prevScroll;      /* Preserve scroll position across redraws. */
}

/* Relayout without rebuilding so the zoom slider keeps pointer capture. */
function _tlZoomLayout() {
  const host = TL.mount, t = tlActive();
  if (!host || !t) return;
  const w = Math.max(t.length, 20) * TL.pxPerSec;
  const ruler = host.querySelector(".tl-ruler");
  const wrap = host.querySelector(".tl-tracks");
  if (ruler) {
    ruler.style.width = w + "px";
    [...ruler.querySelectorAll(".tl-tick")].forEach((m, i) => {
      m.style.left = (i * 5 * TL.pxPerSec) + "px";
    });
  }
  if (wrap) {
    wrap.style.width = w + "px";
    for (const c of t.clips) {
      const elc = wrap.querySelector(`.tl-clip[data-id="${c.id}"]`);
      if (!elc) continue;
      elc.style.left = (c.start * TL.pxPerSec) + "px";
      elc.style.width = (c.len * TL.pxPerSec) + "px";
    }
  }
}

function _tlFadeVis(c, h) {
  h.fi.style.width = ((c.fadeIn || 0) * TL.pxPerSec) + "px";
  h.fo.style.width = ((c.fadeOut || 0) * TL.pxPerSec) + "px";
  h.hIn.style.left = ((c.fadeIn || 0) * TL.pxPerSec) + "px";
  h.hOut.style.right = ((c.fadeOut || 0) * TL.pxPerSec) + "px";
}

/* Touch has no hover; briefly reveal remove controls after a tap. */
function _tlRevealClip(id) {
  TL.revealId = id;
  clearTimeout(TL.revealTimer);
  if (TL.mount) TL.mount.querySelectorAll(".tl-clip").forEach((e) =>
    e.classList.toggle("reveal", e.dataset.id === id));
  TL.revealTimer = setTimeout(() => {
    TL.revealId = null;
    if (TL.mount) TL.mount.querySelectorAll(".tl-clip.reveal")
      .forEach((e) => e.classList.remove("reveal"));
  }, 2600);
}

function _tlRenderClip(c, wrap) {
  const clip = el("div.tl-clip" + (c.id === TL.revealId ? ".reveal" : "")
                  + (c.rendering ? ".rendering" : "")
                  + (c.missing ? ".gone" : ""));
  clip.dataset.id = c.id;
  clip.style.left = (c.start * TL.pxPerSec) + "px";
  clip.style.width = (c.len * TL.pxPerSec) + "px";
  clip.style.top = (((c.track || 0) * TL.rowH) + 2) + "px";
  const wave = el("canvas.tl-wave");
  const fi = el("div.tl-fade.tl-fade-in"), fo = el("div.tl-fade.tl-fade-out");

  const lbl = el("span.tl-clip-lbl", { title: c.label || "",
    text: c.name && TL.api && TL.api.prefix ? `${TL.api.prefix}:${c.name} · ${(c.ref || {}).part || ""}` : c.label || c.id });
  const gain = el("div.tl-gain", { title: "drag for volume" });
  const hIn = el("div.tl-fh.tl-fh-in", { title: "fade in" });
  const hOut = el("div.tl-fh.tl-fh-out", { title: "fade out" });
  const lz = el("div.tl-lz", { title: "trim in-point" });
  const rz = el("div.tl-rz", { title: "length" });
  const xb = el("button.tl-clip-x", { type: "button", title: "remove" }, [glyph("cut", 12)]);
  const len = el("button.tl-len", { type: "button", text: _fmtLen(c.len),
    title: "set length" });
  clip.append(wave, fi, fo, gain, lbl, hIn, hOut, lz, rz, xb, len);
  if (c.rendering) clip.append(el("span.tl-render-badge", { text: "rendering…" }));
  const h = { wave, fi, fo, hIn, hOut, lz, rz, gain, xb, len };
  gain.style.bottom = ((c.gain == null ? 1 : c.gain) / 1.2 * 100) + "%";
  _tlFadeVis(c, h);
  wrap.append(clip);
  _tlPaintWave(clip, c, wave);
  _tlWireClip(clip, c, wrap, h);
}

/* Draw only the source waveform region that survives the clip trim. */
function _tlPaintWave(clip, c, canvas) {
  const draw = (buf) => {
    const W = Math.max(2, Math.round(c.len * TL.pxPerSec)), H = 38;
    canvas.width = W; canvas.height = H;
    const g = canvas.getContext("2d");
    g.clearRect(0, 0, W, H);
    if (!buf) return;
    const ch = buf.getChannelData(0), sr = buf.sampleRate, dur = buf.duration;
    const off = c.offset || 0, span = Math.min(c.len, Math.max(0.01, dur - off));
    const start = Math.floor(off * sr), total = Math.floor(span * sr);
    const cols = Math.max(1, Math.min(W, Math.round(span / c.len * W)));
    const per = Math.max(1, Math.floor(total / cols)), mid = H / 2;
    /* Use the shared voice color so timeline and card lanes agree. */
    g.strokeStyle = (c.ref && c.ref.part) ? voiceColor(c.ref.part) : "rgba(210,210,210,.5)";
    g.lineWidth = 1;
    g.beginPath();
    for (let x = 0; x < cols; x++) {
      let mn = 1, mx = -1;
      const s0 = start + x * per;
      for (let i = 0; i < per; i++) {
        const v = ch[s0 + i] || 0;
        if (v < mn) mn = v;
        if (v > mx) mx = v;
      }
      g.moveTo(x + 0.5, mid - mx * mid * 0.9);
      g.lineTo(x + 0.5, mid - mn * mid * 0.9);
    }
    g.stroke();
  };
  const wurl = c.renderUrl || c.audio;   /* Prefer the extended waveform when a longer render is available. */
  const cached = TL.bufCache[wurl];
  if (cached) draw(cached); else tlBuf(wurl).then(draw).catch(() => {});
}

/* Request natural extensions rather than loops; round lengths to a shared grid for cache reuse. */

function _tlEnsureLength(c) {
  const baseDur = (TL.bufCache[c.audio] || {}).duration || c.dur || 0;
  if (!c.ref || !TL.api || !TL.api.renderAt) return;
  if (c.len <= baseDur + 0.15) {           /* Drop extensions once the clip fits its original source. */
    if (c.renderUrl) {
      c.renderUrl = null; c.renderLen = 0; c.rendering = false;
      renderTimeline(); _tlQueueResync();
    }
    return;
  }
  const q = Math.ceil(c.len / 2) * 2;      /* Round up so the cached render is never shorter than the clip. */
  if (c.renderUrl && c.renderLen === q) return;
  const url = TL.api.renderAt(c.ref, q);
  c.rendering = true;
  renderTimeline();
  tlBuf(url).then(() => {
    if (Math.ceil(c.len / 2) * 2 !== q) { c.rendering = false; return; }  /* Ignore superseded render responses. */
    c.renderUrl = url; c.renderLen = q; c.rendering = false;
    renderTimeline(); _tlQueueResync();
  }).catch(() => { c.rendering = false; renderTimeline(); });
}

function _tlSetLen(c, secs) {
  c.len = Math.max(0.5, Math.round(secs * 4) / 4);
  TL.dirty.add(c.id);
  _tlGrow(); tlSave(); renderTimeline(); _tlQueueResync(); _tlEnsureLength(c);
}

function _tlLenMenu(c, clip, wrap) {
  if (TL.mount) TL.mount.querySelectorAll(".tl-len-menu").forEach((m) => m.remove());
  const menu = el("div.tl-len-menu");
  const mk = (secs, label) => {
    const b = el("button.tl-len-opt", { type: "button", text: label });
    b.addEventListener("pointerdown", (e) => e.stopPropagation());
    b.addEventListener("click", (e) => { e.stopPropagation(); _tlSetLen(c, secs); });
    return b;
  };
  [10, 15, 30, 45, 60].forEach((s) => menu.append(mk(s, s + "s")));
  const baseDur = (TL.bufCache[c.audio] || {}).duration || c.dur || 0;
  if (baseDur) menu.append(mk(+baseDur.toFixed(2), "fit"));
  const inp = el("input.tl-len-inp", { type: "number", min: "1", step: "1",
    placeholder: "sec" });
  inp.value = Math.round(c.len);
  inp.addEventListener("pointerdown", (e) => e.stopPropagation());
  inp.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { const v = parseFloat(inp.value); if (v > 0) _tlSetLen(c, v); }
  });
  menu.append(inp);
  menu.style.left = (parseFloat(clip.style.left) || 0) + "px";
  menu.style.top = ((parseFloat(clip.style.top) || 0) + 42) + "px";
  wrap.append(menu);
  const off = (ev) => {
    if (!menu.contains(ev.target)) {
      menu.remove();
      document.removeEventListener("pointerdown", off, true);
    }
  };
  setTimeout(() => document.addEventListener("pointerdown", off, true), 0);
}

function _tlWireClip(clip, c, wrap, h) {
  const t = tlActive();
  /* Stop pointerdown propagation so clip dragging cannot capture and swallow the remove click. */

  h.xb.addEventListener("pointerdown", (e) => e.stopPropagation());
  h.xb.onclick = async (e) => {
    e.stopPropagation();
    t.clips = t.clips.filter((y) => y !== c);
    _tlGrow(); renderTimeline(); _tlQueueResync();
    if (TL.api) { try { await TL.api.delClip(t.id, c.id); } catch (err) { console.warn(err.message); } }
  };

  h.len.addEventListener("pointerdown", (e) => e.stopPropagation());
  h.len.addEventListener("click", (e) => { e.stopPropagation(); _tlLenMenu(c, clip, wrap); });
  /* A stationary drag is a tap; touch uses it to reveal removal controls. */

  let moved = false;
  _tlDrag(clip, () => { moved = false; return { s: c.start, tr: c.track || 0 }; },
    (o, dx, dy) => {
      if (Math.abs(dx) > 0.05 || Math.abs(dy) > 3) moved = true;
      c.start = Math.max(0, Math.round((o.s + dx) * 4) / 4);
      c.track = Math.max(0, o.tr + Math.round(dy / TL.rowH));
      clip.style.left = (c.start * TL.pxPerSec) + "px";
      clip.style.top = ((c.track * TL.rowH) + 2) + "px";
    },
    () => {
      if (moved) { TL.dirty.add(c.id); _tlGrow(); tlSave(); renderTimeline(); _tlQueueResync(); }
      else _tlRevealClip(c.id);
    });
  /* Move source offset and timeline start together when trimming the left edge. */
  _tlDrag(h.lz, () => ({ off: c.offset || 0, s: c.start, len: c.len }),
    (o, dx) => {
      const delta = Math.min(Math.max(-o.off, Math.round(dx * 4) / 4), o.len - 0.25);
      c.offset = o.off + delta;
      c.start = Math.max(0, o.s + delta);
      c.len = o.len - delta;
      clip.style.left = (c.start * TL.pxPerSec) + "px";
      clip.style.width = (c.len * TL.pxPerSec) + "px";
    },
    () => { TL.dirty.add(c.id); _tlPaintWave(clip, c, h.wave); _tlGrow(); tlSave();
            renderTimeline(); _tlQueueResync(); _tlEnsureLength(c); });

  _tlDrag(h.rz, () => ({ len: c.len }),
    (o, dx) => {
      c.len = Math.max(0.5, Math.round((o.len + dx) * 4) / 4);
      clip.style.width = (c.len * TL.pxPerSec) + "px";
    },
    () => { TL.dirty.add(c.id); _tlPaintWave(clip, c, h.wave); _tlGrow(); tlSave();
            renderTimeline(); _tlQueueResync(); _tlEnsureLength(c); });

  _tlDrag(h.hIn, () => ({ f: c.fadeIn || 0 }),
    (o, dx) => { c.fadeIn = Math.max(0, Math.min(c.len, Math.round((o.f + dx) * 4) / 4));
                 _tlFadeVis(c, h); },
    () => { TL.dirty.add(c.id); tlSave(); _tlQueueResync(); });
  _tlDrag(h.hOut, () => ({ f: c.fadeOut || 0 }),
    (o, dx) => { c.fadeOut = Math.max(0, Math.min(c.len, Math.round((o.f - dx) * 4) / 4));
                 _tlFadeVis(c, h); },
    () => { TL.dirty.add(c.id); tlSave(); _tlQueueResync(); });
  /* Update the persistent gain node live rather than rescheduling audio on every move. */

  _tlDrag(h.gain, () => ({ g: c.gain == null ? 1 : c.gain }),
    (o, dx, dy) => {
      c.gain = Math.max(0, Math.min(1.2, o.g - dy / 90));
      h.gain.style.bottom = (c.gain / 1.2 * 100) + "%";
      const cg = TL.clipGains[c.id];
      if (cg && TL.ctx) cg.gain.setTargetAtTime(c.gain, TL.ctx.currentTime, 0.02);
    },
    () => { TL.dirty.add(c.id); tlSave(); });
}

/* Duplicate through placement calls so copied clips receive independent IDs. */

async function tlDuplicate() {
  const t = tlActive();
  if (!t || !TL.api) return;
  const made = await TL.api.create(TL.type, t.name + " copy");
  for (const c of t.clips) {
    await TL.api.putClip(made.id, {
      ref: c.ref, track: c.track, start: c.start, len: c.len, offset: c.offset,
      gain: c.gain, fadeIn: c.fadeIn, fadeOut: c.fadeOut, src_len: c.dur || 0,
      label: c.label,
    });
  }
  await TL.api.refresh();
  TL.active = made.id;
  renderTimeline();
}

export function mountTimeline(host, { type, api } = {}) {
  TL.mount = host;
  if (type) TL.type = type;
  if (api) TL.api = api;
  try {
    const z = parseInt(localStorage.getItem("tl.px"), 10);
    if (z >= 3 && z <= 200) TL.pxPerSec = z;
  } catch (_) {}
  renderTimeline();
}
