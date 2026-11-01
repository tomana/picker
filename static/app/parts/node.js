/* Timed node parts use version-relative placement; unknown blend modes must still render. */

import { el, glyph } from "../dom.js";

export const NODE_ROWS = 8;

/* Unknown blend modes use neutral tint rather than failing. */

const BLEND = {
  over:       "#63717d",
  alpha_over: "#63717d",
  normal:     "#63717d",
  add:        "#7a6e54",
  screen:     "#677568",
  multiply:   "#675d68",
};
const NEUTRAL = "#5b5b5b";

function mmss(sec) {
  if (!isFinite(sec) || sec <= 0) return "";
  const m = Math.floor(sec / 60), s = Math.round(sec % 60);
  return `${m}:${String(s === 60 ? 59 : s).padStart(2, "0")}`;
}

function span(p, duration) {
  const t = p.time;
  if (!t || !duration || !(duration > 0)) return { a: 0, b: 1, len: null };
  const a = Math.max(0, Math.min(1, t.start / duration));
  const b = Math.max(a, Math.min(1, (t.start + t.len) / duration));
  return { a, b, len: t.len };
}

function nodeLane(p, duration) {
  const { a, b, len } = span(p, duration);
  const t = p.time || {};
  const off = p.enabled === false || p.archived;
  const l = el("div.lane" + (off ? ".off" : ""));
  const clip = el("i.sclip.nclip");
  clip.style.left = `${(a * 100).toFixed(2)}%`;
  clip.style.width = `${Math.max(2, (b - a) * 100).toFixed(2)}%`;
  const tint = BLEND[t.blend] || NEUTRAL;
  clip.style.outlineColor = tint;
  /* Keep zero-opacity layers faintly visible so an existing layer is not mistaken for an absent one. */

  const o = typeof t.opacity === "number" ? Math.max(0.18, t.opacity) : 1;
  clip.style.background = tint;
  clip.style.opacity = String(off ? o * 0.45 : o);
  l.append(clip);
  l.append(el("div.sname", { text: p.label || p.id }));

  const right = t.blend || mmss(len != null ? len : duration);
  if (right) l.append(el("div.stime", { text: right }));
  return l;
}

/* Node controls report actions to the caller; no audio-only operations or API state live here. */

function nodeRow(p, duration, on) {
  const btn = (text, title, cls = "", act = null, disabled = false) => {
    const b = el("button.vc" + cls, { type: "button", title });
    if (typeof text === "string") b.textContent = text; else b.append(text);
    if (disabled) { b.disabled = true; b.title = title + " — nothing to show"; }
    else if (act && on) b.onclick = (e) => { e.stopPropagation(); on(act, p, b); };
    return b;
  };
  const np = p.params ? Object.keys(p.params).length : 0;
  const row = el("div.vrowc.nrowc" + (p.archived ? ".cut" : ""), {}, [
    el("div.vcl", {}, [btn(glyph("sliders", 14), `${np} parameters`, "", "params", !np),
                       btn(glyph("tlplus", 15), "add this layer to the arrangement", "", "clip")]),
    nodeLane(p, duration),
    el("div.vcr", {}, [
      btn(glyph("trash", 14), p.archived ? "put this layer back" : "take this layer out",
          p.archived ? ".on" : "", "cut"),
    ]),
  ]);
  return row;
}

/* Overlay parameters rather than inserting a lane; sort by name for stable comparison. */

export function paramPanel(p) {
  const rows = Object.entries(p.params || {}).sort((a, b) => a[0] < b[0] ? -1 : 1);
  const panel = el("div.nparams", {}, [
    el("div.nphead", { text: `${p.label || p.id} — ${rows.length} parameters` }),
    ...(rows.length
      ? rows.map(([k, v]) => el("div.npar", {}, [
          el("span.npk", { text: k }),
          el("span.npv", { text: typeof v === "number" ? String(+v.toFixed(4)) : String(v) }),
        ]))
      : [el("div.npar", {}, [el("span.npk", { text: "none recorded" })])]),
  ]);
  panel.onclick = () => panel.remove();
  return panel;
}

export function nodeBlock(parts, { max = NODE_ROWS, at = null, duration = null,
                                   controls = false, on = null } = {}) {
  const list = parts.slice(0, max);
  const b = el("div.vblock.nblock");
  b.style.setProperty("--rows", String(NODE_ROWS));
  b.style.setProperty("--vn", String(list.length));
  for (const p of list)
    b.append(controls ? nodeRow(p, duration, on) : nodeLane(p, duration));
  if (at != null) {
    const line = el("i.vline");
    line.style.left = `${(at * 100).toFixed(1)}%`;
    b.append(line);
  }
  return b;
}
