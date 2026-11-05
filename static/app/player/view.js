/* The open card's player for a version with lanes: a ruler, a row per lane, one playhead, ▶ in the lanes' corner. It owns
   one state (state.js) and one engine (engine.js); rows are drawn once and changed in place. The page hands it
   `ops`: signal(body) → the fresh card (the take-out's answer), claim() (stop the page's other players), toast,
   bar() → the page's own buttons beside ▶, code(lane), clip(id, button), tag(id), changed(). */

import { el, glyph, playGlyphs } from "../dom.js";
import { clock, firstSound } from "../parts/voice.js";
import { sourceOf, initial, reduce, program, outSignal } from "./state.js";
import { createEngine } from "./engine.js";

const WAVE = "#88a3bf";
let current = null;                     // the player that may be sounding; the page's stop pauses it
const kept = new Map();                 // card id → its mutes and where ⏸ left it, for this page's life

/* The page's stopAudio calls this: something else is about to play. */
export function pausePlayer() { if (current) current.pause(); }

/* The lanes with their own files that a version (or item) plays. */
export function lanesOf(card, n, item = null) { return sourceOf(card, n, item).lanes; }

export function createPlayer(card, where, ops, { resume = null } = {}) {
  const memo = kept.get(card.id) || { muted: [] };
  kept.set(card.id, memo);
  const left = memo.left && memo.left.n === where.n && memo.left.item === where.item ? memo.left.s : 0;
  let P = initial(sourceOf(card, where.n, where.item), { muted: memo.muted, position: left });
  let scrubAt = null, claiming = false;
  const engine = createEngine({
    onTick: (s) => place(s),
    onEnded: () => { dispatch({ type: "ended" }); },
    onError: (m) => { ops.toast(`the player: ${m}`); },
  });

  const root = el("div.vwrap.np", { "data-np": "" });
  const lanes = el("div.np-lanes");
  const ruler = el("div.np-ruler", { title: "tap or drag: move the playhead" });
  const tcv = el("canvas.np-ticks");
  const rtime = el("span.np-t");
  const rtotal = el("span.np-d");
  const rtext = document.createTextNode("");
  rtime.append(rtext);
  ruler.append(el("i.np-r0"), el("div.np-rcell", {}, [tcv]), el("span.np-tt", {}, [rtime, rtotal]));
  // the ruler scrolls with the rows (sticky), so a scrollbar narrows both alike; the head is over both
  const rows = el("div.np-rows");
  const head = el("i.np-head");
  lanes.append(rows, head);
  const playBtn = el("div.vplay.np-play", { title: "play", "aria-label": "play" }, playGlyphs(22));
  root.append(lanes, playBtn, ...(ops.bar ? ops.bar() : []));

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
      const row = el("div.np-row", { "data-lane": l.id }, [solo, strip, out, mute]);
      seekSurface(row, { strip, hold: (down) => laneMenu(l, strip, down) });
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
  let wasX = null, wasT = null, wasD = null;   // a frame writes only what changed: nothing else may compete with the sound
  const place = (s) => {
    const at = scrubAt != null ? scrubAt : s, d = P.duration || 0;
    const f = d > 0 ? Math.max(0, Math.min(1, at / d)) : 0;
    if (!geo) measure();
    const x = geo ? (geo.x0 + f * geo.w).toFixed(1) : null;
    if (x !== null && x !== wasX) { head.style.transform = `translateX(${x}px)`; wasX = x; }
    const t = clock(at);
    if (t !== wasT) { rtext.nodeValue = t; wasT = t; }
    if (d !== wasD) { rtotal.textContent = ` / ${Math.floor(d / 60)}:${String(Math.round(d % 60)).padStart(2, "0")}`; wasD = d; }
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
    for (const l of P.lanes) {
      const r = rowOf.get(l.id);
      if (r) draw(r.strip.querySelector("canvas"), peaksOf(l), ...spanOf(l));
    }
    drawTicks();
    place(engine.playing ? engine.position : P.position);
  };
  const drawTicks = () => {
    const r = tcv.getBoundingClientRect(), dpr = Math.min(3, devicePixelRatio || 1), d = P.duration || 0;
    if (!r.width || !(d > 0)) return;
    tcv.width = Math.round(r.width * dpr); tcv.height = Math.round(r.height * dpr);
    const g = tcv.getContext("2d"), W = tcv.width, H = tcv.height;
    const step = [1, 2, 5, 10, 15, 30, 60, 120, 300].find((s) => (s / d) * r.width >= 44) || 600;
    g.fillStyle = "#8a8a8a";
    g.font = `${9 * dpr}px system-ui, sans-serif`;
    g.textBaseline = "middle";
    for (let s = 0; s <= d; s += step) {
      const x = Math.round((s / d) * W);
      g.fillRect(x, H * 0.3, dpr, H * 0.7);
      const label = s >= 60 ? `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}` : `${s}s`;
      if (x + 30 * dpr < W) g.fillText(label, x + 3 * dpr, H / 2);
    }
  };
  const ro = new ResizeObserver(() => requestAnimationFrame(drawAll));
  ro.observe(lanes);

  /* Every change goes through here; the sound follows the program. */
  function dispatch(a) {
    if (engine.playing && a.type !== "pause") P = { ...P, position: engine.position };
    P = reduce(P, a);
    memo.muted = P.muted;
    paintState();
    sync();
    if (ops.changed) ops.changed();
  }
  const sync = () => {
    const prog = program(P);
    if (prog.key === engine.key) return;
    if (!prog.url && engine.playing) { engine.pause(); P = { ...P, playing: false }; paintState(); }
    if (engine.key || P.playing) engine.load(prog, engine.playing ? engine.position : P.position)
      .then(() => paintState());
  };

  /* The sound is readied first; whatever else plays goes on until this can start. */
  async function start(at = null, { handover = false } = {}) {
    if (at != null) P = { ...P, position: at };
    const prog = program(P);
    if (!prog.url) { ops.toast("every lane is out or muted — nothing to play"); return; }
    const t0 = performance.now();
    current = api;
    P = { ...P, playing: true };
    paintState();
    await engine.load(prog, P.position);
    if (!P.playing) return;
    claiming = true;
    try { ops.claim(); } finally { claiming = false; }
    const want = P.position + (handover ? (performance.now() - t0) / 1000 : 0);
    if (Math.abs(engine.position - want) > 0.05) await engine.seek(want);
    await engine.play();
    paintState();
  }
  const stop = () => {
    const at = engine.pause();
    P = reduce(P, { type: "pause", at });
    paintState();
    return at;
  };

  playBtn.onclick = () => {
    if (!engine.playing) { start(); return; }
    memo.left = { n: P.n, item: P.item, s: stop() };
  };

  const soloTap = (id) => {
    if (P.solo === id) {
      const was = engine.playing;
      dispatch({ type: "solo", lane: null });
      if (was) stop();
      return;
    }
    const l = lane(id);
    // nothing sounding and at the top: from a second before the lane's own sound (a stem silent until it comes in)
    const from = !engine.playing && P.position < 0.05
      ? Math.max(0, ((l.time || {}).start || 0) + firstSound(l, P.duration) - 1) : null;
    dispatch({ type: "solo", lane: id });
    if (!engine.playing) start(from);
  };

  /* A long press, or a right click: what a row has no room for. It stays until a press elsewhere or the rows scroll;
     the page behind may repaint and scroll under it. */
  let menu = null;
  const closeMenu = () => {
    if (!menu) return;
    menu.remove();
    menu = null;
    removeEventListener("pointerdown", outsideMenu, true);
    rows.removeEventListener("scroll", closeMenu);
  };
  const outsideMenu = (e) => { if (menu && !menu.contains(e.target)) closeMenu(); };
  const laneMenu = (l, strip, down) => {
    closeMenu();
    const item = (act, text, icon, fn) => {
      const b = el("button.np-mi", { type: "button", "data-act": act }, [glyph(icon, 16), el("span", { text })]);
      b.onclick = (e) => { e.stopPropagation(); fn(b); closeMenu(); };
      return b;
    };
    menu = el("div.np-menu", {}, [
      item("out", lane(l.id).out ? "put it back in the mix" : "take it out of the mix", "trash", () => outTap(l.id)),
      item("clip", "add to the timeline", "tlplus", (b) => ops.clip(l.id, b)),
      item("tag", `put lane:${l.id} in the comment`, "comment", () => ops.tag(l.id)),
      ...(l.src ? [item("code", "open its source", "code", () => ops.code(l))] : []),
    ]);
    root.append(menu);
    // it opens under the finger that asked for it: that finger's lift must press nothing
    if (down) {
      const opened = menu;
      opened.style.pointerEvents = "none";
      const lifted = () => {
        removeEventListener("pointerup", lifted, true);
        removeEventListener("pointercancel", lifted, true);
        setTimeout(() => { opened.style.pointerEvents = ""; }, 60);
      };
      addEventListener("pointerup", lifted, true);
      addEventListener("pointercancel", lifted, true);
    }
    const r = strip.getBoundingClientRect(), b = root.getBoundingClientRect();
    menu.style.left = `${Math.round(Math.max(0, Math.min(r.left - b.left, b.width - menu.offsetWidth)))}px`;
    menu.style.top = `${Math.round(Math.max(0, Math.min(r.top - b.top, b.height - menu.offsetHeight)))}px`;
    addEventListener("pointerdown", outsideMenu, true);
    rows.addEventListener("scroll", closeMenu, { passive: true });
  };

  const outTap = async (id) => {
    const l = lane(id);
    if (l.pending) return;
    dispatch({ type: "pending", lane: id, on: true });
    const fresh = await ops.signal(outSignal(P, id, !l.out));
    if (fresh) show(fresh, { n: P.n, item: P.item || null });
    else dispatch({ type: "pending", lane: id, on: false });
  };

  /* Tap seeks. A sideways drag moves the head in silence and the sound comes back where it lands; a vertical one
     scrolls the rows; a long press opens the lane's menu. A drag may start on a row's button: the head then moves by
     as much as the finger, from where it was, and the button isn't pressed. A cancelled drag lands where it was and
     the piece plays on. `strip` is what a row's times are measured on. */
  function seekSurface(node, { strip = null, hold = null } = {}) {
    let id = null, x0 = 0, y0 = 0, moved = false, last = null, held = false, timer = 0, from = null, swallow = false;
    const timeAt = (x) => {
      const r = (strip || node.querySelector("canvas") || node).getBoundingClientRect(), d = P.duration || 0;
      const f = from != null ? from / Math.max(1e-3, d) + (x - x0) / Math.max(1, r.width)
                             : (x - r.left) / Math.max(1, r.width);
      return Math.max(0, Math.min(1, f)) * d;
    };
    node.addEventListener("pointerdown", (e) => {
      held = false;
      swallow = false;
      if (e.button) return;
      id = e.pointerId; x0 = e.clientX; y0 = e.clientY; moved = false; last = null;
      const onButton = !!(e.target.closest && e.target.closest("button"));
      from = onButton ? (engine.playing ? engine.position : P.position) : null;
      if (hold && !onButton) timer = setTimeout(() => { held = true; hold(true); }, 500);
      if (!strip) { try { node.setPointerCapture(id); } catch (_) {} }
    });
    node.addEventListener("pointermove", (e) => {
      if (e.pointerId !== id || held) return;
      if (!moved) {
        const dx = Math.abs(e.clientX - x0), dy = Math.abs(e.clientY - y0);
        if (dx < 6 && dy < 6) return;
        clearTimeout(timer);
        if (strip && e.pointerType === "touch" && dy >= dx) { id = null; return; }   // the rows scroll
        moved = true;
        try { node.setPointerCapture(id); } catch (_) {}
        engine.hush();
      }
      e.preventDefault();
      last = timeAt(e.clientX);
      scrubAt = last;
      place(last);
    });
    const end = (e, cancelled) => {
      clearTimeout(timer);
      if (e.pointerId !== id) return;
      id = null;
      scrubAt = null;
      const wasHeld = held;
      held = false;
      if (wasHeld || (!moved && from != null)) return;       // a menu, or a tap on a button: its own
      const s = cancelled ? last : timeAt(e.clientX);
      swallow = moved;
      if (moved) setTimeout(() => { swallow = false; }, 50);  // a touch drag ends in no click: don't eat a later one
      if (s != null) seekTo(s);
    };
    node.addEventListener("pointerup", (e) => end(e, false));
    node.addEventListener("pointercancel", (e) => end(e, true));
    node.addEventListener("click", (e) => {                  // the click a drag ends in presses nothing
      if (!swallow) return;
      swallow = false;
      e.stopPropagation();
      e.preventDefault();
    }, true);
    // a right click, or a phone's own long press, which may come before or after the timer
    if (hold) node.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      clearTimeout(timer);
      if (held) return;
      const down = id != null;
      if (down) held = true;
      hold(down);
    });
  }
  const seekTo = (s) => {
    P = reduce(P, { type: "seek", s });
    if (engine.key) engine.seek(P.position);
    place(P.position);
  };
  seekSurface(ruler);

  /* A fresh card, or another version or item of it: the same player, the sound moved at the position. */
  function show(c, w) {
    const drawn = () => P.lanes.map((l) => `${l.id}:${l.peaks}`).join();
    const before = drawn();
    dispatch({ type: "source", src: sourceOf(c, w.n, w.item) });
    if (drawn() !== before) paintRows();
  }

  // the tab under the votes (the page's) drags and mirrors the head as fractions of the piece
  root.scrub = {
    start() { engine.hush(); },
    move(f) { scrubAt = f * (P.duration || 0); place(scrubAt); },
    end(f) { scrubAt = null; seekTo(f * (P.duration || 0)); },
  };
  root.at = () => {
    const d = P.duration || 0, s = scrubAt != null ? scrubAt : engine.playing ? engine.position : P.position;
    return d > 0 ? Math.max(0, Math.min(1, s / d)) : null;
  };

  const api = {
    el: root,
    show,
    get state() { return P; },
    get engine() { return engine; },
    pause() { if (!claiming && engine.playing) stop(); },
    destroy() { closeMenu(); ro.disconnect(); engine.stop(); if (current === api) current = null; },
  };
  paintRows();
  if (resume && resume.from != null) start(resume.from, { handover: true });
  return api;
}
