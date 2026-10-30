/* Keep one server-owned bracket per type; selection is not a vote and leaving preserves progress. */

import { el, glyph, playGlyphs } from "../dom.js";

/* Stop cup audio on advancement or close, and stop other page playback before starting it. */

let ear = null, earFor = null, stopOthers = null;
/* Use the shared lane transport when available; fall back to a standalone audio control. */

let mediaFor = null;

let refFor = (c) => c.id;
const nameOf = (c) => refFor(c) || c.id;
export function stopCupAudio() {
  if (ear) { ear.pause(); ear.removeAttribute("src"); }
  earFor = null;
  document.querySelectorAll(".cupshot.audio .vplay.on").forEach((b) => b.classList.remove("on"));
}
/* Playback and selection use separate targets; listening must never choose a winner. */

function listen(box, c) {
  const b = el("div.vplay", { title: "listen" }, playGlyphs(18));
  box.onclick = (ev) => {
    ev.stopPropagation();
    if (earFor === c.id) { stopCupAudio(); return; }
    stopCupAudio();
    if (stopOthers) stopOthers();
    ear = ear || new Audio();
    ear.src = c.audio;
    ear.onended = () => stopCupAudio();
    ear.play().catch(() => stopCupAudio());
    earFor = c.id;
    b.classList.add("on");
  };
  return b;
}

/* Use lightweight thumbnails when full card data is unavailable. */

function thumb(c, { big = false } = {}) {
  const m = c.media || {};
  const src = m.gif || m.still || "";
  const box = el("div.cupshot" + (big ? ".big" : ""));
  const bands = !src && mediaFor ? mediaFor(c.id) : null;
  if (bands) {
    box.classList.add("bands");
    box.append(bands);
  } else if (src) {
    box.append(el("img", { src, alt: c.label || c.id, loading: "lazy",
                           decoding: "async" }));
  } else if (c.audio) {
    box.classList.add("audio");
    box.append(listen(box, c));           /* its name is under the tile, once */
  } else {
    /* If a frozen candidate loses media, show its prompt rather than silently removing it. */

    box.classList.add("empty");
    box.append(el("div.cupwhy", { text: c.why || c.label || c.id }));
  }
  return box;
}

/* Choosing and playback must remain separate even when both occupy the tile. */

function tile(c, { on, picked = false, big = false, pick = true } = {}) {
  const t = el("div.cuptile" + (picked ? ".on" : "") + (big ? ".big" : ""));
  const shot = thumb(c, { big });
  t.append(shot);
  if (pick) {
    const tick = el("button.cupcheck" + (picked ? ".on" : ""), { type: "button",
      title: picked ? "picked — tap to unpick" : "pick this one", "aria-pressed": String(picked) },
      glyph("check", 18));
    tick.onclick = (ev) => { ev.stopPropagation(); on(c.id); };
    shot.append(tick);
    /* a picture picks with a tap anywhere on it; a sound or its bands play there instead */
    if (!shot.classList.contains("audio") && !shot.classList.contains("bands")) shot.onclick = () => on(c.id);
  }
  t.append(el("div.cupname", {}, [
    el("span.grow.cupref", { text: nameOf(c), title: c.label || "" }),
    c.vote ? el("span.cupvote", { text: (c.vote > 0 ? "+" : "") + c.vote }) : null,
    /* Keep archived frozen candidates visible so the bracket can still finish. */

    c.archived ? el("span.cuparch", { text: "culled", title:
      "archived since this cup was drawn" }) : null,
  ]));
  return t;
}

/* Redraw from server state; do not infer bracket position locally. */

