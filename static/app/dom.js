

export function el(spec, attrs = {}, kids = []) {
  const [tag, ...classes] = spec.split(".");
  const n = document.createElement(tag || "div");
  if (classes.length) n.className = classes.join(" ");
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null) continue;
    if (k === "text") n.textContent = v;
    else if (k === "html") n.innerHTML = v;
    else if (k === "style") n.setAttribute("style", v);
    else n.setAttribute(k, v);
  }
  for (const k of [].concat(kids)) if (k) n.append(k);
  return n;
}

/* Clip duplicate text at the usage fill edge; unavailable readings must not look like zero usage. */

export function usageBar(u, left, right) {
  const known = !u.unknown && !u.missing;
  const pct = known ? Math.max(0, Math.min(100, u.pct || 0)) : 0;
  /* Keep a color sliver at zero usage without drawing dark text over it. */

  const sliver = known && pct === 0;
  const line = (dark) => el("div.kline" + (dark ? ".dark" : ""), dark ? { style: `width:${10000 / Math.max(pct, 0.01)}%` } : {},
                            [el("span", { text: left }), el("span", { text: right })]);
  const fill = el("div.kfill", { style: `width:${sliver ? "3px" : `${pct}%`};background:${u.color}` },
                  sliver ? [] : [line(true)]);
  return el("div.kbar" + (u.dim ? ".dim" : "") + (u.missing ? ".warn" : ""), {}, [line(false), fill]);
}

/* Explicit inline icon sizes override stylesheet sizing. */

export function iconBtn(_key, { size = 44, glyph = null, title = "" } = {}) {
  const b = el("button.iconbtn", {
    title,
    /* Use a distinct button surface so controls remain visible on panels. */

    style: `width:${size}px;height:${size}px;border:1px solid var(--btn-edge,var(--edge));` +
      "border-radius:var(--btn-radius,7px);" +
      "background:var(--btn-bg,var(--surface));display:flex;" +
      "align-items:center;justify-content:center;cursor:pointer;padding:0;" +
      "color:var(--btn-fg,var(--ico))",
  });
  b.innerHTML = glyph || "";
  return b;
}

/* The stop cell acts immediately; other strip presses open settings. */

export function autoStrip({ on = false, text = "", onGo = null, onOpen = null } = {}) {
  const go = el("button.asgo" + (on ? ".on" : ""), { type: "button",
    title: on ? "stop AUTO now" : "start: who makes, what, the direction" }, [glyph(on ? "stop" : "play", 14)]);
  go.dataset.s = on ? "■" : "▶";
  if (onGo) go.onclick = (e) => { e.stopPropagation(); onGo(); };
  const row = el("div.astrip" + (on ? ".on" : ""), { role: "button", tabindex: "0",
    title: on ? "AUTO's sheet: the direction, who makes, what" : "start: who makes, what, the direction" },
    [go, el("span.astext", { text })]);
  if (onOpen) {
    row.onclick = (e) => { e.stopPropagation(); onOpen(); };
    row.onkeydown = (e) => { if (e.target === row && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); onOpen(); } };
  }
  return row;
}

export function poolHead(n) {
  return el("span.auh.poolh", {}, [glyph("pool", 14), el("span", { text: n ? `auto pool · ${n}` : "auto pool" })]);
}

/* Preserve the full tab comment and distinguish absent instructions from empty output. */

export function autoLine(words, kinds = ["revise"]) {
  const k = kinds.length ? kinds.join(" and ") : "revise";
  return words ? `[Comment, ${k}] ${words}` : `[No comment, free ${k}]`;
}

/* Held versions use a nonnumeric vote marker; other votes step by one. */

/* A tap shows its vote at once: onVote(sign) saves it and returns the value to show, or undefined to leave the
   cell to the repaint. */
