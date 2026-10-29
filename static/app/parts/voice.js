/* Times are seconds relative to version duration; absent timing fills the lane and absent peaks use a stable ID seed. */

import { el, seedOf, voiceColor, glyph } from "../dom.js";

/* Keep lane geometry uniform across cards; overlays must not consume waveform space. */

export const VOICE_ROWS = 8;         /* Keep grid row height independent of how many voices a card contains. */
const LANE_N = 66;                   /* Stretch the SVG with the lane rather than letting its intrinsic size determine lane height. */

const LANE_VB = 40;

/* Share identity-derived colors with the timeline. */

function mmss(sec) {
  if (!isFinite(sec) || sec <= 0) return "";
  const m = Math.floor(sec / 60), s = Math.round(sec % 60);
  return `${m}:${String(s === 60 ? 59 : s).padStart(2, "0")}`;
}

/* Floor time to tenths so scrubbing never displays time ahead of playback. */

export function clock(sec) {
  if (!isFinite(sec) || sec < 0) return "";
  const t = Math.floor(sec * 10) / 10, m = Math.floor(t / 60);
  return `${m}:${(t - m * 60).toFixed(1).padStart(4, "0")}`;
}

/* Keep time labels inside the open card and flip them near the right edge. */

export function stampLine(line, block, at) {
  const dur = +(block && block.dataset && block.dataset.dur);
  if (!(dur > 0) || !block.closest(".sheet.big")) { delete line.dataset.t; return; }
  line.dataset.t = clock(at * dur);
  line.classList.toggle("r", at > 0.8);
}

/* Use one SVG path for all bars; decode supplied peaks rather than fetching audio for grid waveforms. */

function realPeaks(p) {
  if (!p || !p.peaks) return null;
  try {
    const bin = atob(p.peaks);
    const out = new Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i) / 255;
    return out;
  } catch (_) {
    return null;
  }
}

/* Use the same waveform geometry for bundle thumbnails and lanes. */

export function waveSvg(peaks, h = 40, color = "#8a8a8a") {
  return peakBars(1, h, color, realPeaks({ peaks }));
}

function peakBars(seed, h, color = "#5a5a5a", peaks = null) {
  let x = seed * 9301 + 49297;
  const rnd = () => ((x = (x * 9301 + 49297) % 233280) / 233280);
  const n = peaks ? peaks.length : LANE_N;
  /* Use integer coordinates in a finer viewBox to avoid repeated decimal formatting. */

  const S = 100, W = 200, pitch = W / n;
  /* Remove inter-bar gaps when columns become subpixel, avoiding rasterized striping. */

  const bw = Math.round((pitch > 2 ? pitch - 1 : pitch) * S), H = h * S;
  const d = new Array(n);
  for (let i = 0; i < n; i++) {
    /* Use measured peaks when present; a nonlinear lift keeps quiet decay tails visible in short lanes. */

    const a = peaks
      ? Math.max(1, Math.pow(peaks[i], 0.55) * h)
      : Math.max(1, (0.12 + rnd() * 0.88)
                    * Math.sin((i / (n - 1)) * Math.PI) ** 0.55 * h);
    /* Round the top from the unrounded height so envelope placement stays symmetric. */
    d[i] = `M${Math.round(i * pitch * S)} ${Math.round((h - a) / 2 * S)}h${bw}v${Math.round(a * S)}h-${bw}z`;
  }
  return `<svg viewBox="0 0 ${W * S} ${H}" preserveAspectRatio="none" width="100%" ` +
         `height="100%" style="display:block"><path d="${d.join("")}" fill="${color}"/></svg>`;
}

/* Cache immutable waveform SVGs by peaks or seed, height and color; clone for each lane. */

const laneSvgs = new Map();
function laneSvg(p, h, color) {
  const key = `${h}|${color}|${p.peaks || "seed" + seedOf(p.id)}`;
  const svg = laneSvgs.get(key);
  if (svg) {
    laneSvgs.delete(key);                              /* Move recently used entries to the end for bounded cache eviction. */
    laneSvgs.set(key, svg);
    return svg.cloneNode(true);
  }
  /* Clone immutable parsed SVGs rather than reparsing identical paths. */
  const t = document.createElement("template");
  t.innerHTML = peakBars(seedOf(p.id), h, color, realPeaks(p));
  if (laneSvgs.size >= 3000) laneSvgs.delete(laneSvgs.keys().next().value);
  laneSvgs.set(key, t.content.firstChild);
  return t.content.firstChild;
}

/* Missing timing or duration falls back to full width rather than guessed placement. */

function span(p, duration) {
  const t = p.time;
  if (!t || !duration || !(duration > 0)) return { a: 0, b: 1, len: null };
  const a = Math.max(0, Math.min(1, t.start / duration));
  const b = Math.max(a, Math.min(1, (t.start + t.len) / duration));
  return { a, b, len: t.len };
}

/* The waveform already carries audio fades and gain; do not dim it a second time. */