export function mountCup(host, api) {
  stopOthers = api.stopOthers || null;
  mediaFor = api.media || null;
  if (api.ref) refFor = (c) => api.ref(c) || c.id;
  let st = null;
  let staged = [];
  let busy = false;

  const paint = () => host.replaceChildren(view());

  /* Distinguish status and cup responses by stage; status may contain a resumable bracket. */

  async function act(fn, { resume = false } = {}) {
    if (busy) return;
    busy = true;
    stopCupAudio();                            /* the next group or pair: the last one's sound stops */
    if (stopOthers && host.querySelector(".vplay.on")) stopOthers();
    paint();
    try {
      const got = await fn();
      st = (resume && got && !got.stage && got.cup) ? got.cup : got;
      staged = [];
    } catch (e) { st = { ...(st || {}), error: e.message || String(e) }; }
    busy = false;
    paint();
  }

  function start(s0) {
    const n = s0.candidates;
    const last = s0.last;
    const running = s0.cup;
    return el("div.cupstage.start", {}, [
      el("div.cupask", { text: `${(api.label || String)(s0.type)} — ${n} card${n === 1 ? "" : "s"}` }),
      last ? el("div.cupwin", {}, [tile(last.card, { on: () => {}, big: true, pick: false })])
           : el("div.cupnote", { text: n < 2
               ? "there is nothing here to judge yet"
               : `a cup runs them in groups of five, then knocks the winners `
                 + `out two at a time. About ${Math.ceil(n / 5)
                 } group${Math.ceil(n / 5) === 1 ? "" : "s"} and ${
                 Math.max(0, 2 * Math.ceil(n / 5) - 1)} duels.` }),
      running ? el("div.cupnote", { text: `one is under way — ${
        running.stage === "group"
          ? `group ${running.done_groups + 1} of ${running.total_groups}`
          : `knockout, ${(running.ko_log || []).length} judged`}` }) : null,
      last ? el("div.cupnote", { text:
        `last cup: ${nameOf(last.card || { id: last.winner })} won` }) : null,
      el("div.cupbar", {}, [
        el("span.grow", { text: s0.played
          ? `${s0.played} cup${s0.played === 1 ? "" : "s"} played` : "" }),
        /* Offer restart as well as resume; unfinished brackets need not be continued. */

        running ? (() => {
          const b = el("button.cupgo", { type: "button" }, [glyph("next", 12), "carry on"]);
          b.onclick = () => act(async () => running);
          return b;
        })() : null,
        (() => {
          const b = el("button.cupgo" + (n < 2 ? ".off" : ""),
                       { type: "button" },
                       running ? ["start over"] : last ? ["run it again"] : [glyph("next", 12), "start"]);
          b.disabled = n < 2 || busy;
          b.onclick = () => act(() => api.open());
          return b;
        })(),
      ]),
    ]);
  }

  function group(nx) {
    const want = nx.advance;
    const toggle = (id) => {
      const i = staged.indexOf(id);
      if (i >= 0) staged.splice(i, 1);
      /* At the selection limit, evict the oldest choice rather than ignoring the new tap. */

      else { staged.push(id); if (staged.length > want) staged.shift(); }
      paint();
    };
    const ready = staged.length === want;
    return el("div.cupstage", {}, [
      el("div.cupask", { text: `pick ${want} of these ${nx.cards.length}` }),
      el("div.cupgrid", {}, nx.cards.map((id) =>
        tile(st.cards[id] || { id }, { on: toggle, picked: staged.includes(id) }))),
      el("div.cupbar", {}, [
        el("span.grow", { text: `${staged.length}/${want} chosen` }),
        (() => {
          const b = el("button.cupgo" + (ready ? "" : ".off"),
                       { type: "button" }, [glyph("next", 12), "next"]);
          b.disabled = !ready || busy;
          b.onclick = () => act(() => api.pick(st.id, nx.group, staged.slice()));
          return b;
        })(),
      ]),
    ]);
  }

  function duel(nx) {
    const { a, b } = nx.duel;
    const decided = (st.rounds || []).flat().filter((p) => p.winner).length;
    const total = (st.rounds || []).flat().length;
    const win = (id) => act(() => api.duel(st.id, a, b, id));
    return el("div.cupstage.duel", {}, [
      el("div.cupask", { text: "which one — tap its box" }),
      el("div.cupduel", {}, [
        tile(st.cards[a] || { id: a }, { on: win, big: true }),
        tile(st.cards[b] || { id: b }, { on: win, big: true }),
      ]),
      el("div.cupbar", {}, [
        el("span.grow", { text: `${decided} of ${total} decided` }),
      ]),
    ]);
  }

  function winner() {
    const w = st.cards[st.winner] || { id: st.winner };
    const beat = (st.advancers || []).filter((id) => id !== st.winner).length;
    return el("div.cupstage.won", {}, [
      el("div.cupask", { text: `${(api.label || String)(st.type)}'s card` }),
      el("div.cupwin", {}, [tile(w, { on: () => {}, big: true, pick: false })]),
      el("div.cupnote", { text:
        `beat ${beat} other${beat === 1 ? "" : "s"} out of ${
          (st.groups || []).flat().length} judged` }),
      el("div.cupbar", {}, [
        el("span.grow", {}),
        (() => {
          const b = el("button.cupgo", { type: "button", text: "done" });
          b.onclick = () => act(() => api.status());
          return b;
        })(),
      ]),
    ]);
  }

  /* Both status reads and cup writes use the server stage to determine the current screen. */

  function progress() {
    if (st.stage === "done") return "decided";
    if (st.stage === "group") return `group ${st.done_groups + 1} of ${st.total_groups}`;
    const flat = (st.rounds || []).flat();
    return `knockout · ${flat.filter((p) => p.winner).length} of ${flat.length}`;
  }

  function view() {
    if (!st) return el("div.cupnote", { text: "loading…" });
    if (st.error) {
      const box = el("div.cupnote.err", { text: st.error });
      const b = el("button.cupgo", { type: "button", text: "back" });
      b.onclick = () => act(() => api.status());
      box.append(b);
      return box;
    }
    const running = !!st.stage;
    const head = el("div.cuptop", {}, [
      running ? (() => {
        const b = el("button.cupback",
                     { type: "button", title: "leave it where it is" }, [glyph("prev", 18)]);
        /* Leaving preserves the bracket for the next open. */

        b.onclick = () => act(() => api.status());
        return b;
      })() : null,

      el("span.grow", { text: running ? progress() : "" }),
      busy ? el("span.cupbusy", { text: "…" }) : null,
    ]);
    const body = !running ? start(st)
      : st.stage === "done" ? winner()
      : st.stage === "group" ? group(st.next)
      : st.next && st.next.duel ? duel(st.next)
      : el("div.cupnote", { text: "nothing left to judge here" });
    return el("div.cupwrap", {}, [head, body]);
  }

  paint();
  /* Resume the in-progress bracket when opened from the grid. */
  act(() => api.status(), { resume: true });
  return { refresh: () => act(() => api.status(), { resume: true }) };
}