export function voteCells(v, onVote, title = "") {
  const minus = el("button.auv.no-swipe", { type: "button", text: "−", title: "vote down" });
  const plus = el("button.auv.no-swipe", { type: "button", text: "+", title: "vote up" });
  const val = el("span.auval", { title });
  const show = (x) => {
    v = x;
    val.className = "auval" + (x === "n" ? " n" : x > 0 ? " up" : x < 0 ? " down" : "");
    val.textContent = x === "n" ? "n" : x > 0 ? `+${x}` : String(x || 0);
  };
  const tap = (sign) => (e) => {
    e.stopPropagation();
    const next = onVote(sign);
    if (next !== undefined) show(next);
  };
  minus.onclick = tap(-1);
  plus.onclick = tap(+1);
  show(v);
  return el("span.auvote", {}, [minus, val, plus]);
}
/* A list row's time: the clock today, the day before that (one rule for every AUTO list).  */
export function listWhen(ts) {
  if (!ts) return "";
  const d = new Date(ts * 1000);
  return d.toDateString() === new Date().toDateString()
    ? d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

/* Use SVG waveforms rather than per-card canvases in collapsed grids. */

function playOverlay(size = 34) {
  return el("span.play", {
    style: `position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);` +
      `width:${size}px;height:${size}px;border-radius:50%;` +
      "background:rgba(12,12,12,.62);border:1px solid rgba(255,255,255,.28);" +
      "display:flex;align-items:center;justify-content:center;pointer-events:none",
    html: `<svg viewBox="0 0 24 24" width="${Math.round(size * 0.5)}" ` +
      `height="${Math.round(size * 0.5)}" aria-hidden="true">` +
      `<path d="M9,7.5 L17,12 L9,16.5 Z" fill="#e8e8e8"/></svg>`,
  });
}

/* Build provenance chips from structured facts; free-form agent notes are not settings. */

export function madeChips(v = {}, card = {}) {
  const agent = v.agent || card.agent, model = v.model || card.model || "";
  const title = [agent, model, v.effort].filter(Boolean).join(" · ");
  const seen = new Set();
  return [...(v.method ? [{ text: v.method, method: true }] : []), ...(v.settings || []).map((t) => ({ text: t })),
          { text: agent, agent: true }, { text: model.replace(/ · .*$/, "") }, { text: v.effort }]
    .filter((x) => x.text && !seen.has(String(x.text)) && seen.add(String(x.text)))
    .map((x) => ({ ...x, text: String(x.text), title }));
}

/* Only card media URLs receive cached thumbnail sizing. */

export function thumb(url, w) {
  return typeof url === "string" && /^\/media\/(?!queue\/)[^/]+\/[^/?]+\.(png|jpe?g|webp)$/i.test(url)
    ? `${url}?w=${w}` : url;
}

export function cardMedia(c, { w = 360 } = {}) {
  /* Infer media capabilities from present data, not type identifiers. */

  const m = c.media || {};
  /* Still-only media is valid even without an animation or video. */
  if (!m.gif && !m.poster && !m.video && !m.still) {
    /* Missing pictures do not imply audio; absent media stays empty. */

    return el("div.media.none", {
      style: "position:relative;aspect-ratio:1;background:#000000" });
  }
  if (m.poster || m.video) {
    const box = el("div.media.video", {
      style: "position:relative;aspect-ratio:1;background:#000000" });

    box.append(el("img", { src: thumb(m.still || m.poster, w), alt: c.id, loading: "lazy",
      style: "width:100%;height:100%;object-fit:cover;display:block" }));
    box.append(playOverlay());
    return box;
  }
  /* Keep an unchanged still beneath the decoded animation so handovers never paint black. */

  const box = el("div.media.gif", {
    style: "position:relative;aspect-ratio:1;background:#000000" });
  box.append(el("img.still", { src: thumb(m.still, w) || m.gif, alt: c.id, loading: "lazy",
    style: "width:100%;height:100%;object-fit:cover;display:block" }));
  if (m.gif && m.still) {
    box.append(el("img.anim", { alt: "", "aria-hidden": "true", "data-gif": m.gif }));
  }
  return box;
}

/* Draw shared marks as SVG to avoid platform-dependent emoji rendering. */

const GLYPH = {
  /* Draw pause marks rather than relying on Android emoji presentation. */

  // the picker itself: a grid of four cards, apart enough for the cross between them to show
  picker:  '<rect x="2.8" y="2.8" width="4.2" height="4.2"/><rect x="9" y="2.8" width="4.2" height="4.2"/>' +
           '<rect x="2.8" y="9" width="4.2" height="4.2"/><rect x="9" y="9" width="4.2" height="4.2"/>',
  copy:    '<rect x="5.5" y="5.5" width="8" height="8" rx="1.2"/><path d="M10.5 5.5V3.7a1.2 1.2 0 0 0-1.2-1.2H3.7a1.2 1.2 0 0 0-1.2 1.2v5.6a1.2 1.2 0 0 0 1.2 1.2h1.8"/>',

  dup:     '<path d="M5.5 5.5V2.5h8v8h-3"/><rect x="2.5" y="5.5" width="8" height="8"/><path d="M6.5 7.8v3.4M4.8 9.5h3.4"/>',
  split:   '<path d="M2.5 6.5v7h7"/><path d="M5 4h7v7"/><path d="M7.5 8.5l6-6M9.5 2.5h4v4"/>',

  pause:   '<rect x="4.1" y="3.4" width="2.9" height="9.2" rx="1" fill="currentColor" stroke="none"/>' +
           '<rect x="9" y="3.4" width="2.9" height="9.2" rx="1" fill="currentColor" stroke="none"/>',

  check:   '<path d="M3.4 8.4l3 3 6.2-6.9"/>',
  /* Taking a part out is reversible; the bin does not delete its source. */

  trash:   '<path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.7 8.5h5.6l.7-8.5M7 7v4M9 7v4"/>',

  image:   '<rect x="2.2" y="3.2" width="9.2" height="8.2" rx="1.3"/>' +
           '<circle cx="5.2" cy="6.1" r=".95"/>' +
           '<path d="M11.4 9.3 8.7 6.9 3.6 11.4"/>' +
           '<path d="M12.9 10.6v4.2M10.8 12.7h4.2"/>',
  info:    '<circle cx="8" cy="8" r="5.6"/>' +
           '<path d="M8 7.3v3.6"/>' +
           '<path d="M8 5.2v.05"/>',
  help:    '<circle cx="8" cy="8" r="5.6"/>' +
           '<path d="M6.4 6.5a1.7 1.7 0 1 1 2.4 1.5c-.5.2-.8.6-.8 1.1v.3"/>' +
           '<path d="M8 11.1v.05"/>',
  archive: '<path d="M2.6 4.2h10.8v2.6H2.6z"/>' +
           '<path d="M3.7 6.8v5.4a1.1 1.1 0 0 0 1.1 1.1h6.4a1.1 1.1 0 0 0 1.1-1.1V6.8"/>' +
           '<path d="M6.5 9.3h3"/>',
  prev:    '<path d="M9.8 4L5.8 8l4 4"/>',

  download: '<path d="M8 2.6v7.6M4.9 7.2 8 10.3l3.1-3.1"/><path d="M3 11.2v2h10v-2"/>',
  /* Rotate one chevron for both states rather than maintaining two paths. */

  chev:    '<path d="M3.6 6.2 8 10.6l4.4-4.4"/>',

  plus:    '<path d="M4.2 8h7.6M8 4.2v7.6"/>',
  next:    '<path d="M6.2 4l4 4-4 4"/>',
  play:    '<path d="M5.8 3.8 12.4 8l-6.6 4.2z" fill="currentColor" stroke="none"/>',

  stop:    '<rect x="4.4" y="4.4" width="7.2" height="7.2" rx="1" fill="currentColor" stroke="none"/>',
  speaker: '<path d="M2.6 6.2h2.5L8.4 3.4v9.2L5.1 9.8H2.6z" fill="currentColor"/><path d="M10.6 5.8a3.2 3.2 0 0 1 0 4.4M12.6 4a5.6 5.6 0 0 1 0 8"/>',
  speakermute: '<path d="M2.6 6.2h2.5L8.4 3.4v9.2L5.1 9.8H2.6z" fill="currentColor"/><path d="M2 2.2l12 11.6"/>',
  tlplus:  '<path d="M2.4 3.6h6.4M5.6 3.6v8.6"/><path d="M11.8 7.4v5M9.3 9.9h5"/>',
  code:    '<path d="M5.8 4.6 2.6 8l3.2 3.4M10.2 4.6 13.4 8l-3.2 3.4"/>',

  full:    '<path d="M2.8 6V2.8H6M10 2.8h3.2V6M13.2 10v3.2H10M6 13.2H2.8V10"/>',
  unfull:  '<path d="M6 2.8V6H2.8M10 2.8V6h3.2M13.2 10H10v3.2M2.8 10H6v3.2"/>',
  cut:     '<path d="M4 4l8 8M12 4l-8 8"/>',

  open:    '<path d="M4.6 11.4l6.6-6.6M6.4 4.6h4.8v4.8"/>',
  loop:    '<path d="M13.2 8a5.2 5.2 0 1 1-5.2-5.2c1.46 0 2.86.58 3.9 1.6l1.3 1.2"/><path d="M13.2 2.6v3h-3"/>',
  arrow:   '<path d="M3 8h9.6M8.6 4l4 4-4 4"/>',
  limited: '<circle cx="8" cy="8" r="5.4"/><path d="M8 8V2.6A5.4 5.4 0 0 1 13.4 8z" fill="currentColor" stroke="none"/>',
  comment: '<path d="M2.8 3.6h10.4v6.6H7.4l-3 2.4v-2.4H2.8z"/>',

  sliders: '<path d="M3.8 13.4V10M3.8 7.6V2.6M2.5 10h2.6M8 2.6V6M8 8.4v5M6.7 6h2.6M12.2 2.6v6M12.2 11v2.4M10.9 11h2.6"/>',

  pool:    '<ellipse cx="8" cy="9.2" rx="6.2" ry="2.1" fill="currentColor" fill-opacity=".35"/>' +
           '<path d="M1.8 9.2v2.6a6.2 2.1 0 0 0 12.4 0V9.2"/>' +
           '<path d="M6.2 9V4.4a1 1 0 0 0-2 0v.4"/><path d="M10.2 9V4.4a1 1 0 0 0-2 0v.4"/><path d="M6.2 6.4h4"/>',
  /* Give paired glyphs matching masks and plus placement; the gap must stay transparent. */

  revise: (id) =>
    `<mask id="${id}"><rect width="16" height="16" fill="#ffffff"/>` +
    `<circle cx="12.4" cy="11.9" r="3.9" fill="#000000"/></mask>` +
    `<g mask="url(#${id})">` +
    /* Two plates remain distinguishable at small icon sizes. */

    '<path d="M7 1.4 1.4 4.6l5.6 3.2 5.6-3.2z"/>' +
    /* Stop strokes before the mask cut to avoid visible blunt chords. */

    '<path d="M1.4 9.3 7 12.5l3.4-1.9"/></g>' +
    '<path d="M12.4 9.5v4.8M10 11.9h4.8"/>',
  spark: (id) =>
    `<mask id="${id}"><rect width="16" height="16" fill="#ffffff"/>` +
    `<circle cx="12.4" cy="11.9" r="3.9" fill="#000000"/></mask>` +
    `<path mask="url(#${id})" d="M6.7 0.9 8.25 5.15 12.5 6.7 8.25 8.25 ` +
    '6.7 12.5 5.15 8.25 0.9 6.7 5.15 5.15z" fill="currentColor" stroke="none"/>' +
    '<path d="M12.4 9.5v4.8M10 11.9h4.8"/>',
};

/* Use one overlay bubble; recompute its anchor after layout changes and close it on outside input. */

let bub = null;
export function infoBubble(anchor, content, cls = "") {
  if (bub && bub.anchor === anchor) { closeBubble(); return null; }
  closeBubble();
  const b = el("div.ibub" + (cls ? `.${cls}` : ""), { role: "tooltip" }, Array.isArray(content) ? content : [content]);
  document.body.append(b);
  const place = () => {
    const r = anchor.getBoundingClientRect(), bw = b.offsetWidth, bh = b.offsetHeight;
    const left = Math.max(10, Math.min(innerWidth - 10 - bw, r.left + r.width / 2 - bw / 2));
    /* Leave space above the anchor for the app band before placing the bubble upward. */

    const band = document.querySelector(".band");
    const up = r.top - bh - 12 >= (band ? Math.max(0, band.getBoundingClientRect().bottom) : 0) + 16;
    b.style.left = `${Math.round(left)}px`;
    b.style.top = `${Math.round(up ? r.top - bh - 10 : r.bottom + 10)}px`;
    b.style.setProperty("--tail", `${Math.round(r.left + r.width / 2 - left)}px`);
    b.classList.toggle("up", up);
    b.classList.toggle("down", !up);
  };
  place();
  const ro = new ResizeObserver(place);
  ro.observe(b);
  anchor.setAttribute("aria-expanded", "true");
  const off = (e) => { if (!b.contains(e.target) && !anchor.contains(e.target)) closeBubble(); };
  document.addEventListener("pointerdown", off, true);
  addEventListener("scroll", closeBubble, { capture: true, passive: true });
  bub = { b, anchor, off, ro };
  return b;
}
export function closeBubble() {
  if (!bub) return;
  const { b, anchor, off, ro } = bub;
  bub = null;
  ro.disconnect();
  b.remove();
  anchor.setAttribute("aria-expanded", "false");
  document.removeEventListener("pointerdown", off, true);
  removeEventListener("scroll", closeBubble, { capture: true });
}

let _gid = 0;

/* CSS owns the play/pause glyph switch so transport callers only update state. */

export function playGlyphs(size = 13) {
  const a = glyph("play", size), b = glyph("pause", size);
  a.classList.add("g-play");
  b.classList.add("g-pause");
  return [a, b];
}

/* Cache unmasked glyphs by name and size, then clone; masked glyphs require unique IDs. */

const glyphs = new Map();
export function glyph(name, size = 13) {
  const g = GLYPH[name];
  if (typeof g !== "function") {
    const key = `${name}|${size}`;
    if (!glyphs.has(key)) glyphs.set(key, glyphSpan(g, size));
    return glyphs.get(key).cloneNode(true);
  }
  /* SVG IDs are document-wide; every masked instance needs its own ID. */

  return glyphSpan(g(`gm${++_gid}`), size);
}
function glyphSpan(d, size) {
  /* A null size delegates sizing to CSS; inline dimensions would override responsive rules. */

  const css = size == null;
  const n = el("span", { style: "display:inline-flex;flex:none;align-items:center"
    + (css ? "" : `;width:${size}px;height:${size}px`) });
  n.innerHTML = `<svg viewBox="0 0 16 16"` +
    (css ? ` width="100%" height="100%"` : ` width="${size}" height="${size}"`) +
    ` fill="none" stroke="currentColor" stroke-width="1.4" ` +
    `stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
  return n;
}

export function kindIcon(kind, size = 13) {
  return glyph(kind === "revise" ? "revise" : "spark", size);
}

export function scrollIndicator(scroller, { width = 5, inset = 8 } = {}) {
  const track = el("div.sind", {
    style: `position:absolute;top:${inset}px;bottom:${inset}px;right:3px;` +
      `width:${width}px;border-radius:${width}px;` +
      "background:rgba(255,255,255,.08);pointer-events:none",
  });
  const thumb = el("div.sind-thumb", {
    style: `position:absolute;left:0;width:${width}px;border-radius:${width}px;` +
      "background:rgba(255,255,255,.30)",
  });
  track.append(thumb);

  function sync() {
    const over = scroller.scrollHeight - scroller.clientHeight;
    track.hidden = over <= 1;
    /* Reserve an indicator channel only while content actually overflows. */

    scroller.classList.toggle("over", over > 1);
    if (track.hidden) return;
    const h = track.clientHeight || (track.getBoundingClientRect().height);
    const frac = scroller.clientHeight / scroller.scrollHeight;
    const th = Math.max(18, Math.round(h * frac));
    thumb.style.height = `${th}px`;
    thumb.style.top = `${Math.round((h - th) * (scroller.scrollTop / over))}px`;
  }

  scroller.addEventListener("scroll", sync, { passive: true });
  /* Content can arrive after the first paint (images, a new queue item). */
  if (window.ResizeObserver) new ResizeObserver(sync).observe(scroller);
  requestAnimationFrame(sync);
  return { el: track, sync };
}

/* Use one shared full-width toggle target for collapsible lead panels. */

export function panelHead({ label, open = true, onToggle, status = null }) {
  const head = el("div.phead" + (open ? ".open" : "") + (status && status.on ? ".aon" : ""));
  const tog = el("button.phead-tog", { type: "button" });
  tog.setAttribute("aria-expanded", open ? "true" : "false");
  tog.title = open ? `hide ${label}` : `show ${label}`;
  tog.append(

    el("span.phead-caret", { "aria-hidden": "true" }, [glyph("chev", null)]),
    /* AUTO state is shared by the panel header and frame, including when collapsed. */

    status ? el("span.phead-lbl.astat" + (status.on ? ".on" : ""), {}, [
        el("span", { text: label }), el("span.astate", { text: status.on ? "on" : "off" }),
        ...(status.on ? [el("span.apwho", { text: `· ${status.who || "making"}` })] : [])])
    : el("span.phead-lbl", { text: label }),
  );
  if (onToggle) tog.onclick = () => onToggle(!open);
  head.append(tog);
  /* The corner control collapses an open panel; it must not expand a closed one. */

  if (open && onToggle) {
    const x = el("button.phead-x", { type: "button", title: `hide ${label}` }, [glyph("cut", 16)]);
    x.setAttribute("aria-label", `hide ${label}`);
    x.onclick = () => onToggle(false);
    head.append(x);
  }

  return head;
}

/* Keep lane colors shared across grid, expanded cards and timeline. */

const LANE_BLUE = "#88a3bf";

/* Derive stable presentation from identity rather than storing a random seed. */

export function seedOf(id) {
  let h = 0x811c9dc5;
  for (let i = 0; i < String(id).length; i++) {
    h ^= String(id).charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % 100000;
}

export function voiceColor(_id) { return LANE_BLUE; }

/* Use a separate source-recording color so input audio is not mistaken for a generated voice. */

export const RECORDING_YELLOW = "#d6bd62";
