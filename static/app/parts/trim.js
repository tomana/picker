/* Save trims after movement settles; a full-length selection clears the trim. Decode a fine waveform in the background.
   With a `beat` (s) the start sits on the beat and the length is whole bars of four, so the selection loops. */

import { el, glyph, RECORDING_YELLOW } from "../dom.js";

const MIN = 0.2;
const NUDGE = 0.1;
const FINE_MAX_S = 900;                /* Limit fine decoding to short recordings to bound memory use. */

let _n = 0;

const fmt = (s) => {
  s = Math.max(0, s);
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  return `${m}:${r < 10 ? "0" : ""}${r.toFixed(1)}`;
};

function decodeB64(b64) {
  try {
    const bin = atob(b64 || "");
    return Array.from(bin, (ch) => ch.charCodeAt(0) / 255);
  } catch (_) {
    return [];
  }
}

/* Use one SVG path for mirrored waveform bars rather than one element per bar. */
function pathOf(cols) {
  const n = cols.length;
  let d = "";
  for (let i = 0; i < n; i++) {
    const h = Math.max(0.8, cols[i] * 94);
    d += `M${i},${(50 - h / 2).toFixed(2)}h0.92v${h.toFixed(2)}h-0.92z`;
  }
  return d;
}

export function trimEditor({ src, peaks, duration, trim, onSave = null, onChange = null, beat = 0, actions = [],
                             whole = "the whole recording" }) {
  const id = `trim${++_n}`;
  let dur = duration || 0;
  let a = trim ? trim.start : 0;
  let b = trim ? trim.end : dur;
  const bar = beat > 0 ? beat * 4 : 0;
  const onBeat = (t) => (beat > 0 ? Math.round(t / beat) * beat : t);
  let active = "b";
  let cols = decodeB64(peaks);

  const svgBox = el("div.tsvg");
  const shadeL = el("i.tshade.l"), shadeR = el("i.tshade.r");
  const grip = (k) => el(`i.thandle.${k}`, {}, [el("b.tline"), el("b.tknob")]);
  const hA = grip("a"), hB = grip("b");
  const head = el("i.tplay", { hidden: "" });
  const wave = el("div.twave", {}, [svgBox, shadeL, shadeR, head, hA, hB]);

  const rStart = el("button.tread", { type: "button" });
  const rEnd = el("button.tread", { type: "button" });
  const rLen = el("span.tlen");
  const saved = el("span.tsaved");
  rStart.onclick = () => { active = "a"; paint(); };
  rEnd.onclick = () => { active = "b"; paint(); };

  const play = el("button.tbtn.tplaybtn", { type: "button", title: "hear the selection" });
  const step = bar ? "a beat (the start) or a bar (the end)" : `${NUDGE} s`;
  const left = el("button.tbtn", { type: "button", title: `nudge the active edge back ${step}` }, [glyph("prev", 18)]);
  const right = el("button.tbtn", { type: "button", title: `nudge the active edge on ${step}` }, [glyph("next", 18)]);
  const all = el("button.tbtn.tall", { type: "button", text: "all", title: `select ${whole}` });

  const root = el("div.trim", { style: `--ty:${RECORDING_YELLOW}` }, [
    wave,
    el("div.treads", {}, [rStart, el("span.tarrow", { text: "→" }), rEnd, rLen, saved]),
    el("div.tbar", {}, [play, left, right, all, ...actions]),
  ]);

  const draw = () => {
    const n = Math.max(1, cols.length);
    const d = pathOf(cols.length ? cols : [0]);
    svgBox.innerHTML =
      `<svg viewBox="0 0 ${n} 100" preserveAspectRatio="none" width="100%" height="100%">` +
      `<defs><clipPath id="${id}"><rect class="tsel" y="0" height="100"/></clipPath></defs>` +
      `<path class="tdim" d="${d}"/><path class="tlit" d="${d}" clip-path="url(#${id})"/></svg>`;
    paint();
  };

  const paint = () => {
    const pa = dur ? (a / dur) * 100 : 0, pb = dur ? (b / dur) * 100 : 100;
    shadeL.style.width = `${pa}%`;
    shadeR.style.left = `${pb}%`;
    hA.style.left = `${pa}%`;
    hB.style.left = `${pb}%`;
    hA.classList.toggle("on", active === "a");
    hB.classList.toggle("on", active === "b");
    rStart.classList.toggle("on", active === "a");
    rEnd.classList.toggle("on", active === "b");
    const rect = svgBox.querySelector(".tsel");
    if (rect) {
      const n = Math.max(1, cols.length);
      rect.setAttribute("x", String((pa / 100) * n));
      rect.setAttribute("width", String(((pb - pa) / 100) * n));
    }
    rStart.textContent = fmt(a);
    rEnd.textContent = fmt(b);
    const bars = bar ? Math.round((b - a) / bar) : 0;
    rLen.textContent = `${(b - a).toFixed(1)} s${bars ? ` · ${bars} bar${bars > 1 ? "s" : ""}` : ""}${isAll() ? " · all" : ""}`;
    if (onChange) onChange({ start: a, end: b });
  };
  const isAll = () => a <= 0.01 && b >= dur - 0.01;

  let saveT = 0;
  const save = () => {
    if (!onSave) return;
    clearTimeout(saveT);
    saved.textContent = "";
    saveT = setTimeout(async () => {
      try {
        await onSave(isAll() ? null : { start: +a.toFixed(3), end: +b.toFixed(3) });
        saved.textContent = "saved";
      } catch (e) {
        saved.textContent = `not saved: ${e.message}`;
      }
    }, 500);
  };

  /* On a beat, an edge moves by whole bars against the other one, which stays. */
  const setA = (t) => {
    if (!bar) { a = Math.max(0, Math.min(t, b - MIN)); return; }
    let k = Math.max(1, Math.round((b - t) / bar));
    while (k > 1 && b - k * bar < -1e-6) k--;
    a = Math.max(0, b - k * bar);
  };
  const setB = (t) => {
    if (!bar) { b = Math.min(dur, Math.max(t, a + MIN)); return; }
    let k = Math.max(1, Math.round((t - a) / bar));
    while (k > 1 && a + k * bar > dur + 1e-6) k--;
    b = Math.min(dur, a + k * bar);
  };
  const slideTo = (t, len) => {
    const top = bar ? Math.floor((dur - len) / beat + 1e-6) * beat : dur - len;
    a = Math.max(0, Math.min(top, onBeat(t)));
    b = a + len;
  };
  if (bar && dur) { a = Math.max(0, onBeat(a)); setB(b); }

  const timeAt = (x) => {
    const r = wave.getBoundingClientRect();
    return Math.max(0, Math.min(dur, ((x - r.left) / r.width) * dur));
  };
  let drag = null;
  wave.addEventListener("pointerdown", (e) => {
    if (!dur) return;
    const t = timeAt(e.clientX);
    const r = wave.getBoundingClientRect();
    const px = (s) => r.left + (s / dur) * r.width;
    /* Prefer a nearby handle; otherwise distinguish selection sliding from tap-to-play. */
    const da = Math.abs(e.clientX - px(a)), db = Math.abs(e.clientX - px(b));
    let what = null;
    if (Math.min(da, db) <= 22) what = da < db || (da === db && t < a) ? "a" : "b";
    else if (t > a && t < b) what = "slide";
    drag = { what, x0: e.clientX, t0: t, a0: a, b0: b, moved: false };
    if (what === "a" || what === "b") active = what;
    wave.setPointerCapture(e.pointerId);
    paint();
    e.preventDefault();
  });
  wave.addEventListener("pointermove", (e) => {
    if (!drag) return;
    if (Math.abs(e.clientX - drag.x0) > 4) drag.moved = true;
    if (!drag.moved) return;
    const t = timeAt(e.clientX);
    if (drag.what === "a") setA(t);
    else if (drag.what === "b") setB(t);
    else if (drag.what === "slide") {
      slideTo(drag.a0 + (t - drag.t0), drag.b0 - drag.a0);
    }
    paint();
  });
  const end = (e) => {
    if (!drag) return;
    const d0 = drag;
    drag = null;
    if (d0.moved) { save(); if (playing) stopIfOutside(); return; }
    /* A stationary press plays from that point to the selection end. */
    const t = timeAt(e.clientX);
    startAt(t >= a && t < b - 0.05 ? t : a);
  };
  wave.addEventListener("pointerup", end);
  wave.addEventListener("pointercancel", () => { drag = null; });

  const nudge = (s) => {
    if (bar && active === "a") slideTo(a + s * beat, b - a);   /* the start a beat: the bars go with it */
    else if (bar) setB(b + s * bar);
    else if (active === "a") setA(a + s * NUDGE); else setB(b + s * NUDGE);
    paint(); save();
  };
  left.onclick = () => nudge(-1);
  right.onclick = () => nudge(+1);
  all.onclick = () => { a = 0; b = dur; if (bar) setB(dur); paint(); save(); };

  const audio = new Audio();
  audio.preload = "auto";
  audio.src = src;
  let playing = false, raf = 0;
  const paintPlay = () => {
    play.replaceChildren(glyph(playing ? "stop" : "play", 14), playing ? "stop" : "play part");
    head.hidden = !playing;
  };
  const stop = () => {
    playing = false;
    cancelAnimationFrame(raf);
    audio.pause();
    paintPlay();
  };
  const stopIfOutside = () => {
    if (audio.currentTime < a || audio.currentTime >= b) stop();
  };
  const tick = () => {
    if (!root.isConnected) { stop(); return; }      /* Ignore fine-waveform results after the card closes. */
    const t = audio.currentTime;
    if (t >= b || audio.ended) { stop(); return; }
    head.style.left = `${dur ? (t / dur) * 100 : 0}%`;
    raf = requestAnimationFrame(tick);
  };
  const startAt = (t) => {
    audio.currentTime = t;
    const p = audio.play();
    if (p && p.catch) p.catch(() => stop());
    playing = true;
    paintPlay();
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(tick);
  };
  play.onclick = () => (playing ? stop() : startAt(a));
  audio.addEventListener("loadedmetadata", () => {
    if (!dur && isFinite(audio.duration)) { dur = audio.duration; if (!trim) b = dur; if (bar) setB(b); paint(); }
  });

  if (dur && dur < FINE_MAX_S && window.AudioContext) {
    fetch(src).then((r) => r.arrayBuffer()).then((buf) => {
      const ctx = new AudioContext();
      return ctx.decodeAudioData(buf).finally(() => ctx.close());
    }).then((ab) => {
      const ch = ab.getChannelData(0);
      const n = Math.min(800, Math.max(400, Math.round(dur * 40)));
      const step = Math.max(1, Math.floor(ch.length / n));
      const out = new Array(n);
      let peak = 0;
      for (let i = 0; i < n; i++) {
        let m = 0;
        for (let j = i * step, e = Math.min(ch.length, j + step); j < e; j++) {
          const v = Math.abs(ch[j]);
          if (v > m) m = v;
        }
        out[i] = m; if (m > peak) peak = m;
      }
      if (peak > 0) { cols = out.map((v) => v / peak); draw(); }
    }).catch(() => {});                              /* Keep the coarse waveform when fine decoding fails. */
  }

  paintPlay();
  draw();
  return root;
}
