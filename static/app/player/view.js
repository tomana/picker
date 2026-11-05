/* The open card's player for a version with lanes: a ruler, a row per lane, one playhead, a transport bar. It owns
   one state (state.js) and one engine (engine.js); rows are drawn once and changed in place. The page hands it
   `ops`: signal(body) → the fresh card (the take-out's answer), claim() (stop the page's other players), toast, and
   bar() → the page's own buttons for the transport bar. */

import { el, glyph } from "../dom.js";
import { clock, firstSound } from "../parts/voice.js";
import { sourceOf, initial, reduce, program, outSignal } from "./state.js";
import { createEngine } from "./engine.js";

const WAVE = "#88a3bf";
let current = null;                     // the player that may be sounding; the page's stop pauses it

/* The page's stopAudio calls this: something else is about to play. */
export function pausePlayer() { if (current) current.pause(); }

/* Whether a version (or item) is the new player's: it has lanes with their own files. */
export function playable(card, n, item = null) { return sourceOf(card, n, item).lanes.length > 0; }

export function createPlayer(card, where, ops, { resume = null } = {}) {
  let P = initial(sourceOf(card, where.n, where.item));
  let scrubAt = null, claiming = false;
  const engine = createEngine({
    onTick: (s) => place(s),
    onEnded: () => { dispatch({ type: "ended" }); },
    onError: (m) => { ops.toast(`the player: ${m}`); },
  });

  const root = el("div.np", { "data-np": "" });
  const lanes = el("div.np-lanes");
  const ruler = el("div.np-ruler", { title: "tap or drag: move the playhead" });
  const tcv = el("canvas.np-ticks");
  const rtime = el("span.np-t");
  ruler.append(el("i.np-r0"), el("div.np-rcell", {}, [tcv]), rtime);
  // the ruler scrolls with the rows (sticky), so a scrollbar narrows both alike; the head is over both
  const rows = el("div.np-rows");
  const head = el("i.np-head");
  lanes.append(rows, head);
  const playBtn = el("button.np-play", { type: "button", title: "play", "aria-label": "play" });
  const over = el("div.np-over", { title: "the whole piece: tap or drag to move" });
  const ocv = el("canvas"), fill = el("i.np-fill");
  over.append(ocv, fill);
  const time = el("span.np-time");
  const bar = el("div.np-bar", {}, [playBtn, over, time, ...(ops.bar ? ops.bar() : [])]);
  root.append(lanes, bar);

  const rowOf = new Map();
  const paintRows = () => {
    rowOf.clear();
    rows.replaceChildren(ruler, ...P.lanes.map((l) => {
      const solo = el("button.np-b.np-solo", { type: "button" });
      const strip = el("div.np-strip", {}, [el("canvas"), el("span.np-name", { text: l.label })]);
      const out = el("button.np-b.np-out", { type: "button" }, [glyph("trash", 18)]);
      const mute = el("button.np-b.np-mute", { type: "button" });
      solo.onclick = () => soloTap(l.id);
      out.onclick = () => outTap(l.id);
      mute.onclick = () => dispatch({ type: "mute", lane: l.id, on: !lane(l.id).muted });
      seekSurface(strip, true);
      const row = el("div.np-row", { "data-lane": l.id }, [solo, strip, out, mute]);
      rowOf.set(l.id, { row, solo, out, mute, strip });
      return row;
    }));
    paintState();
    requestAnimationFrame(drawAll);
  };
  const lane = (id) => P.lanes.find((x) => x.id === id) || {};

  /* Classes and glyphs only: the rows stay. */
  const paintState = () => {
    for (const l of P.lanes) {
      const r = rowOf.get(l.id);
      if (!r) continue;
      r.row.classList.toggle("out", l.out);
      r.row.classList.toggle("muted", l.muted);
      r.row.classList.toggle("pending", l.pending);
      r.row.classList.toggle("solo", P.solo === l.id);
      r.row.classList.toggle("under", !!P.solo && P.solo !== l.id);
      const soloing = P.solo === l.id && engine.playing;
      r.solo.replaceChildren(glyph(soloing ? "stop" : "play", 20));
      r.solo.title = soloing ? "stop: back to the mix" : "play this lane alone";
      r.out.title = l.out ? "put this lane back in the mix" : "take this lane out of the mix";
      r.out.classList.toggle("on", l.out);
      r.mute.replaceChildren(glyph(l.muted ? "speakermute" : "speaker", 20));
      r.mute.title = l.muted ? "unmute (only here, never sent)" : "mute (only here, never sent)";
      r.mute.classList.toggle("on", l.muted);
    }
    playBtn.replaceChildren(glyph(engine.playing ? "pause" : "play", 24));
    playBtn.classList.toggle("on", engine.playing);
    playBtn.title = engine.playing ? "pause" : "play";
    root.classList.toggle("playing", engine.playing);
    place(engine.playing ? engine.position : P.position);
  };

  /* The playhead, its time, the overview's fill: the only things that change each frame. */
  let geo = null;
  const measure = () => {
    const c = ruler.querySelector(".np-rcell").getBoundingClientRect(), b = lanes.getBoundingClientRect();
    geo = c.width ? { x0: c.left - b.left, w: c.width } : null;
  };
  const place = (s) => {
    const at = scrubAt != null ? scrubAt : s, d = P.duration || 0;
    const f = d > 0 ? Math.max(0, Math.min(1, at / d)) : 0;
    if (!geo) measure();
    if (geo) head.style.transform = `translateX(${(geo.x0 + f * geo.w).toFixed(1)}px)`;
    fill.style.width = `${(f * 100).toFixed(2)}%`;
    rtime.textContent = clock(at);
    time.textContent = `${clock(at)} / ${clock(d)}`;
  };

  const draw = (cv, peaks, a = 0, b = 1) => {
    const r = cv.getBoundingClientRect(), dpr = Math.min(3, devicePixelRatio || 1);
    if (!r.width) return;
    cv.width = Math.round(r.width * dpr); cv.height = Math.round(r.height * dpr);
    const g = cv.getContext("2d"), W = cv.width, H = cv.height;
    g.clearRect(0, 0, W, H);
    g.fillStyle = WAVE;
    if (!peaks || !peaks.length) { g.fillRect(a * W, H / 2 - dpr / 2, (b - a) * W, dpr); return; }
    const x0 = a * W, w = (b - a) * W, n = peaks.length;
    for (let x = 0; x < w; x++) {
      const v = peaks[Math.min(n - 1, Math.floor((x / w) * n))];
      const h = Math.max(dpr, Math.pow(v, 0.55) * H);
      g.fillRect(x0 + x, (H - h) / 2, 1, h);
    }
  };
  const peaksOf = (l) => {
    if (!l.peaks) return null;
    try { const s = atob(l.peaks); return Array.from(s, (ch) => ch.charCodeAt(0) / 255); } catch (_) { return null; }
  };
  const spanOf = (l) => {
    const t = l.time, d = P.duration;
    if (!t || !(d > 0)) return [0, 1];
    const a = Math.max(0, Math.min(1, t.start / d));
    return [a, Math.max(a, Math.min(1, (t.start + t.len) / d))];
  };
  const drawAll = () => {
    measure();
    const sum = [];
    for (const l of P.lanes) {
      const r = rowOf.get(l.id), pk = peaksOf(l);
      if (r) draw(r.strip.querySelector("canvas"), pk, ...spanOf(l));
      if (pk && !l.time) pk.forEach((v, i) => { sum[i] = Math.max(sum[i] || 0, v); });
    }
    draw(ocv, sum.length ? sum : null);
    drawTicks();
    place(engine.playing ? engine.position : P.position);
  };
  const drawTicks = () => {
    const r = tcv.getBoundingClientRect(), dpr = Math.min(3, devicePixelRatio || 1), d = P.duration || 0;
    if (!r.width || !(d > 0)) return;
    tcv.width = Math.round(r.width * dpr); tcv.height = Math.round(r.height * dpr);
    const g = tcv.getContext("2d"), W = tcv.width, H = tcv.height;
    const step = [1, 2, 5, 10, 15, 30, 60, 120, 300].find((s) => (s / d) * r.width >= 48) || 600;
    g.fillStyle = "#8a8a8a";
    g.font = `${10 * dpr}px system-ui, sans-serif`;
    g.textBaseline = "top";
    for (let s = 0; s <= d; s += step) {
      const x = Math.round((s / d) * W);
      g.fillRect(x, H * 0.55, dpr, H * 0.45);
      const label = s >= 60 ? `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}` : `${s}s`;
      if (x + 30 * dpr < W) g.fillText(label, x + 3 * dpr, 2 * dpr);
    }
  };
  const ro = new ResizeObserver(() => requestAnimationFrame(drawAll));
  ro.observe(lanes);

  /* Every change goes through here; the sound follows the program. */
  function dispatch(a) {
    if (engine.playing && a.type !== "pause") P = { ...P, position: engine.position };
    P = reduce(P, a);
    paintState();
    sync();
  }
  const sync = () => {
    const prog = program(P);
    if (prog.key === engine.key) return;
    if (!prog.url && engine.playing) { engine.pause(); P = { ...P, playing: false }; paintState(); }
    if (engine.key || P.playing) engine.load(prog, engine.playing ? engine.position : P.position)
      .then(() => paintState());
  };

  async function start(at = null) {
    if (at != null) P = { ...P, position: at };
    const prog = program(P);
    if (!prog.url) { ops.toast("every lane is out or muted — nothing to play"); return; }
    claiming = true;
    try { ops.claim(); } finally { claiming = false; }
    current = api;
    P = { ...P, playing: true };
    paintState();
    await engine.load(prog, P.position);
    if (!P.playing) return;
    await engine.play();
    paintState();
  }
  const stop = () => {
    const at = engine.pause();
    P = reduce(P, { type: "pause", at });
    paintState();
  };

  playBtn.onclick = () => (engine.playing ? stop() : start());

  const soloTap = (id) => {
    if (P.solo === id) { dispatch({ type: "solo", lane: null }); return; }
    const l = lane(id);
    // nothing sounding and at the top: from a second before the lane's own sound (a stem silent until it comes in)
    const from = !engine.playing && P.position < 0.05 ? Math.max(0, firstSound(l, P.duration) - 1) : null;
    dispatch({ type: "solo", lane: id });
    if (!engine.playing) start(from);
  };

  const outTap = async (id) => {
    const l = lane(id);
    if (l.pending) return;
    dispatch({ type: "pending", lane: id, on: true });
    const fresh = await ops.signal(outSignal(P, id, !l.out));
    if (fresh) show(fresh, { n: P.n, item: P.item || null });
    else dispatch({ type: "pending", lane: id, on: false });
  };

  /* Tap seeks, a sideways drag scrubs (heard), a vertical one scrolls the rows. A cancelled drag ends where it
     was and the piece plays on. */
  function seekSurface(node, strip = false) {
    let id = null, x0 = 0, y0 = 0, moved = false, last = null;
    const timeAt = (x) => {
      const r = (strip ? node : node.querySelector("canvas") || node).getBoundingClientRect();
      return Math.max(0, Math.min(1, (x - r.left) / Math.max(1, r.width))) * (P.duration || 0);
    };
    node.addEventListener("pointerdown", (e) => {
      if (e.button) return;
      id = e.pointerId; x0 = e.clientX; y0 = e.clientY; moved = false; last = null;
      if (!strip) { try { node.setPointerCapture(id); } catch (_) {} }
    });
    node.addEventListener("pointermove", (e) => {
      if (e.pointerId !== id) return;
      if (!moved) {
        const dx = Math.abs(e.clientX - x0), dy = Math.abs(e.clientY - y0);
        if (dx < 6 && dy < 6) return;
        if (strip && dy >= dx) { id = null; return; }
        moved = true;
        try { node.setPointerCapture(id); } catch (_) {}
      }
      e.preventDefault();
      last = timeAt(e.clientX);
      scrubAt = last;
      place(last);
      if (engine.playing) engine.seek(last, { final: false });
    });
    const end = (e, cancelled) => {
      if (e.pointerId !== id) return;
      id = null;
      const s = cancelled ? last : timeAt(e.clientX);
      scrubAt = null;
      if (s == null) return;
      seekTo(s);
    };
    node.addEventListener("pointerup", (e) => end(e, false));
    node.addEventListener("pointercancel", (e) => end(e, true));
  }
  const seekTo = (s) => {
    P = reduce(P, { type: "seek", s });
    if (engine.playing) engine.seek(P.position);
    else if (engine.key) engine.seek(P.position);
    place(P.position);
  };
  seekSurface(ruler);
  seekSurface(over);

  /* A fresh card, or another version or item of it: the same player, the sound moved at the position. */
  function show(c, w) {
    card = c;
    const before = P.lanes.map((l) => l.id).join();
    dispatch({ type: "source", src: sourceOf(c, w.n, w.item) });
    if (P.lanes.map((l) => l.id).join() !== before) paintRows();
  }

  const api = {
    el: root,
    show,
    get state() { return P; },
    get engine() { return engine; },
    pause() { if (!claiming && engine.playing) stop(); },
    destroy() { ro.disconnect(); engine.stop(); if (current === api) current = null; },
  };
  paintRows();
  if (resume && resume.from != null) start(resume.from);
  return api;
}