function voiceLane(p, duration, h = LANE_VB, tint = null, trim = null) {
  const { a, b, len } = span(p, duration);
  const off = p.enabled === false || p.archived;
  const l = el("div.lane" + (off ? ".off" : ""));
  const clip = el("i.sclip.sfades");
  const w = Math.max(2, (b - a) * 100);
  clip.style.left = `${(a * 100).toFixed(2)}%`;
  clip.style.width = `${w.toFixed(2)}%`;
  clip.append(laneSvg(p, h, off ? "#4f4f4f" : tint || voiceColor(p.id)));
  /* Cap fades in both pixels and percent so neither short nor long clips lose their visible body. */

  const clipSecs = p.time ? p.time.len : 0;
  const fadeW = (secs) =>
    `min(8px, ${Math.min(45, (secs / clipSecs) * 100).toFixed(1)}%)`;
  if (clipSecs > 0 && p.time.fadeIn > 0) clip.style.setProperty("--fin", fadeW(p.time.fadeIn));
  if (clipSecs > 0 && p.time.fadeOut > 0) clip.style.setProperty("--fout", fadeW(p.time.fadeOut));
  l.append(clip);
  /* Dim outside the recording trim so the tile previews the part a send will use. */

  if (trim) {
    const sa = el("i.ltrim.l"), sb = el("i.ltrim.r");
    sa.style.width = `${(trim.a * 100).toFixed(2)}%`;
    sb.style.left = `${(trim.b * 100).toFixed(2)}%`;
    l.append(sa, sb);
  }
  /* Place labels on the track so they stay readable when the clip occupies only part of the lane. */

  l.append(el("div.sname", { text: p.label || p.id }));
  const t = mmss(len != null ? len : duration);
  if (t) l.append(el("div.stime", { text: t }));
  return l;
}

/* Report control actions to the caller; renderers must not own API state. */

function voiceRow(p, duration, on, state, tint = null, trim = null) {
  const btn = (text, title, cls = "", act = null, disabled = false) => {
    const b = el("button.vc" + cls, { type: "button", title, "aria-label": title });
    if (typeof text === "string") b.textContent = text; else b.append(text);
    if (disabled) { b.disabled = true; b.title = title + " — not built yet"; }
    else if (act && on) b.onclick = (e) => { e.stopPropagation(); on(act, p, b); };
    return b;
  };
  const muted = state.muted.has(p.id);
  const soloed = state.solo === p.id;
  /* Solo plays one voice; mute affects that voice within whole-card playback. */

  return el("div.vrowc" + (p.archived ? ".cut" : "") + (muted ? ".muted" : ""), {}, [
    btn(glyph(soloed ? "stop" : "play", 22), soloed ? "stop" : "play this band alone",
        ".big" + (soloed ? ".on" : ""), "solo"),
    tagName(voiceLane(p, duration, LANE_VB, tint, trim), p, on),
    el("div.vcr", {}, [
      btn(glyph("trash", 14), p.archived ? "put this band back in the mix" : "take this band out of the mix",
          p.archived ? ".on" : "", "cut"),
      btn(glyph("code", 14), "open its source (.scd)", "", p.src ? "src" : null, !p.src),
      btn(glyph("tlplus", 15), "add this band to the timeline", "", "clip"),
      btn(glyph("comment", 14), `put lane:${p.id} in the comment`, "", "tag"),
    ]),
    btn(glyph(muted ? "speakermute" : "speaker", 22), muted ? "unmute this band" : "mute this band",
        ".big.mute" + (muted ? ".on" : ""), "mute"),
  ]);
}

/* Only expanded-card labels tag requests; grid labels must stay transparent to scrubbing. */

function tagName(lane, p, on) {
  const nm = lane.querySelector(".sname");
  if (nm && on) {
    nm.classList.add("tag");
    nm.title = `put lane:${p.id} in the comment`;
    nm.addEventListener("click", (e) => { e.stopPropagation(); on("tag", p, nm); });
  }
  return lane;
}

/* Playhead positions are fractions; null means the card is not playing. */

export function voiceBlock(parts, { max = VOICE_ROWS, at = null, duration = null,
                                    controls = false, on = null, showCut = false,
                                    state = null, tint = null, trim = null } = {}) {
  /* Expanded cards expose every audible band; cut bands stay recoverable and an all-cut tile remains visible. */

  const kept = parts.filter((p) => !p.archived);
  const list = controls ? (showCut ? parts : kept) : (kept.length ? kept : parts).slice(0, max);
  const st = state || { muted: new Set(), solo: null };
  const b = el("div.vblock");
  if (controls && duration > 0) b.dataset.dur = String(duration);   /* Use CSS row properties, not inline tracks, so expanded cards can override the grid layout. */

  b.style.setProperty("--rows", String(VOICE_ROWS));
  b.style.setProperty("--vn", String(list.length));
  for (const p of list)
    b.append(controls ? voiceRow(p, duration, on, st, tint, trim)
                      : voiceLane(p, duration, LANE_VB, tint, trim));
  if (at != null) {
    const line = el("i.vline");
    line.style.left = `${(at * 100).toFixed(1)}%`;
    if (controls && duration > 0) {
      line.dataset.t = clock(at * duration);
      line.classList.toggle("r", at > 0.8);
    }
    b.append(line);
    /* Hide the open-card playhead until attached, then position against lanes rather than surrounding controls. */

    if (controls) { line.style.visibility = "hidden"; placeOnLanes(b, line, at); }
  }
  return b;
}

function placeOnLanes(b, line, at, tries = 0) {
  requestAnimationFrame(() => {
    const lane = b.isConnected && b.querySelector(".lane");
    const r = lane && lane.getBoundingClientRect();
    if (!r || !r.width) {
      if (tries < 30) placeOnLanes(b, line, at, tries + 1); else line.style.visibility = "";
      return;
    }
    line.style.left = `${(r.left - b.getBoundingClientRect().left + at * r.width).toFixed(1)}px`;
    line.style.visibility = "";
  });
}
