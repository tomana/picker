/* The A/B audio is one file; the picture and playhead must use its shared time axis. */

import { el, thumb, playGlyphs } from "../dom.js";

const fmt = (x) => (typeof x === "number" ? String(+x.toPrecision(4)) : String(x));

/* A/B duration includes the reference and gap before the generated version. */
export function abLength(ver) {
  return (+ver.ab_at || 0) + (+ver.duration || 0);
}

/* Use transport-owned segment state so all views agree on which half is playing. */

export function abBlock(c, ver, { controls = false, seg = null, stop = null, playing = null } = {}) {
  const m = ver.media || {};
  /* A reference without a generated version occupies the full width and plays alone. */

  const only = !m.ab;
  const len = only ? (+ver.duration || 0) : abLength(ver);
  const at = only ? len : +ver.ab_at || 0;
  const bAt = only ? 100 : len > 0 ? Math.min(99, Math.max(1, (100 * at) / len)) : 50;
  const block = el("div.vblock.abblock", { "data-dur": len ? len.toFixed(3) : null });
  const key = `${c.id}|${ver.id}`;              /* Use the same version key for segment state across every card view. */

  const side = (letter, from, to, play0, play1, what) => {
    const share = (to - from) / 100;
    const img = el("img", { src: thumb(m.still, controls ? 1280 : 360), alt: "", loading: "lazy", draggable: "false",
                            style: `width:${(100 / share).toFixed(3)}%;left:${(-from / share).toFixed(3)}%` });
    const b = el("button.abplay.no-swipe", { type: "button", title: `${letter}: ${what}`, "aria-label": `play ${letter}`,
                                             "data-ab": key, "data-seg": letter }, playGlyphs(controls ? 22 : 15));
    /* Read segment state from the transport so reopen and reload preserve the playing mark. */

    if (playing && playing() === letter) b.classList.add("on");
    b.onclick = (e) => {
      e.stopPropagation();
      if (!seg) return;
      if (playing ? playing() === letter : b.classList.contains("on")) { if (stop) stop(); return; }
      const mine = () => document.querySelectorAll(`.abplay[data-ab="${CSS.escape(key)}"][data-seg="${letter}"]`);
      seg(play0, play1, () => mine().forEach((x) => x.classList.remove("on")), letter);
      mine().forEach((x) => x.classList.add("on"));   /* Mark playback after starting it; starting clears all previous playback marks. */
    };
    /* Reference-only tiles use the shared player row rather than duplicate play controls. */

    if (only && !controls)
      return el("div.abside", { style: "flex-grow:100" }, [el("div.abslice", {}, [img, el("span.abtag", { text: letter })])]);
    return el("div.abside", { style: `flex-grow:${(to - from).toFixed(3)}` }, [
      el("div.abslice", {}, [img]), el("div.abfoot", {}, [b, el("span.abtag", { text: letter })])]);
  };
  const a = side("A", 0, bAt, 0, only ? null : Math.max(0, at - 0.05), only ? "the sample" : "the reference");
  const sc = ver.score;
  if (sc && sc.value != null)
    a.firstChild.append(el("span.abscore", { text: fmt(sc.value),
      title: `${sc.name || "score"} ${fmt(sc.value)} (${sc.lower_is_better === false ? "higher" : "lower"} is better)` }));

  if (only) a.firstChild.append(el("span.abnone", { text: "no SC voice yet" }));
  block.append(el("div.abrow", {}, only ? [a] : [a, side("B", bAt, 100, at, null, "this version")]));
  /* The whole-file control belongs to the page transport so pause and scroll playback share state. */

  if (!controls) block.append(el("div.aball"));
  /* Map the playhead into each slice rectangle; block padding and borders are not audio time. */

  const split = only ? 1 : len > 0 ? at / len : 0.5;
  block.abX = (f) => {
    const [sa, sb] = block.querySelectorAll(".abslice");
    if (!sa || (!sb && !only)) return null;
    const inA = only || f < split;
    const r0 = block.getBoundingClientRect(), r = (inA ? sa : sb).getBoundingClientRect();
    const k = inA ? f / split : (f - split) / (1 - split);
    return r.left - r0.left + Math.max(0, Math.min(1, k)) * r.width;
  };
  return block;
}

/* Render structured score and parameter facts, not a type-specific schema. */

export function abFacts(ver, c) {
  const rows = [];
  const newest = ver === (c.versions || [])[(c.versions || []).length - 1];
  const nd = c.need;
  if (nd && newest && (nd.why || []).length)
    rows.push([nd.value > 0 ? `needs your ear · ${nd.value}` : "heard", nd.why.join("; ")]);
  else if ((ver.doubts || []).length)
    rows.push(["doubts", ver.doubts.join("; ")]);
  const sc = ver.score;
  const ms = Object.entries(ver.measures || {}).filter(([k, x]) => x != null && (!sc || k !== sc.name));
  if (sc && sc.value != null)
    rows.push(["score", `${sc.name || "score"} ${fmt(sc.value)} (${sc.lower_is_better === false ? "higher" : "lower"} `
                        + "is better)" + (ms.length ? " · " + ms.map(([k, x]) => `${k} ${fmt(x)}`).join(" · ") : "")]);
  const ps = Object.entries(ver.params || {});
  if (ps.length) {
    const doc = ver.params_doc || {};
    rows.push(["parameters", el("div.cnarv.abparams", {}, ps.map(([k, x]) => {
      const d = doc[k] || {};
      return el("div.abparam", { title: d.what || "" }, [
        el("span.abpk", { text: k }), el("span.abpv", { text: fmt(x) + (d.unit && !["level", "0–1"].includes(d.unit) ? ` ${d.unit}` : "") }),
        el("span.abpw", { text: d.what || "" })]);
    }))]);
  }
  return rows;
}
