

import { el, usageBar, iconBtn, autoStrip, autoLine, poolHead, voteCells, listWhen, cardMedia, thumb,
         scrollIndicator, glyph, kindIcon, panelHead, RECORDING_YELLOW, playGlyphs, madeChips,
         infoBubble, closeBubble } from "./dom.js";
import { voiceBlock, waveSvg, stampLine, clock } from "./parts/voice.js";
import { trimEditor } from "./parts/trim.js";
import { nodeBlock, paramPanel } from "./parts/node.js";
import { abBlock, abFacts, abLength } from "./parts/ab.js";
import { mountTimeline, tlAdopt, tlActive, renderTimeline, tlStop, tlSetOpen }
  from "./parts/timeline.js";
import { mountCup, stopCupAudio } from "./parts/cup.js";
import { configured, mountSettings, receipts } from "./parts/settings.js";
import { walk, stop as stopWalk, walking, present, CARD_STEPS } from "./parts/walk.js";
import { mountAudit } from "./parts/audit.js";
import { sessionPct } from "./data.js";
import { codeView } from "./parts/code.js";

const PART_BLOCKS = { voice: voiceBlock, node: nodeBlock };

const BASE = {

  padgap: 3,

  qrow: 66, qgap: 3, qrows: 2.5, qthumb: 40, qfs: 14,

  radius: 7, innerRadius: 4, pad: 6, lgap: 6, wrapgap: 7, side: 9,

  gridmin: 120, gridgap: 7, cardradius: 6, cfs: 11,
};

export function build() {
  const t = { ...BASE };

  let TYPES = {};
  const typeLabel = (t) => (TYPES[t] || {}).label || t;
  const typeShort = (t) => (TYPES[t] || {}).short || typeLabel(t);
  const cap = (t, k) => ((TYPES[t] || {}).capabilities || {})[k];
  const namePrefix = (t) => (TYPES[t] || {}).name_prefix || null;

  /* How far the dark layer reaches above .cardsec: more than any header
     can be, so the top of the page is always covered. */
  const TOP = 1600;

  const UW = 268;
  const UW_WIDE = 304;
  const QMIN = 200;

  const BTN = 37;

  const PADN = 1;
  const WIDE = QMIN + UW + PADN * BTN + (PADN - 1) * t.padgap + 2 * t.lgap + 2 * t.pad + 2 + 2 * t.side;

  const UP = "92,175,127", DOWN = "196,120,122";

  const UP_TEXT = "166,211,185", DOWN_TEXT = "224,176,178";
  const EDGE = { 1: 0.45, 2: 0.70, 3: 1 };
  const BACK = { 1: 0.08, 2: 0.16, 3: 0.26 };
  const TEXT = { 1: 0.92, 2: 0.96, 3: 1 };

  const PX = {
    padgap: t.padgap, qrow: t.qrow, qgap: t.qgap, qthumb: t.qthumb, qfs: t.qfs,
    pad: t.pad, lgap: t.lgap, wrapgap: t.wrapgap, side: t.side,
    gridmin: t.gridmin, gridgap: t.gridgap, cfs: t.cfs,
    r: t.radius, "r-in": t.innerRadius, "r-card": t.cardradius,
    "r-sheet": t.cardradius + 3, "cfs-sm": t.cfs - 2,
    uw: UW, "uw-wide": UW_WIDE, qmin: QMIN, top: TOP, btn: BTN,
  };
  const RAW = {
    qrows: t.qrows, qgaps: Math.ceil(t.qrows) - 1,
    "up-rgb": UP, "down-rgb": DOWN,
  };

  const CSS_WIDE = 549;
  if (WIDE !== CSS_WIDE) {
    console.error(
      `page.js: WIDE is ${WIDE} but style.css switches at ${CSS_WIDE}px. ` +
      "Update the two @media rules in style.css.");
  }

  const css = [
    ":root{",
    ...Object.entries(PX).map(([k, v]) => `--${k}:${v}px;`),
    ...Object.entries(RAW).map(([k, v]) => `--${k}:${v};`),
    "}",
  ].join("");

  /* Read once: it is a layout constant, and getComputedStyle in a scroll
     handler is a forced style recalculation forty times a second. */
  const GIF_TURN = (() => {
    const v = parseFloat(getComputedStyle(document.documentElement)
      .getPropertyValue("--gif-turn"));
    return v > 0 && v < 1 ? v : 0.3;
  })();
  let gifObs = null, gifRaf = 0, gifOn = false, gifWait = 0;

  let SOUND_TURN = 0;

  const gifNear = new Set();
  let gifLive = null;

  let gifPoint = null, pointWait = 0, pointLeave = 0;

  let gridPausedBySheet = false;

  let gifSeq = 0;

  const PLAY_AFTER = 24;

  function turnPlays() {
    return onTypes().length === 1
      && (scrollY || document.documentElement.scrollTop || 0) > PLAY_AFTER;
  }

  function cardAudio(card) {
    const b = card && card.querySelector && card.querySelector(".vblock[data-audio]");
    return b ? b.dataset.audio : null;
  }

  function animOf(x) {
    if (!x) return null;
    if (x.matches && x.matches("img.anim[data-gif]")) return x;
    return x.querySelector ? x.querySelector("img.anim[data-gif]") : null;
  }

  function gifPlay(card) {
    const img = animOf(card);
    if (!img) {
      const url = turnPlays() ? cardAudio(card) : null;
      const yours = [...panels.values()].some((p) => p.busy()) || ((listen.el || listen.loading) && !listen.byTurn);
      if (url && !yours) {
        const block = card.querySelector(".vblock");
        const pb = card.querySelector(".vplay");
        play(scrollCard(card), url, {
          tick: lineIn(block),
          done: () => { if (pb) pb.classList.remove("on"); },
        });
        listen.byTurn = true;
        if (pb) pb.classList.add("on");
      }
      return;
    }
    if (img.dataset.playing) return;
    const token = String(++gifSeq);
    img.dataset.playing = token;
    img.src = img.dataset.gif;
    const show = () => { if (img.dataset.playing === token) img.classList.add("on"); };
    if (img.decode) img.decode().then(show, () => {});
    else { img.onload = show; img.onerror = () => {}; }
  }

  const gifWarmed = new Set();
  const gifHold = [];
  function gifWarm(card) {
    const img = animOf(card);
    if (!img) return;
    const url = img.dataset.gif;
    if (!url || gifWarmed.has(url)) return;
    gifWarmed.add(url);

    if (gifWarmed.size > 400) gifWarmed.clear();
    const pre = new Image();
    if ("fetchPriority" in pre) pre.fetchPriority = "low";
    pre.src = url;
    gifHold.push(pre);
    if (gifHold.length > 8) gifHold.shift();
  }

  const cardByEl = new WeakMap();

  let gridIO = null, regrid = null;
  const slotCard = new WeakMap(), slotFor = new WeakMap(), slotH = new Map(), stepped = new WeakMap();
  const scrollCard = (el_) => cardByEl.get(el_) || { id: el_ && el_.dataset && el_.dataset.id };

  function gifStop(card) {
    const img = animOf(card);
    if (!img) {

      if (card && listen.el && listen.byTurn) stopAudio();
      return;
    }
    if (!img.dataset.playing) return;
    delete img.dataset.playing;
    img.classList.remove("on");
    img.removeAttribute("src");
  }

  function gifPick() {
    gifRaf = 0;
    /* Pointer ownership suppresses scroll-based selection until the gesture ends. */
    if (gifPoint) return;
    if (!gifNear.size) return;
    const doc = document.documentElement;
    const y = scrollY || doc.scrollTop;

    const items = [];
    for (const img of gifNear) {
      const r = img.getBoundingClientRect();
      items.push({ img, top: Math.round(r.top + y), left: Math.round(r.left),
                   h: r.height });
    }

    const tops = [...new Set(items.map((i) => i.top))].sort((a, b) => a - b);
    const gaps = tops.slice(1).map((v, k) => v - tops[k]).filter((g) => g > 4);
    gaps.sort((a, b) => a - b);
    const rowH = gaps.length ? gaps[Math.floor(gaps.length / 2)]
               : (items[0].h || innerHeight) + t.gridgap;
    const lefts = [...new Set(items.map((i) => i.left))].sort((a, b) => a - b);
    const cols = lefts.length || 1;

    const grid = document.querySelector(".grid");
    const first = grid && grid.querySelector(".cardwrap");
    const gridTop = first
      ? Math.round(first.getBoundingClientRect().top + y)
      : grid ? Math.round(grid.getBoundingClientRect().top + y) : 0;

    const step = rowH / cols;

    const sounds = onTypes().length === 1 && items.some((i) => !animOf(i.img) && cardAudio(i.img));
    if (grid && grid.classList.contains("sounds") !== sounds) grid.classList.toggle("sounds", sounds);
    if (sounds && !SOUND_TURN) {
      const v = parseFloat(getComputedStyle(grid).getPropertyValue("--gif-turn"));
      SOUND_TURN = v > 0 && v < 1 ? v : 0.17;
    }
    // the turn line is a share of what shows below the sticky bar, not of the viewport the bar covers
    const band = document.querySelector("nav.band");
    const head = band ? Math.max(0, band.getBoundingClientRect().bottom) : 0;
    const want = Math.floor((y + head + (innerHeight - head) * (sounds ? SOUND_TURN : GIF_TURN) - gridTop) / step);
    if (sounds && want < 0) {
      if (gifLive) { clearTimeout(gifWait); gifStop(gifLive); gifLive = null; }
      return;
    }

    let best = null, bd = Infinity, bestOrd = 0;
    const byOrd = new Map();
    for (const i of items) {
      const ord = Math.round((i.top - gridTop) / rowH) * cols + lefts.indexOf(i.left);
      byOrd.set(ord, i.img);
      const d = Math.abs(ord - want);
      if (d < bd) { bd = d; best = i.img; bestOrd = ord; }
    }
    if (best === gifLive) return;

    gifStop(gifLive);
    gifLive = best;
    clearTimeout(gifWait);
    gifWait = setTimeout(() => {
      if (gifLive !== best) return;
      gifPlay(best);

      gifWarm(byOrd.get(bestOrd + 1));
      gifWarm(byOrd.get(bestOrd - 1));
    }, 120);
  }
  const gifSoon = () => { if (!gifRaf) gifRaf = requestAnimationFrame(gifPick); };

  function watchCard(w) {
    const c = w && w.querySelector && (w.matches("article.card") ? w : w.querySelector("article.card:not(.compose)"));
    if (gifObs && c && (c.querySelector("img.anim[data-gif]") || c.querySelector(".vblock[data-audio]"))) {
      gifObs.observe(c);
    }
  }

  function watchGifs(root) {
    if (gifObs) gifObs.disconnect();

    clearTimeout(gifWait);
    gifStop(gifLive);
    gifNear.clear();
    gifLive = null;
    gifPoint = null; clearTimeout(pointWait); clearTimeout(pointLeave);
    if (!("IntersectionObserver" in window)) return;
    gifObs = new IntersectionObserver((entries) => {

      const n0 = gifNear.size;
      let moved = false;
      for (const e of entries) {
        if (e.isIntersecting) gifNear.add(e.target);
        else moved = gifNear.delete(e.target) || moved;
      }
      if (moved || gifNear.size !== n0) gifSoon();
    }, { rootMargin: "25% 0px 25% 0px", threshold: 0 });

    root.querySelectorAll("article.card:not(.compose)").forEach((c) => {
      if (c.querySelector("img.anim[data-gif]") || c.querySelector(".vblock[data-audio]"))
        gifObs.observe(c);
    });
    if (!gifOn) {
      gifOn = true;
      addEventListener("scroll", gifSoon, { passive: true });
      addEventListener("resize", gifSoon, { passive: true });
      watchPointer();
    }
    gifSoon();
  }

  const POINT_SEL = ".grid article.card:not(.compose)";
  const pointable = (t) => {
    const card = t && t.closest ? t.closest(POINT_SEL) : null;
    return card && animOf(card) ? card : null;
  };
  function pointAt(card) {
    clearTimeout(pointLeave);
    if (card === gifPoint) return;
    if (!card) { gifPoint = null; gifSoon(); return; }
    clearTimeout(gifWait);
    clearTimeout(pointWait);
    if (gifLive && gifLive !== card) gifStop(gifLive);
    gifPoint = gifLive = card;
    pointWait = setTimeout(() => { if (gifLive === card) gifPlay(card); }, 120);
  }
  function watchPointer() {

    addEventListener("pointerover", (e) => {
      if (e.pointerType !== "mouse") return;
      const card = pointable(e.target);
      if (card) pointAt(card);
      else if (gifPoint) {
        clearTimeout(pointLeave);
        pointLeave = setTimeout(() => pointAt(null), 180);
      }
    }, { passive: true });
    document.documentElement.addEventListener("pointerleave", () => {
      if (gifPoint) pointAt(null);
    });

    const HOLD_MS = 280;
    let holdT = 0, holdCard = null, hx = 0, hy = 0;
    addEventListener("pointerdown", (e) => {
      if (e.pointerType === "mouse" || !e.target.closest || !e.target.closest(".media")) return;
      const card = pointable(e.target);
      if (!card) return;
      hx = e.clientX; hy = e.clientY;
      clearTimeout(holdT);
      holdT = setTimeout(() => {
        holdT = 0; holdCard = card; card.dataset.held = "1"; pointAt(card);
      }, HOLD_MS);
    }, { passive: true });
    addEventListener("pointermove", (e) => {
      if (holdT && (Math.abs(e.clientX - hx) > 10 || Math.abs(e.clientY - hy) > 10)) {
        clearTimeout(holdT); holdT = 0;
      }
    }, { passive: true });
    const holdEnd = () => {
      clearTimeout(holdT); holdT = 0;
      if (!holdCard) return;
      const c = holdCard;
      holdCard = null;
      pointAt(null);

      setTimeout(() => { delete c.dataset.held; }, 400);
    };
    addEventListener("pointerup", holdEnd, { passive: true });
    addEventListener("pointercancel", holdEnd, { passive: true });

    addEventListener("contextmenu", (e) => {
      if (e.target.closest && e.target.closest(POINT_SEL + " .media")) e.preventDefault();
    });
  }

  /* The open card always plays: it is the one thing on screen, so the scroll
     rule has nothing left to decide. */
  function playing(media) {
    const img = media.querySelector && media.querySelector("img.anim[data-gif]");
    if (img) gifPlay(img);
    return media;
  }

  let fitNow = null, barSeen = null;
  let tabsReordering = false, tabDraft = null, tabSel = null;

  let tabSaving = false, tabApply = null, tabReopen = null, tabEnd = null;
  function render(d) {
    TYPES = d.typeInfo || {};

    const filters = d.filters.map((f) => ({ ...f }));
    const grid = el("div.grid");

    const state = { q: d.queue.map((x) => ({ ...x })), paintQueue: null, refreshQueue: null };

    async function spawn(kind, card, text, images = [], version = null, extra = {}) {
      try {
        await d.q.add({ type: card.type, kind, card: card.id, text: text || "",
                        attachments: images, ...(version ? { version } : {}), ...extra });
      } catch (e) {

        toast(`not queued: ${e.message}`);
        console.error("enqueue:", e);
        return false;
      }
      try { await refreshQueue(); } catch (e) { console.error("queue refresh:", e); }
      return true;
    }

    spawnNow = spawn;
    deepLink(d, spawn);

    let qTimer = 0, qFails = 0;
    state.refreshQueue = refreshQueue;
    refreshQ = refreshQueue;
    watchStore(d);
    async function refreshQueue() {
      if (!d.q) return;
      let live;
      try { live = await d.q.list({ open: true }); }
      catch (e) {

        console.error("queue:", e);
        clearTimeout(qTimer);
        if (state.q.length) qTimer = setTimeout(refreshQueue, Math.min(30000, 2000 * 2 ** qFails++));
        return;
      }
      qFails = 0;

      const wasLive = new Set(state.q.map((j) => j.id));
      const gone = [...wasLive].filter((id) => !live.some((j) => j.id === id));
      state.q = live;
      state.paintQueue();
      if (gone.length && d.reload) {
        try { await d.reload(onTypes()); paintGrid(); } catch (e) { console.error("reload:", e); }
      }

      if (gone.length && state.refreshUsage) state.refreshUsage();

      clearTimeout(qTimer);
      const running = live.some((j) => j.status === "running");
      const queued = live.some((j) => j.status === "queued");
      const waiting = live.some((j) => j.status === "waiting");

      const next = running ? (eventsOpen ? 10000 : 2000) : eventsOpen ? 0 : queued ? 6000 : waiting ? 20000 : 0;
      if (next) qTimer = setTimeout(refreshQueue, next);
    }
    if (d.q) {
      refreshQueue();
      addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") refreshQueue();
      });
    }

    onTypes = () => filters.filter((f) => f.on).map((f) => f.slug);

    /* ONE TAB AT A TIME: a tap shows that type alone, and the one that is on stays on.
       (`?tab=X` opens one for a page load without saving it.) */
    const chips = filters.map((f) => {
      const b = el("button", { text: typeLabel(f.slug), type: "button", title: `show the ${typeLabel(f.slug)} cards`,
        "aria-pressed": String(!!f.on), class: "chip" + (f.on ? " on" : "") });
      b.onclick = async () => {
        if (f.on) return;
        filters.forEach((x, i) => {
          x.on = x === f;
          chips[i].classList.toggle("on", x.on);
          chips[i].setAttribute("aria-pressed", String(x.on));
        });

        for (const x of d.filters) x.on = x.slug === f.slug;
        fitBar();
        tlStop();

        paint();

        if (d.saveFilters) d.saveFilters(onTypes());
        try {
          if (f.on && d.ensure) await d.ensure(f.slug);

          if (d.reloadArrangements) await d.reloadArrangements(onTypes());
          paint();
        } catch (e) { console.error("cards:", e); }
      };
      return b;
    });

    const bar = el("div.cardsbar");
    const moreBtn = el("button.chip.tabmore", { type: "button", text: "⋯", title: "the other tabs, and reorder",
                                                "aria-haspopup": "menu" });
    let behind = [];
    const fitBar = () => {
      const host = bar.parentElement;
      if (!host || !bar.isConnected || bar.classList.contains("reorder")) return;
      const cs = getComputedStyle(bar), gap = parseFloat(cs.columnGap) || 0;

      const room = host.clientWidth * 0.95 - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)
        - moreBtn.offsetWidth - gap;
      chips.forEach((c) => { c.hidden = false; });
      const w = chips.map((c) => c.offsetWidth + gap);

      const vis = new Set();
      let used = 0;
      for (let i = 0; i < chips.length && used + w[i] <= room; i++) { vis.add(i); used += w[i]; }
      chips.forEach((c, i) => { c.hidden = !vis.has(i); });
      behind = filters.filter((_, i) => !vis.has(i)).map((f) => f.slug);
      const onBehind = filters.some((f, i) => f.on && !vis.has(i));
      moreBtn.classList.toggle("some", behind.length > 0);
      moreBtn.classList.toggle("holds", onBehind);
      moreBtn.title = onBehind ? `the tab you're on is in here (${typeLabel(filters.find((f) => f.on).slug)}), and reorder`
                               : "the other tabs, and reorder";
    };
    const placeBar = () => { bar.classList.remove("reorder"); bar.replaceChildren(...chips, moreBtn); fitBar(); };
    placeBar();

    fitNow = fitBar;
    if (!barSeen) {

      let wide = -1;
      barSeen = new ResizeObserver((es) => {
        const w = Math.round(es[0].contentRect.width);
        if (w !== wide) { wide = w; if (fitNow) fitNow(); if (regrid) regrid(); }
      });
      barSeen.observe(document.documentElement);
      if (document.fonts) document.fonts.ready.then(() => fitNow && fitNow()).catch(() => {});
    }
    requestAnimationFrame(fitBar);

    const reorder = (slugs) => {
      const at = (s) => { const i = slugs.indexOf(s); return i < 0 ? 1e9 : i; };
      const pairs = filters.map((f, i) => [f, chips[i]]).sort((a, b) => at(a[0].slug) - at(b[0].slug));
      filters.splice(0, filters.length, ...pairs.map((p) => p[0]));
      chips.splice(0, chips.length, ...pairs.map((p) => p[1]));
      d.filters.sort((a, b) => at(a.slug) - at(b.slug));
      placeBar();
    };

    const pullCheck = () => document.dispatchEvent(new Event("pullcheck"));
    let tabMenu = null;
    const closeTabMenu = () => {
      if (!tabMenu) return;
      tabMenu.remove(); tabMenu = null;
      document.removeEventListener("pointerdown", menuOutside, true);
    };
    const menuOutside = (e) => { if (tabMenu && !tabMenu.contains(e.target) && e.target !== moreBtn) closeTabMenu(); };
    moreBtn.onclick = () => {
      if (tabMenu) { closeTabMenu(); return; }
      const r = moreBtn.getBoundingClientRect();
      tabMenu = el("div.revpop.tabmenu", { role: "menu" }, [
        ...behind.map((s) => Object.assign(el("button.revpi" + ((filters.find((f) => f.slug === s) || {}).on ? ".on" : ""),
                                                { type: "button", role: "menuitem", text: typeLabel(s) }),
          { onclick: () => { closeTabMenu(); chips[filters.findIndex((f) => f.slug === s)].click(); } })),
        Object.assign(el("button.revpi.tabre", { type: "button", role: "menuitem", text: "reorder" }),
          { onclick: () => { closeTabMenu(); reorderInPlace(); } }),
      ]);
      tabMenu.style.top = `${Math.round(r.bottom + 4)}px`;
      tabMenu.style.right = `${Math.max(8, Math.round(innerWidth - r.right))}px`;
      document.body.append(tabMenu);
      document.addEventListener("pointerdown", menuOutside, true);
      addEventListener("scroll", closeTabMenu, { once: true, passive: true });
    };

    const reorderInPlace = () => {
      // a place in the history, as a sheet has: back cancels (closeSheet "reorder")
      if (!tabsReordering) { sheetHist.push("reorder"); history.pushState({ sheet: "reorder" }, ""); }
      tabsReordering = true;
      if (!tabDraft) tabDraft = filters.map((f) => f.slug);
      const box = el("div.tordbox");
      const cancel = el("button.tabcancel", { type: "button", text: "cancel" });
      cancel.onclick = () => closeSheet("reorder");
      const done = el("button.tabdone", { type: "button", text: "done" });
      const step = (k) => {
        const i = tabDraft.indexOf(tabSel), j = i + k;
        if (i < 0 || j < 0 || j >= tabDraft.length) return;
        [tabDraft[i], tabDraft[j]] = [tabDraft[j], tabDraft[i]];
        paintTiles();
      };
      const paintTiles = () => {
        const busy = tabSaving;
        box.replaceChildren(...tabDraft.map((s, i) => {
          if (s !== tabSel) {

            return Object.assign(el("button.tord", { type: "button", "data-slug": s,
              text: typeLabel(s), title: "pick it, to move it" }), { onclick: () => { tabSel = s; paintTiles(); }, disabled: busy });
          }
          const left = Object.assign(el("button.tordar", { type: "button", title: "earlier", "aria-label": "earlier" },
                                        [glyph("prev", 20)]),
                                     { onclick: () => step(-1), disabled: busy || i === 0 });
          const right = Object.assign(el("button.tordar", { type: "button", title: "later", "aria-label": "later" },
                                         [glyph("next", 20)]),
                                      { onclick: () => step(1), disabled: busy || i === tabDraft.length - 1 });
          const name = Object.assign(el("button.tordn", { type: "button", text: typeLabel(s), title: "put it down" }),
                                     { onclick: () => { tabSel = null; paintTiles(); }, disabled: busy });
          return el("div.tord.sel", { "data-slug": s }, [left, name, right]);
        }));
      };
      if (tabSaving) { done.disabled = cancel.disabled = true; done.textContent = "saving…"; }
      done.onclick = async () => {
        if (tabSaving) return;
        const slugs = tabDraft.slice();
        if (slugs.join() !== filters.map((f) => f.slug).join() && d.saveTabOrder) {
          tabSaving = true;
          done.disabled = cancel.disabled = true;
          done.textContent = "saving…";
          paintTiles();
          try { await d.saveTabOrder(slugs); }
          catch (e) {
            tabSaving = false;
            toast(`the order isn't saved (${e.message}) — done tries again`);
            if (tabReopen) tabReopen();
            return;
          }
          tabSaving = false;
        }
        if (tabApply) tabApply(slugs);
        closeSheet("reorder");
      };
      paintTiles();
      bar.classList.add("reorder");

      bar.replaceChildren(box, cancel, done);
      pullCheck();
    };
    tabApply = (slugs) => { reorder(slugs); pullCheck(); };
    tabEnd = () => { tabsReordering = false; tabDraft = null; tabSel = null; placeBar(); pullCheck(); };
    tabReopen = reorderInPlace;
    if (tabsReordering) reorderInPlace();

    const archive = { on: new URLSearchParams(location.search).get("view") === "archive",
                      cards: null, loading: false, key: null };
    const archiveBtn = () => Object.assign(el("button.archbtn.wide", { type: "button",
      title: archive.on ? "the cards that are not archived" : "the archived cards — open one to inspire from it or unarchive it" },
      archive.on ? [glyph("prev", 14), "back to the cards"] : ["archive"]), {
      onclick: async () => {
        archive.on = !archive.on;
        if (archive.on) { archive.key = onTypes().join(","); await loadArchive(); }
        else if (d.reload) {
          try { await d.reload(onTypes()); } catch (e) { console.error("reload:", e); }
        }
        paint();
        window.scrollTo(0, 0);
      } });
    async function loadArchive() {
      if (!d.archived) { archive.cards = []; return; }
      archive.loading = true;
      try { archive.cards = await d.archived(onTypes()); }
      catch (e) { archive.cards = []; toast(`the archive didn't load: ${e.message}`); }
      archive.loading = false;
    }

    const built = new WeakMap();
    forgetCard = (c) => { built.delete(c); };
    rebuildCard = (c) => { built.delete(c); paint(); };
    const cardEl = (c) => {
      let e = built.get(c);
      if (!e) { e = cardOf(c, d, spawn); built.set(c, e); cardByEl.set(e, c); }
      return e;
    };

    const ROWS = 4;
    const firstN = (cols) => Math.min(24, cols * Math.ceil(innerHeight
      / Math.max(60, (document.documentElement.clientWidth - t.gridgap * (cols - 1)) / cols)));
    const slices = { gen: 0, raf: 0 };
    const want = new Set();
    if (gridIO) { gridIO.near.disconnect(); gridIO.far.disconnect(); }
    const near = new IntersectionObserver((es) => {
      for (const e of es) if (e.isIntersecting) want.add(e.target); else want.delete(e.target);
      if (want.size) sliceSoon();
    }, { rootMargin: "300% 0px 300% 0px" });
    const far = new IntersectionObserver((es) => {
      for (const e of es) if (!e.isIntersecting) evict(e.target);
    }, { rootMargin: "500% 0px 500% 0px" });
    gridIO = { near, far };

    const slotOf = (c) => {
      let ph = slotFor.get(c);
      if (!ph) {
        ph = el("div.cardwrap.cardph", { "data-cid": c.id }, [el("span.phname", { text: refOf(c, shownAt(c)) })]);
        slotCard.set(ph, c);
        slotFor.set(c, ph);
      }
      return ph;
    };

    const gridCols = () => {
      const w = grid.isConnected ? grid.clientWidth : document.documentElement.clientWidth;
      return Math.max(1, Math.floor((w + t.gridgap) / (t.gridmin + t.gridgap)));
    };
    let laidCols = 0;
    const blocks = (frag, list) => {
      laidCols = gridCols();
      const per = laidCols * ROWS, FIRST = firstN(laidCols);
      for (let b = 0; b < list.length; b += per) {
        const blk = el("div.gblock");
        const n = Math.min(list.length, b + per) - b;
        blk.style.setProperty("--rows", String(Math.ceil(n / laidCols)));
        for (let i = b; i < b + n; i++) {
          const c = list[i];
          if (i < FIRST || built.has(c)) { const e = cardEl(c); pickCard(e, c); blk.append(e); }
          else blk.append(slotOf(c));
        }
        frag.append(blk);
        near.observe(blk);
        far.observe(blk);
      }
    };

    regrid = () => { if (laidCols && gridCols() !== laidCols) paint(); };
    const fill = (gen) => {
      slices.raf = 0;
      if (gen !== slices.gen) return;
      const t0 = performance.now();
      for (const blk of want) {
        let ph = null;
        while (performance.now() - t0 < 8 && (ph = blk.querySelector(":scope > .cardph"))) {
          const c = slotCard.get(ph), e = cardEl(c);
          ph.replaceWith(e);
          if (poolPicking) pickCard(e, c);
          watchCard(e);
        }
        if (!blk.isConnected || !blk.querySelector(":scope > .cardph")) want.delete(blk);
        if (performance.now() - t0 >= 8) break;
      }
      if (want.size) sliceSoon();
    };
    const sliceSoon = () => {
      const gen = slices.gen;
      if (!slices.raf) slices.raf = requestAnimationFrame(() => fill(gen));
    };
    const evict = (blk) => {
      if (!blk.isConnected) return;
      for (const w of blk.querySelectorAll(":scope > .cardwrap:not(.cardph)")) {
        const c = cardByEl.get(w);
        if (!c || built.get(c) !== w) continue;
        if ((listen.el && listen.card && listen.card.id === c.id) || (gifLive && w.contains(gifLive))
            || w.contains(document.activeElement)) continue;
        const a = w.querySelector("article.card");
        if (a) { if (gifObs) gifObs.unobserve(a); gifNear.delete(a); }
        built.delete(c);
        w.replaceWith(slotOf(c));
      }
    };

    const sizeSlots = (type, again = true) => {
      const key = `${type}|${innerWidth}`;
      if (!slotH.has(key)) {
        const one = grid.querySelector(".gblock > .cardwrap:not(.cardph) > article.card");
        const h = one && one.isConnected && one.offsetHeight;

        if (!h) { if (again && one) requestAnimationFrame(() => sizeSlots(type, false)); return; }
        slotH.set(key, h);
      }
      grid.style.setProperty("--card-h", `${slotH.get(key)}px`);
    };
    function paint() {
      const t = (filters.find((f) => f.on) || {}).slug;
      const frag = document.createDocumentFragment();
      slices.gen++;
      want.clear();
      near.disconnect();
      far.disconnect();
      if (archive.on) {

        if (!archive.loading && archive.key !== t) {
          archive.key = t;
          loadArchive().then(paint);
        }
        const list = (archive.cards || []).filter((c) => c.type === t && c.archived);

        frag.append(Object.assign(archiveBtn(), { className: "archbtn archtop wide" }));
        frag.append(el("div.archhead", { text: archive.loading ? "ARCHIVE — loading…"
          : `ARCHIVE · ${list.length} — open one to inspire from it, or unarchive it` }));
        blocks(frag, list);
        frag.append(archiveBtn());
        grid.replaceChildren(frag);
        watchGifs(grid);
        sizeSlots(`archive:${t}`);
        return;
      }

      if (t && cap(t, "panel")) frag.append(panelEntry(t, d));

      if (t && !cap(t, "panel") && cap(t, "auto")) {
        const a = autoEntry(t, d); if (a) frag.append(a);
      }

      if (t) {
        frag.append(gridCups.get(t) || gridCups.set(t, cupEntry(t, d)).get(t));
        const lead = composeCard(t, d);
        if (lead) frag.append(lead);
      }

      const adds = [].concat(t ? cap(t, "add") || [] : []);
      if (adds.includes("idea")) frag.append(addIdeaRow(t, d));
      if (adds.includes("recording")) frag.append(addRecordingRow(t, d));

      const list = d.cards.filter((c) => c.type === t && !c.archived);
      blocks(frag, list);
      if (!list.length)
        frag.append(el("div.gridempty", { text: "No cards here — the rest are in the archive below." }));
      frag.append(archiveBtn());
      grid.replaceChildren(frag);
      for (const gc of gridCups.values()) if (gc.isConnected && gc.keepScroll) gc.keepScroll();

      watchGifs(grid);
      sizeSlots(t || "");

      if (!grid.isConnected) requestAnimationFrame(() => { if (regrid) regrid(); });
      grid.classList.toggle("poolpicking", !!poolPicking);
    }
    paintGrid = paint;
    pickD = d;

    let cardsAt = 0, cardsT = 0;
    d.onCards = () => {
      if (cardsT) return;
      const wait = Math.max(0, cardsAt + 300 - performance.now());
      cardsT = setTimeout(() => { cardsT = 0; cardsAt = performance.now(); paintGrid(); }, wait);
    };
    paint();

    const ubox = el("div.notch");
    const refreshing = new Set();
    const paintUsage = () => {
      const pools = [];
      for (const u of d.usage) {
        let p = pools.find((x) => x.pool === u.pool);
        if (!p) pools.push(p = { pool: u.pool, rows: [] });
        p.rows.push(u);
      }
      ubox.replaceChildren(...pools.map(({ pool, rows }) => {
        const [s5, wk] = rows;

        const row = (u, i) => {
          if (!u) return null;
          const bar = usageBar(u,
          u.column ? `${u.label} ${u.unknown || u.missing || u.capUnknown ? "—" : `${u.pct}%`}`
            : u.missing ? (i ? "" : "no CLI") : u.capUnknown ? `${u.label}:unknown · cap ${u.sessionCap}%`
            : `${u.label}:${u.unknown ? "—" : `${u.pct}%`}`,
          !u.column && u.left && !u.unknown && !u.missing ? u.left : "");
          if (u.column) bar.style.gridRow = u.period === "weekly" ? "2" : "1";
          return bar;
        };

        const columns = [...new Set(rows.map((u) => u.column).filter(Boolean))];
        const content = columns.length
          ? columns.map((column) => el("div.ucol", {"data-pool":column}, rows.filter((u) => u.column === column).map(row)))
          : [row(s5, 0), row(wk, 1)].filter(Boolean);
        const box = el("div.ubox" + (columns.length ? ".columns" : ""), {
          style: columns.length ? `--usage-columns:${columns.length};flex-grow:${Math.max(1, columns.length - 1)}` : null,
          title: `${s5.name || pool}: ` + rows.map((u) => u.caption).join(" · ")
                                            + " — press to read it fresh" },
                       content);
        box.classList.toggle("busy", refreshing.has(s5.src));
        box.onclick = async () => {
          if (!d.refreshUsage || !s5.src || refreshing.has(s5.src)) return;
          refreshing.add(s5.src);
          box.classList.add("busy");
          try { await d.refreshUsage(s5.src); } finally { refreshing.delete(s5.src); paintUsage(); }
        };
        return box;
      }));
    };
    paintUsage();
    d.onUsage = paintUsage;
    state.refreshUsage = d.refreshUsage || (() => {});

    if (!usageTimer && d.refreshUsage) {
      const tick = () => { if (document.visibilityState === "visible") d.refreshUsage(); };
      usageTimer = setInterval(tick, 60000);
      addEventListener("visibilitychange", tick);
    }

    return el("div.wrap", {}, [
      el("section.lbox", {}, [
        ubox,

        el("div.pads", {}, [
          Object.assign(

            iconBtn("cog", { size: BTN, glyph: glyph("sliders", 20).outerHTML,
                             title: "agents: models, wiring, insight" }),
            { onclick: openSettings }),
        ]),
        queueScroller(d, state),
      ]),
      el("div.cardsec", {}, [

        el("div.cardhead", {}, [bar]),
        grid,
      ]),
    ]);
  }

  const mmss = (secs) => {
    const s2 = Math.max(0, Math.round(secs));
    return `${Math.floor(s2 / 60)}:${String(s2 % 60).padStart(2, "0")}`;
  };

  function qrowOf(q, d, after) {
    const run = q.status === "running";
    const draft = q.status === "queued";
    const held = q.status === "paused";
    const origin = (d.cards || []).find((c) => c.id === q.card);
    const m = (origin && origin.media) || {};

    const iss = q.issue;
    const tries = q.attempts > 1 ? `try ${q.attempts}` : null;
    const beat = run

      ? [el("i.qdot"), el("span", { text:
          [q.phase, mmss(Date.now() / 1000 - (q.started || q.created || 0)), tries]
            .filter(Boolean).join(" · ") })]
      : held

        ? [el("span", { text: ["paused", q.paused_from === "running" ? "starts over on ▶" : null]
            .filter(Boolean).join(" · ") })]
      : iss
        ? [el("span.qiss." + iss.level, { text: iss.short })]
        : [el("span", { text: q.status })];

    const ref = origin ? refOf(origin, (origin.versions || []).length - 1) : null;
    const plain = ref ? [ref, q.method].filter(Boolean).join(" · ") : null;

    const auto = q.group === "auto";
    const title = [kindIcon(q.kind, 15),

      q.count > 1 ? el("b.qcount", { text: `×${q.count}` }) : null,
      el("span", { text: auto ? ["AUTO", ref].filter(Boolean).join(" · ")
                              : q.text || plain || "(no note)" })].filter(Boolean);

    const face = (q.attachments || [])[0] || thumb(m.still, 160) || m.gif;

    const row = el("div.qrow", {}, [
      face ? el("img.qthumb", { src: face, alt: "", loading: "lazy" }) : null,
      el("div.qcol", {}, [
        el("div.qtitle", {}, title),
        el("div.qbeat" + (run ? ".run" : ""), {}, beat),

        q.run ? el("div.qrun", { text: [q.run.agent, q.run.model,
          q.run.effort ? `${q.run.effort} effort` : "default effort"]
          .filter(Boolean).join(" · "), title: q.run.planned
          ? "what this job will run with (its agent's ⚙ setting now)"
          : "what this job's agent started with" }) : null,
      ].filter(Boolean)),
    ]);

    if (d.q) {
      row.style.cursor = "pointer";
      row.addEventListener("click", async () => {
        if (!auto) return openJob(q, d, after);
        await openAuto(q.type);
        const head = document.querySelector(".sheet.auto:not([hidden]) .shead");
        if (!head) return openJob(q, d, after);

        if (!head.querySelector(".ajob")) {
          const b = el("button.ajob", { type: "button", text: "this job ›",
                                        title: "the job: its log, why it waits, hand it to another agent" });
          b.onclick = () => { closeSheet("auto"); openJob(q, d, after); };
          head.lastElementChild.before(b);
        }
      });
    }

    const act = (glyphText, title, fn) => {
      const b = el("button.qx", { type: "button", title },
                   typeof glyphText === "string" ? [el("span", { text: glyphText })] : [glyphText]);
      b.onclick = async (ev) => {
        ev.stopPropagation();
        try { await fn(); } catch (e) { toast(e.message); }
        if (after) after();
      };
      return b;
    };

    const pauseBtn = () => act(glyph("pause", 15), run
      ? "pause — stops the agent now; ▶ later starts it over" : "pause — no runner takes it",
      async () => { await d.q.pause(q.id); toast(run ? "paused — its agent is being stopped" : "paused"); });
    if (d.q && held) {
      row.append(act(glyph("play", 16), "resume — back in line", async () => {
        await d.q.resume(q.id); toast("back in line");
      }));

      row.append(act(glyph("arrow", 17), "resume with another agent", () => openJob(q, d, after)));
      row.append(act(glyph("cut", 18), "cancel", () => d.q.cancel(q.id)));
      row.classList.add("q-paused");
      return row;
    }
    if (d.q && (q.status === "waiting" || q.status === "failed")) {
      if (q.status === "waiting") {
        row.append(pauseBtn());
        row.append(act(glyph("arrow", 17), "hand it to another agent", () => openJob(q, d, after)));
      } else {
        row.append(act(glyph("loop", 17), "try again", async () => {
          const r = await d.q.retry(q.id);
          toast(["trying again", r.runner].filter(Boolean).join(" — "));
        }));
        row.append(act(glyph("arrow", 17), "hand it to another agent", () => openJob(q, d, after)));
        row.append(act(glyph("cut", 18), "dismiss", () => d.q.dismiss(q.id)));
      }
      row.classList.add("q-" + q.status);
      return row;
    }
    if ((draft || run) && d.q) {
      row.append(pauseBtn());
      const x = el("button.qx", { type: "button", title: "cancel" }, [glyph("cut", 18)]);
      x.onclick = async (ev) => {
        ev.stopPropagation();
        try { await d.q.cancel(q.id); } catch (e) { console.error("cancel:", e); }
        if (after) after();
      };
      row.append(x);
    }
    return row;
  }

  function queueScroller(d, state) {
    const arm = el("div.qarm");
    const plate = el("div.ph.qplate");
    const paint = () => {
      arm.replaceChildren(...state.q.map((q) =>
        qrowOf(q, d, () => state.refreshQueue && state.refreshQueue())));
      plate.textContent = `QUEUE · ${state.q.length}`;

      const box = wrap.closest(".lbox");
      if (box) box.classList.toggle("noq", state.q.length === 0);
    };
    state.paintQueue = paint;
    const wrap = el("div.qscroll", {}, [arm]);
    wrap.append(scrollIndicator(arm, { inset: t.innerRadius }).el);
    wrap.append(plate);

    paint();
    requestAnimationFrame(paint);
    return wrap;
  }

  function voteCell(sign, vote = 0, onVote = null, base = vote) {
    const active = (sign === "+" && vote > 0) || (sign === "−" && vote < 0);
    const b = el("button.vcell.no-swipe", { type: "button",
      text: active ? sign + Math.abs(vote) : sign });
    if (onVote) {
      b.onclick = (ev) => {
        ev.stopPropagation();
        onVote(Math.max(-3, Math.min(3, (base || 0) + (sign === "+" ? 1 : -1))));
      };
    }
    if (active) {
      const rgb = vote > 0 ? UP : DOWN, m = Math.min(3, Math.abs(vote));
      b.style.cssText = `border-left-color:rgba(${rgb},${EDGE[m]});` +
        `background:rgba(${rgb},${BACK[m]});` +
        `color:rgba(${vote > 0 ? UP_TEXT : DOWN_TEXT},${TEXT[m]})`;
    }
    return b;
  }

  function versionAt(c, n) {
    const vs = c.versions || [];
    return vs[n == null ? shownAt(c) : n] || {};
  }

  function shownAt(c) {
    const vs = c.versions || [];
    for (let i = vs.length - 1; i >= 0; i--) if ((vs[i].vote || 0) >= 0) return i;
    return vs.length - 1;
  }

  function partsOf(c, n) {
    const parts = versionAt(c, n).parts || [];
    const kind = (parts.find((p) => PART_BLOCKS[p.kind]) || {}).kind;
    return kind ? parts.filter((p) => p.kind === kind) : [];
  }

  const hasPicture = (c) => {
    const m = c.media || {};
    return !!(m.gif || m.poster || m.video || m.still);
  };

  function laneBlock(c, ver, opts) {
    const parts = (ver.parts || []).length ? partsOf(c, opts.vn) : [];
    if (!parts.length) return null;

    if (hasPicture(c) && (!opts.controls || !parts.some((p) => p.time)))
      return null;

    const rec = (c.origin || {}).kind === "recording";
    const tint = rec ? RECORDING_YELLOW : null;

    const dur = ver.duration;
    const trim = rec && c.trim && dur ? { a: c.trim.start / dur, b: Math.min(1, c.trim.end / dur) } : null;
    return PART_BLOCKS[parts[0].kind](parts, { ...opts, tint, trim });
  }

  const pausedAt = new Map();
  const listen = { muted: new Set(), mutedFor: null, solo: null, el: null, card: null, ver: null, loading: null,
                   byTurn: false };

  const showCut = new Set();

  const same = (a, b) => !!a && !!b && (a === b || (a.id != null && a.id === b.id));
  const owns = (c, ver = null) => !!listen.el && same(listen.card, c)
    && (ver == null || listen.ver == null || listen.ver === ver);

  function versionSwitched(c) {

    const ld = listen.loading && same(listen.loading.card, c) ? listen.loading : null;
    if (!ld && (!listen.el || !same(listen.card, c))) return null;
    const was = { solo: (ld ? ld.solo : listen.solo) || null };
    c.at = null;
    stopAudio();
    return was;
  }

  const player = {
    el: null,
    get() {
      if (!this.el) {
        this.el = new Audio();
        this.el.preload = "auto";
      }
      return this.el;
    },
  };

  const B = {
    ctx: null, bufs: new Map(), tracks: [], nodes: [], only: null, ls: [],
    _paused: true, _offset: 0, _t0: 0, _raf: 0, duration: 0, onended: null,
    actx() {
      if (!this.ctx) this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      return this.ctx;
    },

    sizes: new Map(), inUse: new Set(), BUDGET: 120e6,
    buf(url) {
      const hit = this.bufs.get(url);
      if (hit) { this.bufs.delete(url); this.bufs.set(url, hit); return hit; }

      const pr = fetch(url)
        .then((r) => { if (!r.ok) throw new Error(r.status); return r.arrayBuffer(); })
        .then((b) => this.actx().decodeAudioData(b))
        .then((ab) => { this.sizes.set(url, ab.length * ab.numberOfChannels * 4); this._trim(); return ab; })
        .catch(() => { this.bufs.delete(url); this.sizes.delete(url); return null; });
      this.bufs.set(url, pr);
      return pr;
    },
    _trim() {
      let total = 0;
      for (const v of this.sizes.values()) total += v;
      for (const url of [...this.bufs.keys()]) {
        if (total <= this.BUDGET) break;
        if (this.inUse.has(url) || !this.sizes.has(url)) continue;
        total -= this.sizes.get(url);
        this.sizes.delete(url); this.bufs.delete(url);
      }
    },
    get paused() { return this._paused; },
    get currentTime() {
      return this._paused ? this._offset
        : Math.min(this.duration, this.actx().currentTime - this._t0 + this._offset);
    },
    set currentTime(t) {
      const was = !this._paused;
      if (was) this._stopNodes();
      this._offset = Math.max(0, Math.min(this.duration, t));
      if (was) this._startNodes();
      setTimeout(() => this._fire("seeked"), 0);
    },
    addEventListener(type, fn) { this.ls.push([type, fn]); },
    _fire(type) {
      const now = this.ls.filter((x) => x[0] === type);
      this.ls = this.ls.filter((x) => x[0] !== type);
      now.forEach((x) => x[1]());
    },
    load(tracks, only) {
      this._stopNodes();
      this.tracks = tracks; this.only = only;
      this.duration = Math.max(...tracks.map((t) => t.buf.duration));
      this._offset = 0; this._paused = true;
    },
    gainOf(id) { return this.only ? 1 : (listen.muted.has(id) ? 0 : 1); },
    setGain(id, v) {
      const n = this.nodes.find((x) => x.id === id);
      if (n) n.g.gain.setTargetAtTime(v, this.actx().currentTime, 0.012);
    },
    _startNodes() {
      const ctx = this.actx();
      const t0 = ctx.currentTime + 0.03;
      this.nodes = this.tracks.map((t) => {
        const src = ctx.createBufferSource(); src.buffer = t.buf;
        const g = ctx.createGain(); g.gain.value = this.gainOf(t.id);
        src.connect(g); g.connect(ctx.destination);
        src.start(t0, Math.min(this._offset, Math.max(0, t.buf.duration - 0.001)));
        return { id: t.id, src, g };
      });
      this._t0 = t0; this._paused = false;
      const loop = () => {
        if (this._paused) return;
        const now = this.currentTime;
        if (listen.el === this && listen.card) {
          listen.card.at = this.duration ? now / this.duration : 0;
          if (listen.tick) listen.tick(listen.card.at);
        }
        if (now >= this.duration - 0.01) {
          this._stopNodes(); this._paused = true; this._offset = 0;
          if (this.onended) this.onended();
          return;
        }
        this._raf = requestAnimationFrame(loop);
      };
      this._raf = requestAnimationFrame(loop);
    },
    _stopNodes() {
      cancelAnimationFrame(this._raf);
      for (const n of this.nodes) {
        try { n.src.stop(); } catch (_) {}
        try { n.src.disconnect(); n.g.disconnect(); } catch (_) {}
      }
      this.nodes = [];
    },
    pause() { if (this._paused) return; this._offset = this.currentTime; this._stopNodes(); this._paused = true; },
    play() {
      if (this._paused) { this.actx().resume().catch(() => {}); this._startNodes(); }
      return Promise.resolve();
    },
    stop() { this._stopNodes(); this._paused = true; this.onended = null; this.ls = []; },
  };
  function preloadBands(parts) { for (const p of parts) if (p.audio) B.buf(p.audio); }

  let bandGen = 0;
  async function playBands(c, parts, { tick = null, done = null, from = 0, only = null, ver = null } = {}) {
    stopAudio();
    const gen = bandGen;

    listen.loading = { card: c, solo: only };
    try { await B.actx().resume(); } catch (_) {}
    const list = parts.filter((p) => p.audio && (!only || p.id === only));
    const bufs = await Promise.all(list.map((p) => B.buf(p.audio)));
    if (gen !== bandGen) return false;
    listen.loading = null;
    B.inUse = new Set(list.map((p) => p.audio));
    const tracks = list.map((p, i) => ({ id: p.id, buf: bufs[i] })).filter((t) => t.buf);

    const lost = list.filter((_, i) => !bufs[i]).map((p) => p.label || p.id);
    if (lost.length) toast(`couldn't load ${lost.join(", ")} — playing without ${lost.length > 1 ? "them" : "it"}; ▶ again to retry`);
    if (!tracks.length) { if (done) done(); return false; }
    B.load(tracks, only);
    B.onended = () => { c.at = null; stopAudio({ playlist: false }); if (done) done(); };
    listen.el = B; listen.card = c; listen.tick = tick || null; listen.solo = only; listen.ver = ver;
    B._offset = Math.max(0, Math.min(B.duration, from));
    B.play();
    return true;
  }

  const rank = { el: null, id: null, raf: 0 };

  const rankRowOf = (id) => document.querySelector(`.rkrow[data-cid="${CSS.escape(id)}"], .aulog[data-rk="${CSS.escape(id)}"]`);
  function rankStop() {
    cancelAnimationFrame(rank.raf);
    if (rank.el) { rank.el.onended = null; try { rank.el.pause(); } catch (_) {} }
    rank.id = null;
    for (const e of document.querySelectorAll(".rkrow .rkfill, .aulog[data-rk] .aurfill")) e.style.width = "0";
    for (const e of document.querySelectorAll(".rkplay.on, .aulog[data-rk] .auplay.on")) e.classList.remove("on");
    for (const e of document.querySelectorAll(".aulog[data-rk].on")) e.classList.remove("on");
    for (const e of document.querySelectorAll(".aulog[data-rk] .vline")) e.remove();
  }
  function rankPlay(id, src, from = null) {
    if (rank.id === id && from == null) { stopAudio(); return; }
    stopAudio();
    rank.el = rank.el || new Audio();
    rank.el.src = src;
    if (from != null) rank.el.addEventListener("loadedmetadata", () => {
      try { rank.el.currentTime = from * rank.el.duration; } catch (_) {}
    }, { once: true });
    rank.el.onended = () => stopAudio();
    rank.el.play().catch(() => stopAudio());
    rank.id = id;
    const tick = () => {
      if (rank.id !== id) return;
      const a = rank.el, d = a.duration, at = d > 0 ? Math.min(1, a.currentTime / d) : 0;
      const row = rankRowOf(id);
      if (row) {
        const b = row.querySelector(".rkplay, .auplay");
        if (b) b.classList.add("on");
        if (row.classList.contains("aulog")) row.classList.add("on");
        const name = row.querySelector(".rkname, .auseek");
        let line = name.querySelector(".vline");
        if (!line) { line = el("i.vline"); name.append(line); }
        line.style.left = `${(at * 100).toFixed(2)}%`;
        line.dataset.t = clock(a.currentTime);
        line.classList.toggle("r", at > 0.6);
        const fill = name.querySelector(".rkfill, .aurfill");
        if (fill) fill.style.width = `${(at * 100).toFixed(2)}%`;
      }
      rank.raf = requestAnimationFrame(tick);
    };
    rank.raf = requestAnimationFrame(tick);
  }

  function rankScrub(strip, pc) {
    let pid = null, sx = 0, sy = 0, dragging = false;
    const frac = (x) => { const r = strip.getBoundingClientRect(); return Math.max(0, Math.min(1, (x - r.left) / Math.max(1, r.width))); };
    const seekTo = (f) => {
      if (rank.id !== pc.id) { rankPlay(pc.id, pc.audio, f); return; }
      const a = rank.el;
      if (a && a.duration) try { a.currentTime = f * a.duration; } catch (_) {}
    };
    strip.addEventListener("pointerdown", (e) => {
      if (!pc.audio || e.button) return;
      pid = e.pointerId; sx = e.clientX; sy = e.clientY; dragging = false;
      delete strip.dataset.swallow;
      if (e.target.closest(".vline")) { dragging = true; try { strip.setPointerCapture(pid); } catch (_) {} e.preventDefault(); }
    });
    strip.addEventListener("pointermove", (e) => {
      if (e.pointerId !== pid) return;
      if (!dragging) {
        const dx = Math.abs(e.clientX - sx), dy = Math.abs(e.clientY - sy);
        if (dx < 4 || dx <= dy) return;
        dragging = true;
        try { strip.setPointerCapture(pid); } catch (_) {}
      }
      e.preventDefault();
      seekTo(frac(e.clientX));
    });
    strip.addEventListener("pointerup", (e) => {
      if (e.pointerId !== pid) return;
      if (dragging) { seekTo(frac(e.clientX)); strip.dataset.swallow = "1"; }
      else if (rank.id === pc.id) { seekTo(frac(e.clientX)); strip.dataset.swallow = "1"; }
      pid = null; dragging = false;
    });
    strip.addEventListener("pointercancel", () => { pid = null; dragging = false; });
  }

  function stopAudio({ playlist: pl = true } = {}) {
    /* Invalidate callbacks before stopping the shared player and band decoders. */
    playGen++;
    rankStop();
    listen.byTurn = false;
    if (pl) for (const p of panels.values()) p.pause();
    bandGen++;
    listen.loading = null;
    B.stop();
    const a = player.el;
    if (a) {

      a.onended = a.onerror = a.ontimeupdate = a.onseeked = a.onplaying = null;
      try { a.pause(); } catch (_) {}
    }
    listen.el = null;
    listen.solo = null;
    listen.tick = null;
    listen.ver = null;
    listen.seg = null;

    for (const e of document.querySelectorAll(".vline")) e.remove();
    for (const e of document.querySelectorAll(".vplay.on, .abplay.on")) e.classList.remove("on");

    for (const e of document.querySelectorAll(".origpb.on")) e.classList.remove("on");
  }

  function scrubbable(block, card, url, pb, repaint, tapSeeks, starter = null, ver = null) {
    let at = null, scrubbing = false, sx = 0, sy = 0, swallow = false;
    let wasPlaying = false;

    const fracOf = (clientX) => {
      const g = laneBox(block) || (() => {
        const r = block.getBoundingClientRect();
        return { left: r.left, width: r.width };
      })();
      return Math.max(0, Math.min(1, (clientX - g.left) / Math.max(1, g.width)));
    };
    const seek = (f, { quiet = false } = {}) => {
      const a = listen.el;
      if (a && owns(card, ver) && a.duration) {
        listen.tick = lineIn(block);
        lineIn(block)(f);

        if (quiet) {
          try { a.currentTime = f * a.duration; } catch (_) {}
          return;
        }
        const wasPlaying = !a.paused;
        try {
          if (wasPlaying) a.pause();
          a.currentTime = f * a.duration;
        } catch (_) {}

        if (wasPlaying) {
          let resumed = false;
          const go = () => { if (!resumed) { resumed = true; a.play().catch(() => {}); } };
          a.addEventListener("seeked", go, { once: true });
          setTimeout(go, 300);
        }
        return;
      }

      if (starter) { starter(f); if (pb) pb.classList.add("on"); return; }
      play(card, url, { tick: lineIn(block), ver,
                        done: () => { if (pb) pb.classList.remove("on");
                                      if (repaint) repaint(); } });
      if (pb) pb.classList.add("on");
      const a2 = listen.el;
      if (a2) a2.addEventListener("loadedmetadata", () => {
        try { a2.currentTime = f * a2.duration; } catch (_) {}
      }, { once: true });
    };

    const begin = () => {
      scrubbing = true;
      try { block.setPointerCapture(at); } catch (_) {}

      const a0 = listen.el;
      if (a0 && owns(card, ver)) {
        wasPlaying = !a0.paused;
        try { a0.pause(); } catch (_) {}
      }
    };

    block.scrub = {
      start() {
        const a0 = listen.el;
        wasPlaying = !!(a0 && owns(card, ver) && !a0.paused);
        if (wasPlaying) try { a0.pause(); } catch (_) {}
      },
      move(f) { if (listen.el && owns(card, ver)) seek(f, { quiet: true }); else lineIn(block)(f); },
      end(f) {
        const a1 = listen.el;
        if (!(a1 && owns(card, ver))) { seek(f); return; }
        seek(f, { quiet: true });
        if (wasPlaying) a1.play().catch(() => {});
      },
    };
    block.addEventListener("pointerdown", (e) => {
      if (e.button || e.target.closest(".vc, .vplay, .nparams, .tl-clip, .sname.tag")) return;
      at = e.pointerId; scrubbing = false; sx = e.clientX; sy = e.clientY;

      swallow = false;

      if (e.target.closest(".vline")) { begin(); e.preventDefault(); }
    });
    block.addEventListener("pointermove", (e) => {
      if (e.pointerId !== at) return;
      if (!scrubbing) {
        const dx = Math.abs(e.clientX - sx), dy = Math.abs(e.clientY - sy);
        if (dx < 4 || dx <= dy) return;
        begin();
      }
      e.preventDefault();
      seek(fracOf(e.clientX), { quiet: true });
    });
    const end = (e) => {
      if (e.pointerId !== at) return;
      if (scrubbing) {
        swallow = true;
        seek(fracOf(e.clientX), { quiet: true });
        const a1 = listen.el;
        if (a1 && owns(card, ver) && wasPlaying) a1.play().catch(() => {});
      } else if (tapSeeks) seek(fracOf(e.clientX));
      try { block.releasePointerCapture(at); } catch (_) {}
      at = null; scrubbing = false;
    };
    block.addEventListener("pointerup", end);
    block.addEventListener("pointercancel", () => { at = null; scrubbing = false; });

    block.addEventListener("click", (e) => {
      if (!swallow) return;
      swallow = false;
      e.stopPropagation();
      e.preventDefault();
    }, true);
  }

  function laneBox(block) {
    const lane = block && block.querySelector && block.querySelector(".lane");
    if (!lane) return null;
    const b = block.getBoundingClientRect(), l = lane.getBoundingClientRect();
    if (!l.width) return null;
    return { offset: l.left - b.left, width: l.width, left: l.left };
  }

  function lineIn(box) {
    const put = (at) => {
      const m = (box && box.isConnected) ? box
              : document.querySelector(".sheet.big .vblock");
      if (!m) return;
      let line = m.querySelector(".vline");
      if (!line) { line = el("i.vline"); m.append(line); }
      const g = laneBox(m), x = m.abX ? m.abX(at) : null;
      line.style.left = x != null ? `${x.toFixed(1)}px`
                      : g ? `${(g.offset + at * g.width).toFixed(1)}px`
                          : `${(at * 100).toFixed(1)}%`;
      stampLine(line, m, at);
    };
    put.box = box;
    return put;
  }

  let playGen = 0;
  function play(c, url, { tick = null, done = null, from = null, to = null, ver = null } = {}) {
    stopAudio();
    if (!url) { if (done) done(); return; }
    const a = player.get();

    const gen = ++playGen;
    /* The audio element is reused; callbacks must belong to this play generation. */
    const live = () => gen === playGen && listen.el === a;

    if (from != null) {
      const seek = () => { if (gen === playGen) try { a.currentTime = from; } catch (_) {} };
      if (a.getAttribute("src") === url && a.readyState >= 1) seek();
      else a.addEventListener("loadedmetadata", seek, { once: true });
    }
    if (to != null) {
      const watch = () => {
        if (!live()) return;
        if (a.currentTime >= to) { c.at = null; stopAudio(); if (done) done(); return; }
        requestAnimationFrame(watch);
      };
      requestAnimationFrame(watch);
    }

    if (a.getAttribute("src") !== url) a.setAttribute("src", url);
    listen.el = a; listen.card = c; listen.ver = ver;

    listen.tick = tick || null;
    a.ontimeupdate = () => {
      if (!a.duration) return;
      const k = listen.card || c;
      k.at = a.currentTime / a.duration;
      if (listen.tick) listen.tick(k.at);
    };

    let frames = false;
    const frame = () => {
      if (!live() || a.paused || a.ended) { frames = false; return; }
      if (a.ontimeupdate) a.ontimeupdate();
      requestAnimationFrame(frame);
    };
    a.onplaying = () => { if (gen === playGen && !frames) { frames = true; requestAnimationFrame(frame); } };
    const end = () => {
      if (gen !== playGen) return;
      if (listen.card) listen.card.at = null; c.at = null; stopAudio({ playlist: false }); if (done) done();
    };
    a.onended = end;
    a.onerror = end;
    a.play().catch(end);
  }

  function cutNote(c, version, repaint) {
    const n = partsOf(c, version).filter((p) => p.kind === "voice" && p.archived).length;
    if (!n) return null;
    const shown = showCut.has(c.id);
    const b = el("button.vcutnote", { type: "button",
      title: shown ? "hide the bands taken out" : "show the bands taken out — ✕ on one puts it back",
      text: `${n} band${n > 1 ? "s" : ""} taken out · ${shown ? "hide" : "show"}` });
    b.onclick = (e) => {
      e.stopPropagation();
      shown ? showCut.delete(c.id) : showCut.add(c.id);
      if (repaint) repaint();
    };
    return b;
  }

  function fullButton(c) {
    const b = el("button.vfull", { type: "button" });
    const paint = (on) => {
      b.replaceChildren(glyph(on ? "unfull" : "full", 20));
      b.title = on ? "back to the whole card" : "only the bands, in the whole card";
      b.setAttribute("aria-label", b.title);
    };
    paint(!!document.querySelector(".sheet.big:not([hidden]) .sbody.lanesonly"));
    requestAnimationFrame(() => { const body = b.closest(".sbody"); if (body) paint(body.classList.contains("lanesonly")); });
    b.onclick = (e) => {
      e.stopPropagation();
      const body = b.closest(".sbody");
      if (!body) return;
      paint(body.classList.toggle("lanesonly"));
      const pa = pausedAt.get(c.id);
      if (pa) requestAnimationFrame(() => lineIn(null)(pa.at));
    };
    return b;
  }

  function mediaOf(c, d, { controls = false, version = null, repaint = null,
                          video = false, view = null, autoplay = null } = {}) {
    const ver = versionAt(c, version);

    if (video && (ver.media || {}).video) {
      const box = el("div.media.video", { style: "position:relative" });
      const v = el("video", { src: ver.media.video, controls: "", autoplay: "",
                              playsinline: "", loop: "",
                              poster: (ver.media || {}).poster || "" });
      const back = el("div.vback", {}, glyph("prev", 18));
      back.title = "back to the layers";
      back.onclick = (e) => { e.stopPropagation(); if (repaint) repaint(false); };
      box.append(v, back);
      return box;
    }

    const vm = ver.media || {};
    if (controls && vm.video && vm.poster && !(ver.parts || []).length) {
      const box = el("div.media.poster", { style: "position:relative" });
      box.append(el("img", { src: thumb(vm.poster, 1280), alt: "the version's picture" }));
      const pb = el("div.vplay", {}, glyph("play", 22));
      pb.title = "play this version";
      pb.onclick = (e) => { e.stopPropagation(); if (repaint) repaint(true); };
      box.append(pb);
      return box;
    }

    const abOn = !!cap(c.type, "ab") && !!((ver.media || {}).ab || (ver.media || {}).reference);
    const bandParts = controls && !abOn ? partsOf(c, version).filter((p) => p.kind === "voice" && p.audio && !p.archived) : [];
    if (bandParts.length) preloadBands(bandParts);

    const allCut = controls && !abOn && !bandParts.length
      && partsOf(c, version).some((p) => p.kind === "voice" && p.audio);

    const block = abOn ? abBlock(c, ver, { controls, stop: stopAudio,
      seg: (from, to, done, which) => {
        play(c, ver.media.ab || ver.media.reference, { from, to, tick: lineIn(block), ver: ver.id, done });
        listen.seg = which;
      },
      playing: () => (owns(c, ver.id) ? listen.seg : null) }) : laneBlock(c, ver, {
      at: c.at, controls, duration: ver.duration, vn: version, state: listen,
      showCut: controls && showCut.has(c.id),

      on: (act, p, btn) => {

        const scoped = ver.bundleItem ? { version: ver.n, item: ver.bundleItem } : {};

        if (act === "tag") {
          btn.dispatchEvent(new CustomEvent("lanetag", { bubbles: true, detail: p.id }));
          return;
        }
        if (act === "mute") {
          const m = !listen.muted.has(p.id);
          m ? listen.muted.add(p.id) : listen.muted.delete(p.id);

          if (listen.el === B && same(listen.card, c) && !listen.solo) B.setGain(p.id, m ? 0 : 1);
          if (repaint) repaint();
        } else if (act === "solo") {
          if (listen.solo === p.id) { stopAudio(); c.at = null; if (repaint) repaint(); }
          else {
            playBands(c, bandParts.some((q) => q.id === p.id) ? bandParts : [p],
                      { only: p.id, tick: lineIn(block), done: repaint })
              .then(() => { if (repaint) repaint(); });
          }
        } else if (act === "src") {
          if (p.src) openCode(p);
        } else if (act === "clip") {

          addToArrangement(c, d, p, btn, ver);
        } else if (act === "params") {

          const box = btn.closest(".vblock");
          if (!box) return;
          const open = box.querySelector(".nparams");
          if (open) { const same = open.dataset.for === p.id; open.remove(); if (same) return; }
          const panel = paramPanel(p);
          panel.dataset.for = p.id;
          box.append(panel);
        } else if (act === "cut") {

          if (!p.archived && listen.el === B && same(listen.card, c) && !listen.solo) B.setGain(p.id, 0);
          writeSignal(c, d, { kind: "archive", voice: p.id, value: !p.archived, ...scoped },
                      () => { if (repaint) repaint(); });
        }
      },
    });

    if (block) {

      const pb = el("div.vplay", {}, playGlyphs(controls ? 22 : abOn ? 20 : 15));

      if (owns(c, ver.id) && !listen.solo) pb.classList.add("on");
      const vid = (ver.media || {}).video;

      const audio = abOn ? ver.media.ab || ver.media.reference : (ver.media || {}).audio;

      pb.title = vid && controls ? "play this version" : abOn ? "A/B: the reference, then this version"
               : audio ? "play the mix" : "nothing to play";

      const startMix = () => {

        const span = (c.origin || {}).kind === "recording" && c.trim
          ? { from: c.trim.start, to: c.trim.end } : {};
        const fin = () => { pb.classList.remove("on"); if (repaint) repaint(); };
        if (allCut && !span.from) { toast("every band is taken out — nothing to play"); return; }

        const pa = pausedAt.get(c.id);
        const r = pa && pa.ver === ver.id && pa.at > 0 && pa.at < 0.995
          ? (pa.secs != null ? pa.secs : pa.at * (ver.duration || 0)) : 0;
        pausedAt.delete(c.id);
        if (controls && bandParts.length && !span.from) {
          playBands(c, bandParts, { tick: lineIn(block), done: fin, ver: ver.id, from: r })
            .then((ok) => { if (ok) pb.classList.add("on"); });
        } else {
          if (!audio) return;
          play(c, audio, { tick: lineIn(block), ...span, ...(r ? { from: Math.max(span.from || 0, r) } : {}),
                           done: fin, ver: ver.id });
        }
        pb.classList.add("on");
      };
      if (vid || audio || allCut) {
        pb.onclick = (e) => {
          e.stopPropagation();

          if (vid && controls) { if (repaint) repaint(true); return; }

          if (owns(c, ver.id) && listen.solo === null) {
            const at = c.at;

            const secs = listen.el && Number.isFinite(listen.el.currentTime) ? listen.el.currentTime : null;
            stopAudio();
            pausedAt.set(c.id, { ver: ver.id, at, secs });
            c.at = at;

            if (at != null) requestAnimationFrame(() => lineIn(block)(at));
            return;
          }
          startMix();
        };
      }

      if (autoplay && (audio || bandParts.length)) requestAnimationFrame(() => {
        if (!block.isConnected) return;
        const sp = autoplay.solo && (ver.parts || []).find((q) => q.id === autoplay.solo && q.audio);
        if (sp && controls) {
          playBands(c, bandParts.some((q) => q.id === sp.id) ? bandParts : [sp],
                    { only: sp.id, tick: lineIn(block), done: repaint, ver: ver.id })
            .then(() => { if (repaint) repaint(); });
        } else startMix();
      });
      if (audio) {
        block.dataset.audio = audio;
        scrubbable(block, c, audio, pb, repaint, controls,
          allCut ? () => toast("every band is taken out — nothing to play")
          : controls && bandParts.length
            ? (f) => playBands(c, bandParts, { tick: lineIn(block), from: f * (ver.duration || 0),
                                               ver: ver.id,
                                               done: () => { pb.classList.remove("on"); if (repaint) repaint(); } })
            : null, ver.id);

        if (!controls && owns(c, ver.id)) requestAnimationFrame(() => {
          if (!block.isConnected || !owns(c, ver.id)) return;
          const t = listen.tick;
          const gone = t && t.box && !t.box.isConnected
            && !document.querySelector(".sheet.big:not([hidden]) .vblock");
          if (t && !gone) return;
          if (listen.card !== c) { c.at = listen.card.at; listen.card = c; }
          const put = lineIn(block);
          listen.tick = put;
          put(c.at || 0);
        });
      }
      if (!controls) {

        (abOn && block.querySelector(".aball") || block).append(pb);
        return block;
      }

      const wrap = el("div.vwrap");
      wrap.append(el("div.vscroll", {}, [block, cutNote(c, version, repaint)]));
      if (!abOn) wrap.append(pb);
      if (!abOn) wrap.append(fullButton(c));

      if (owns(c, ver.id)) {
        const put = lineIn(block);
        listen.tick = put;
        requestAnimationFrame(() => put(c.at || 0));
      }
      return wrap;
    }

    const base = ver.media || c.media || {};
    const pick = view != null && (base.views || [])[view];

    const m = cardMedia({ ...c, media: pick ? { ...base, still: pick.still || base.still,
                                                 gif: pick.gif } : base },
                        { w: controls ? 1280 : 360 });
    m.style.position = "relative";
    return m;
  }

  const merge = (c, fresh) => { Object.assign(c, fresh); if (!fresh.small) delete c.small; return c; };
  const wholes = new WeakMap();
  function whole(c) {
    if (!c.small) return Promise.resolve(c);
    if (!wholes.has(c)) {
      const p = fetch(`/api/cards/${encodeURIComponent(c.id)}`, { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`→ ${r.status}`))))
        .then((fresh) => merge(c, fresh));
      p.catch(() => wholes.delete(c));
      wholes.set(c, p);
    }
    return wholes.get(c);
  }

  async function writeSignal(c, d, body, after, failed) {
    try {
      const fresh = await d.signal(c.id, body);
      merge(c, fresh);

      const now = (d.cards || []).find((x) => x.id === c.id && x !== c);
      if (now) { merge(now, fresh); forgetCard(now); paintGrid(); }
      if (after) after();
    } catch (e) {
      console.error("signal:", e);

      toast(/→ 404/.test(e.message)
        ? `${c.id} isn't a card any more (folded into a stack?) — reload the page`
        : `not saved: ${e.message}`);
      if (failed) failed();
    }
  }

  /* How the panel repaints the grid card beneath it. Weak, so a card that leaves
     the grid takes its entry with it. */
  const foots = new WeakMap();

  let paintGrid = () => {};

  let rebuildCard = () => {};

  let spawnNow = null;

  let poolPicking = null;
  let pickD = null;
  function pickCard(w, c) {
    const a = w && (w.matches("article.card") ? w : w.querySelector("article.card:not(.compose)"));
    if (!a) return;
    let b = a.querySelector(":scope > .ppick");
    if (!poolPicking || !c || c.type !== poolPicking) {
      if (b) { b.remove(); a.classList.remove("inpool"); }
      return;
    }
    const inPool = (c.pools || []).includes("auto");
    if (!b) {
      b = el("button.ppick.no-swipe", { type: "button" }, glyph("pool", 20));
      b.onclick = (ev) => {
        ev.stopPropagation();
        const now = (c.pools || []).includes("auto");
        writeSignal(c, pickD, { kind: "pool", pool: "auto", value: !now }, () => { pickCard(a, c); autoChanged(); });
      };
      a.append(b);
    }
    b.classList.toggle("on", inPool);
    b.title = inPool ? "in the auto pool — tap to take it out" : "add it to the auto pool";
    a.classList.toggle("inpool", inPool);
  }

  function syncPoolPicks() {
    const g = document.querySelector(".grid");
    if (!g || !pickD) return;
    g.classList.toggle("poolpicking", !!poolPicking);
    const byId = new Map((pickD.cards || []).map((x) => [x.id, x]));
    for (const a of g.querySelectorAll("article.card[data-cid]:not(.compose)")) pickCard(a, byId.get(a.dataset.cid));
  }

  function poolPickBtn(type) {
    const b = el("button.poolpickb" + (poolPicking === type ? ".on" : ""), { type: "button",
      text: poolPicking === type ? "done" : "pick",
      title: poolPicking === type ? "stop picking the auto pool on the grid"
                                  : "pick the auto pool on the grid: a toggle in each card's corner" });
    b.onclick = (ev) => {
      ev.stopPropagation();
      poolPicking = poolPicking === type ? null : type;
      b.classList.toggle("on", poolPicking === type);
      b.textContent = poolPicking === type ? "done" : "pick";
      syncPoolPicks();
    };
    return b;
  }

  function poolClearBtn(type) {
    const pooled = () => ((pickD && pickD.cards) || []).filter((x) => x.type === type && (x.pools || []).includes("auto"));
    const b = el("button.poolpickb.poolclearb", { type: "button", text: "clear", title: "take every card out of the auto pool" });
    let armed = 0;
    b.onclick = async (ev) => {
      ev.stopPropagation();
      const cs = pooled();
      if (!cs.length) return;
      if (!armed) {
        b.textContent = `clear ${cs.length}?`;
        b.classList.add("armed");
        armed = setTimeout(() => { armed = 0; b.textContent = "clear"; b.classList.remove("armed"); }, 3000);
        return;
      }
      clearTimeout(armed); armed = 0;
      b.disabled = true;
      for (const c of cs) await writeSignal(c, pickD, { kind: "pool", pool: "auto", value: false });
      syncPoolPicks();
      autoChanged();
      toast(`the auto pool is empty — AUTO makes from every active card`);
    };
    return b;
  }

  function refOf(c, i) {
    const vs = c.versions || [];
    const p0 = vs.length > 1 ? (((vs[i] || {}).parts || [])[0] || {}) : {};

    const part = p0.kind !== "voice" ? p0.id : null;

    if (!part && namePrefix(c.type) && c.name) return `${namePrefix(c.type)}:${c.name}`;
    return part && part !== c.id ? part : c.id;
  }

  function nameFor(d, c) {
    const id = typeof c === "string" ? c : c && c.id;
    const fc = (d.cards || []).find((x) => x.id === id) || (typeof c === "object" ? c : null);
    return fc ? refOf(fc, shownAt(fc)) : id;
  }

  const drafts = new Map();
  const DRAFT = (id) => `draft.${id}`;
  function draftGet(id) {
    if (drafts.has(id)) return drafts.get(id);
    try { return localStorage.getItem(DRAFT(id)) || ""; } catch (_) { return ""; }
  }
  function draftSet(id, text) {
    drafts.set(id, text);
    try {
      if (text) localStorage.setItem(DRAFT(id), text); else localStorage.removeItem(DRAFT(id));
    } catch (_) {}
  }

  let deepLinked = false;
  function deepLink(d, spawn) {
    if (deepLinked) return;
    const q = new URLSearchParams(location.search), id = q.get("card");
    if (q.has("walk")) {                                  // a link that opens on the walkthrough
      const u = new URL(location.href); u.searchParams.delete("walk");
      history.replaceState(null, "", u.pathname + u.search + u.hash);
      requestAnimationFrame(() => startWalk(0));
    }
    if (!id) { deepLinked = true; return; }
    deepLinked = true;
    const u = new URL(location.href); u.searchParams.delete("card");
    history.replaceState(null, "", u.pathname + u.search + u.hash);

    const have = (d.cards || []).find((x) => x.id === id || (x.name && `${namePrefix(x.type)}:${x.name}` === id));
    (have ? Promise.resolve(have)
          : fetch(`/api/cards/${encodeURIComponent(id)}`, { cache: "no-store" })
              .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`no card ${id}`)))))
      .then((c) => requestAnimationFrame(() => openCard(c, d, spawn)))
      .catch((e) => toast(e.message));
  }

  let forgetCard = () => {};

  let onTypes = () => [];

  let toastT = 0;
  let usageTimer = 0;

  let refreshQ = null;

  let storeD = null, storeSeen = null, storeTimer = 0, eventsOpen = false;

  let storeBusy = false;
  async function lookStore() {
    const d = storeD;
    if (!d || !d.stamp || document.visibilityState !== "visible" || storeBusy) return;
    storeBusy = true;
    try {
      const s = await d.stamp();
      if (s == null) return;
      if (storeSeen == null) storeSeen = s;
      else if (s !== storeSeen && d.reload) {
        try { await d.reload(onTypes()); storeSeen = s; paintGrid(); }
        catch (e) { console.warn("reload:", e.message); }
      }
    } finally { storeBusy = false; }
    if (refreshQ) refreshQ();
  }

  function watchStore(d) {
    /* Keep polling as a fallback when the event stream is unavailable. */
    storeD = d;
    if (storeTimer) return;
    storeTimer = setInterval(lookStore, 120000);
    addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") lookStore(); });
    lookStore();
    if (typeof EventSource !== "function") return;
    let es = null;
    const open = () => {
      es = new EventSource("/api/events");
      es.onopen = () => { eventsOpen = true; };
      es.onerror = () => { eventsOpen = false; if (refreshQ) refreshQ(); };
      es.addEventListener("queue", () => { if (refreshQ) refreshQ(); });
      es.addEventListener("cards", () => lookStore());
    };

    addEventListener("pagehide", () => { if (es) es.close(); es = null; eventsOpen = false; });
    addEventListener("pageshow", (e) => { if (e.persisted && !es) { open(); lookStore(); } });
    open();
  }
  function toast(text) {
    let t = document.querySelector(".ptoast");
    if (!t) { t = el("div.ptoast"); document.body.append(t); }
    t.textContent = text;
    clearTimeout(toastT);
    toastT = setTimeout(() => t.remove(), 2600);
  }

  function cardOf(c, d, spawn) {
    /* Reserve the full fan footprint so cards of different version counts align. */
    const wrap = el("div.cardwrap");

    const layers = Math.min(5, Math.max(1, (c.versions || []).length));

    wrap.style.setProperty("--stack-extra", "calc(4 * var(--stack-step))");
    for (let layer = layers - 1; layer >= 1; layer--) {
      const o = el("i.fan", { "aria-hidden": "true" });
      o.style.setProperty("--layer", String(layer));
      wrap.append(o);
    }

    const nv = (c.versions || []).length;

    const was = stepped.get(c), wi = was == null ? -1 : (c.versions || []).findIndex((v) => v.id === was);
    let shown = wi >= 0 ? wi : shownAt(c);
    const withNav = (m) => {
      if (nv < 2) return m;
      if (!m.style.position) m.style.position = "relative";
      const nav = (dir, glyphText, label) => {
        const b = el(`button.vnav.no-swipe.${dir}`, { type: "button", title: label }, [glyphText]);
        b.disabled = dir === "prev" ? shown <= 0 : shown >= nv - 1;
        b.onclick = (ev) => {
          ev.stopPropagation();
          const to = shown + (dir === "prev" ? -1 : 1);
          if (to < 0 || to >= nv) return;
          showVersion(to);
        };
        return b;
      };
      m.append(nav("prev", glyph("prev", 22), "previous version"), nav("next", glyph("next", 22), "next version"));
      return m;
    };
    let media = withNav(mediaOf(c, d, { version: shown }));
    const showVersion = (to) => {
      shown = to;
      stepped.set(c, ((c.versions || [])[to] || {}).id);

      const turn = gifLive && (gifLive === wrap || wrap.contains(gifLive));
      const was = versionSwitched(c);
      const next = withNav(mediaOf(c, d, { version: shown, autoplay: turn ? null : was }));
      media.replaceWith(next);
      media = next;
      footPaint();
      if (turn) gifPlay(gifLive);
    };

    const shownVote = () => (nv > 1 ? ((c.versions || [])[shown] || {}).vote || 0 : c.vote || 0);
    const setVote = (v) => {
      const ver = nv > 1 ? ((c.versions || [])[shown] || {}).n ?? shown + 1 : null;
      const was = c.vote || 0;
      writeSignal(c, d, ver != null ? { kind: "vote", value: v, version: ver }
                                     : { kind: "vote", value: v }, () => {
        settle();

        if (ver != null && (c.vote || 0) === was)
          toast(`${refOf(c, shown)}: ${v > 0 ? "+" : ""}${v} · stack ${was > 0 ? "+" : ""}${was}`);
      });
    };
    const footEl = el("div.cfoot");

    const copyBtn = () => {
      const b = el("button.ccopy.no-swipe", { type: "button", title: "copy the name",
                                              "aria-label": "copy the name" }, glyph("copy", 11));
      b.onclick = async (ev) => {
        ev.stopPropagation();
        const ref = refOf(c, shown);
        try { await navigator.clipboard.writeText(ref); toast(`copied ${ref}`); }
        catch (_) { toast(ref); }
      };
      return b;
    };
    const footPaint = () => footEl.replaceChildren(

      el("div.lbl", {}, [
        el("div.ctitle.cref", { text: refOf(c, shown), title: c.label }),
        copyBtn(),
      ]),

      voteCell("−", c.vote, setVote, shownVote()), voteCell("+", c.vote, setVote, shownVote()));

    const settle = () => {
      const now = ((c.versions || [])[shown] || {}).vote || 0;
      const to = shownAt(c);
      if (nv > 1 && now < 0 && to !== shown && to < (c.versions || []).length) showVersion(to);
      else footPaint();
    };
    footPaint();
    foots.set(c, settle);
    const card = el("article.card", {}, [media, footEl]);
    card.dataset.cid = c.id;

    card.addEventListener("click", (ev) => {
      if (card.dataset.held) { delete card.dataset.held; return; }
      if (ev.target.closest(".no-swipe")) return;
      openCard(c, d, spawn, shown);
    });
    wrap.append(card);
    return wrap;
  }

  const AUTO = { cur: null };
  const autoPanels = new Map();
  async function autoLoad(type = null) {
    try {
      const r = await fetch("/api/auto" + (type ? `?type=${encodeURIComponent(type)}` : ""));
      if (r.ok) { const d = await r.json(); if (d && d.settings) AUTO.cur = d; }
    } catch (_) {}
    return AUTO.cur;
  }
  const autoIsOn = (t) => !!(AUTO.cur && AUTO.cur.settings && AUTO.cur.settings.on
                             && (AUTO.cur.settings.types || []).includes(t));

  const autoTab = (t) => ({ kinds: ["revise"], keep: false, comment: "", criterion: "",
                            ...(((AUTO.cur || {}).settings || {}).tabs || {})[t] });
  async function autoPut(body, t) {
    const r = await fetch("/api/auto", { method: "PUT", headers: { "Content-Type": "application/json" },
                                         body: JSON.stringify({ ...body, for: t }) });
    const d = await r.json();
    if (!r.ok) throw new Error(d.err || r.status);
    if (d.settings) AUTO.cur = d;
    autoChanged();
    return d.settings || {};
  }

  function autoChanged() {
    for (const P of autoPanels.values()) if (P.el.isConnected) P.refresh();
    for (const p of panels.values()) p.refresh();
  }

  async function autoSet(t, on) {
    const types = ((AUTO.cur && AUTO.cur.settings && AUTO.cur.settings.types) || []).filter((x) => x !== t);
    try {
      const ns = await autoPut(on ? { on: true, types: [...types, t] } : { on: types.length > 0, types }, t);
      toast(on ? `AUTO ${typeShort(t)} ON — ${ns.agent} makes from the ${typeLabel(t)} auto pool until it can't`
               : `AUTO ${typeShort(t)} off`);
    } catch (e) { toast(`AUTO ${typeShort(t)}: ${e.message}`); }
  }
  const sheetBtn = (text, onclick) => Object.assign(el("button.sbtn", { type: "button" }, [].concat(text)), { onclick });

  function autoWho(first, firstModel = null) {
    let sel = first, model = firstModel;        // model null: the agent's ⚙ choice
    const picked = { [first]: firstModel };      // each agent's pick while the sheet is open: browsing tabs keeps them
    const cur = AUTO.cur || {};
    const SRC = { claude: "anthropic", codex: "codex", antigravity: "agy" };
    const SHORT = { antigravity: "agy" };
    let usageAll = {};
    const pctOf = (a) => sessionPct(usageAll[SRC[a.name]] || {}, litOf(a));
    const stubs = (cur.agents || []).map((name) => ({ name, stub: true }));
    const shown = (list) => list.find((a) => a.name === sel) || list[0];
    const litOf = (a) => (a.name === sel && model ? model : (a.choice || {}).model ?? null);
    // the agent menu inline: its tabs say each agent's usage; the agent and model picked are AUTO's
    const pick = agentPicker({ inline: true, list: stubs, cur: shown(stubs), lit: litOf,
      tab: (a) => {
        const pct = pctOf(a), m = litOf(a);
        return { text: `${SHORT[a.name] || a.name}${pct == null ? "" : ` · ${pct}%`}`,
                 title: `${a.name}${m ? ` · ${m}` : ""} · ${pct == null ? "usage unknown" : `${pct}% used`}` };
      },
      onTab: (a) => { sel = a.name; model = picked[a.name] ?? null; },
      onPick: (a, m) => { sel = a.name; model = picked[a.name] = m; } });
    pick.classList.add("awho");
    Promise.all([fetch("/api/agents?cached=1").then((r) => r.json()).catch(() => ({})),
                 fetch("/api/usage/all").then((r) => r.json()).catch(() => ({}))])
      .then(([ag, us]) => {
        usageAll = us.sources || {};
        const byName = Object.fromEntries((ag.agents || []).map((x) => [x.name, x]));
        const list = (cur.agents || []).map((n) => byName[n] || { name: n, stub: true });
        pick.reload(list, shown(list));
      });
    return { el: pick, get: () => sel, model: () => model };
  }
  async function openAuto(type) {

    const cur = AUTO.cur || await autoLoad(type);
    if (!cur) { toast("AUTO didn't answer"); return; }
    if (cap(type, "auto") === "placeholder") return autoPlaceholder(type);
    if (!(cur.types || []).includes(type)) { toast(`no AUTO for ${typeLabel(type)}: no agent makes its cards`); return; }
    return autoSheet(type);
  }

  function autoPlaceholder(type) {
    const words = (TYPES[type] || {}).auto_placeholder || {};
    const host = el("div.sbody.auto.live");
    openSheet("auto", el("div.shead", {}, [el("div.t", { text: words.title || `AUTO · ${typeShort(type)}` }), closeBtn("auto")]), host);
    host.replaceChildren(el("div.snote", { text: words.description || "Not built yet — nothing runs." }));
  }
  /* Share the maker selector across tabs, but keep each tab's request settings separate. */
  async function autoSheet(t) {
    const host = el("div.sbody.auto");
    const foot = el("div.autofoot");
    openSheet("auto",
      el("div.shead", {}, [el("div.t", { text: `AUTO · ${typeShort(t)}` }), closeBtn("auto")]),
      host, foot);
    await autoLoad(t);
    const cur = AUTO.cur;
    const s = cur.settings, st = cur.state || {};
    const own = autoTab(t);
    const on = autoIsOn(t);
    const who = autoWho(s.agent, s.model);

    let mode = (own.kinds || []).includes("inspire") ? ((own.kinds || []).includes("revise") ? "both" : "inspire") : "revise";
    const kindRow = el("div.akinds.asegbar");
    const paintKinds = () => kindRow.replaceChildren(...["revise", "inspire", "both"].map((k) => {
      const b = el("button.aseg.akind" + (k === mode ? ".on" : ""), { type: "button", text: k,
        title: k === "both" ? "a revise and an inspire, by turns" : `every job a ${k}` });
      b.onclick = () => { mode = k; paintKinds(); };
      return b;
    }));
    paintKinds();
    const kindsOf = () => (mode === "both" ? ["revise", "inspire"] : [mode]);
    const keep = el("input.akeepbox", { type: "checkbox" });
    keep.checked = !!own.keep;
    const keepRow = el("label.akeep", { title: "what it makes stays in AUTO's list, out of the stack, until you vote it up" },
                       [keep, el("span", { text: "keep until voted" })]);

    const OPENK = "picker.auto.open";
    const opened = (() => { try { return JSON.parse(localStorage.getItem(OPENK) || "{}") || {}; }
                            catch (_) { return {}; } })();
    const fold = (key, title, more, always, body, sum = null) => {
      const tog = el("button.afold", { type: "button" });
      const b = el("div.asecb", {}, body);
      const head = el("div.asumt", {}, [el("span.ahead", { text: title }), ...(sum ? [sum] : []), tog]);
      const d = el(`div.asec.k-${key}`, {}, [head, ...always, b]);
      const set = (open) => {
        d.classList.toggle("open", open);
        b.hidden = !open;
        tog.textContent = open ? "▾ hide" : `▸ ${more}`;
      };
      head.onclick = () => {
        opened[key] = !d.classList.contains("open");
        set(opened[key]);
        try { localStorage.setItem(OPENK, JSON.stringify(opened)); } catch (_) {}
      };
      set(!!opened[key]);
      return d;
    };
    const chip = (on, text) => el("span.achip" + (on ? ".on" : ""), { text });

    const instr = el("textarea.ainstr", { rows: "2", placeholder: "the direction, e.g. slower, calmer, distorted vocals" });
    instr.value = own.comment || "";
    const instrClear = el("button.sbtn.ainstrclear", { type: "button", text: "clear text" });
    const growIt = (t) => {
      t.style.height = "auto";
      t.style.height = `${Math.min(Math.max(t.scrollHeight + 2, 46), 260)}px`;
    };
    const grow = () => growIt(instr);
    const paintInstr = () => {
      instrClear.hidden = !instr.value.trim();
    };
    instr.oninput = () => { grow(); paintInstr(); };
    instrClear.onclick = () => { instr.value = ""; grow(); paintInstr(); instr.focus(); };

    const why = (st.of || {})[t] || "";
    const status = on && why && !/queued a /.test(why) ? why : "";

    let sv = cur.survey || {};
    const crit = el("textarea.acrit", { rows: "2", placeholder: "a criterion, e.g. slowest first (empty: random cards)" });
    crit.value = own.criterion || "";
    const orderBox = el("div.aorder");
    const when = (ts) => new Date(ts * 1000).toLocaleString(undefined,
      { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
    const again = el("button.sbtn.aagain", { type: "button", text: "survey again" });

    const critClear = el("button.sbtn.acritclear", { type: "button", text: "clear" });
    critClear.onclick = () => { crit.value = ""; growIt(crit); paintOrder(); };
    const norm = (x) => String(x || "").trim().replace(/\s+/g, " ");
    const orderSum = el("div.asumv");
    const paintOrder = () => {
      const on = !!norm(crit.value);
      const c1 = norm(crit.value);
      const fresh = sv.order && sv.criterion === c1;
      const nDone = fresh ? sv.order.filter((o) => o.revised).length : 0;
      orderSum.replaceChildren(chip(on, !on ? "random cards"
        : sv.running ? "surveying now…"
        : fresh ? `in order: ${sv.order.length} card${sv.order.length === 1 ? "" : "s"}, ${nDone} revised`
        : "it surveys the auto pool first"));
      orderSum.closest(".asec")?.classList.toggle("lit", on);
      critClear.hidden = !on;
      const out = [];
      if (sv.running)
        out.push(el("div.snote", { text: `surveying now… ${sv.running.phase || sv.running.status}` }));
      if (sv.order && sv.criterion) {
        const other = norm(crit.value) !== sv.criterion;
        out.push(el("div.snote", { text: (!on ? "the last order (not used without a criterion) — "
                                          : other ? "the last order was for another criterion — " : "") +
          `surveyed ${when(sv.ts)} for «${sv.criterion}»` +
          ` · ${sv.order.length} card${sv.order.length === 1 ? "" : "s"}, ✓ = revised since` }));
        out.push(el("ol.aolist", {}, sv.order.map((o) => el("li" + (o.revised ? ".done" : ""), {}, [
          el("span.aol", { text: `${o.revised ? "✓ " : ""}${nameFor(storeD || {}, { id: o.card, type: t, name: o.name })}`,
                           title: o.label }),
          o.why ? el("div.awhy", { text: o.why }) : null].filter(Boolean)))));
        if (sv.report)
          out.push(el("details.areport", {}, [el("summary", { text: "the survey's report" }),
                                              el("pre", { text: sv.report })]));
        out.push(again);
      } else if (!sv.running) {
        out.push(el("div.snote", { text: norm(crit.value)
          ? "no order yet: auto revise surveys the auto pool first"
          : "nothing surveyed yet: type a criterion above" }));
      }
      orderBox.replaceChildren(...out);
    };
    crit.oninput = () => { growIt(crit); paintOrder(); };
    again.onclick = async () => {
      try {
        const r = await fetch("/api/auto/survey", { method: "POST",
          headers: { "Content-Type": "application/json" }, body: JSON.stringify({ for: t }) });
        const d = await r.json();
        if (!r.ok) throw new Error(d.err || r.status);
        AUTO.cur = d;
        sv = d.survey || {};
        paintOrder();
        toast("it surveys again at its next look");
      } catch (e) { toast(`survey again: ${e.message}`); }
    };
    paintOrder();

    instr.placeholder = "comment — the direction, e.g. slower, calmer, distorted vocals";
    instr.rows = 3;
    host.replaceChildren(...(status ? [el("div.snote", { text: status })] : []),
      who.el, kindRow, el("div.akeeprow", {}, [keepRow]),
      el("div.acomment.k-style", {}, [instr, el("div.acount.ainstrrow", {}, [instrClear])]),
      fold("order", "order:", "set", [], [crit, el("div.acount.acritrow", {}, [critClear]), orderBox], orderSum));
    paintOrder();
    paintInstr();
    requestAnimationFrame(() => { grow(); growIt(crit); });
    const name = `AUTO ${typeShort(t)}`;

    let acted = false;
    const snap = () => JSON.stringify([norm(crit.value), instr.value.trim(), who.get(), who.model(), mode, keep.checked]);
    const was = snap();
    autoClosed = () => {
      if (acted) return;

      if (snap() !== was)
        toast(`not saved — ${on ? "update" : "start"} saves what you changed` +
              (on ? `; ${name} is still ON` : ""));
      else if (on) toast(`${name} is still ON — its switch, or ■ stop here, turns it off`);
    };

    const others = s.types.filter((x) => x !== t);
    const go = async (body, say) => {
      acted = true;
      try {
        const ns = await autoPut({ ...body, criterion: crit.value, comment: instr.value,
                                   kinds: kindsOf(), keep: keep.checked,
                                   agent: who.get(), model: who.model() }, t);
        closeSheet("auto");
        toast(say(ns));
      } catch (e) { toast(`${name}: ${e.message}`); }
    };
    const persp = () => {
      return `${kindsOf().join(" and ")}` + (keep.checked ? ", kept in the list until voted" : "") +
        (instr.value.trim() ? ", with your comment" : ", no comment") +
        (norm(crit.value) ? `, in the order for «${norm(crit.value).slice(0, 40)}»` : "");
    };

    const lead = cur.lead || {}, guides = {};
    const about = seesInfo("what each AUTO job hands the agent", async (box) => {
      const a = who.get(), word = a === "antigravity" ? "agy" : a, ks = kindsOf();
      const c0 = norm(crit.value), comment = instr.value.trim();
      const from = `a card from the ${typeShort(t)} auto pool (none marked: every active card), ` +
        (c0 ? `the next in the order for «${c0}»` : "picked at random") +
        ", at its newest version not voted down";
      const made = (k) => (k === "revise" ? "to make its next version" : "to make a new card from it");
      const said = (k) => (lead[k] ? `, with AUTO's words: "${lead[k]}"` : "");
      for (const k of ks) if (!(`${a}|${k}` in guides))
        guides[`${a}|${k}`] = guideFiles(t, { agent: a, kind: k }).then((fs) => (guides[`${a}|${k}`] = fs));
      const gs = ks.map((k) => guides[`${a}|${k}`]);
      box.replaceChildren(
        el("div", {}, [el("b", { text: ks[0] }), ` hands ${word} ${from}, ${made(ks[0])}${said(ks[0])}`]),
        ...(ks[1] ? [el("div", {}, [el("b", { text: ks[1] }), `, by turns, hands it a card the same way, ${made(ks[1])}${said(ks[1])}`])] : []),
        el("div.smut", { text: `With them: ${andList(["your votes on the card",
          comment ? `your comment as its direction, "${comment.length > 90 ? `${comment.slice(0, 88)}…` : comment}", ` +
                    "which wins where it and the votes disagree" : null,
          c0 ? "why the order put the card next" : null].filter(Boolean))}.` +
          (keep.checked ? " What it makes stays in AUTO's list until you vote it up." : "") + guideSaid(ks, gs) }));
      return gs.every(Array.isArray) ? null : Promise.all(gs);
    });
    foot.replaceChildren(about, ...(on
      ? [Object.assign(sheetBtn([glyph("stop", 12), "stop"], () => go({ on: others.length > 0, types: others },
           () => `${name} off (its settings are kept)`)), { className: "sbtn astop" }),
         sheetBtn("update", () => go({}, () => `${name}: ${persp()}`))]
      : [sheetBtn("start", () => go({ on: true, types: [...others, t] }, (ns) =>
          `${name} ON — ${persp()}; ${ns.agent} makes from the ${typeLabel(t)} auto pool until it can't`))]));
  }

  function autoEntry(type, d) {
    if (!AUTO.cur && d.auto) AUTO.cur = d.auto;
    let P = autoPanels.get(type);
    if (!P) { P = autoPanel(type); autoPanels.set(type, P); }
    P.d = d;
    P.paint();
    return P.el;
  }
  function autoPanel(type) {
    const card = el("article.card.compose.autop");
    const live = cap(type, "auto") === "placeholder";
    const P = { el: card, d: null, data: null, all: false };
    const body = el("div.abody");
    let drawn = null;
    P.paint = () => {
      if (!P.d) return;
      const on = autoIsOn(type);
      const open = P.d.panelOpen("auto", type, false);
      const who = ((AUTO.cur || {}).settings || {}).agent || "";

      const own = autoTab(type);
      const words = (TYPES[type] || {}).auto_placeholder || {};
      const line = live ? words.summary || "what AUTO will do"
        : on ? `${who} · making from the ${typeShort(type)} auto pool` : autoLine((own.comment || "").trim(), own.kinds);
      if (drawn !== `${open}|${on}|${who}|${line}`) {
        drawn = `${open}|${on}|${who}|${line}`;
        const head = panelHead({ label: "AUTO", open, status: { on, who },
          onToggle: (v) => { P.d.setPanelOpen("auto", type, v); P.paint(); } });
        head.title = live ? words.tooltip || "AUTO: not built yet" : `AUTO ${typeShort(type)}: ${on ? "ON" : "off"}`;
        const strip = autoStrip({ on, text: line, onGo: () => (on ? autoSet(type, false) : openAuto(type)),
                                  onOpen: () => openAuto(type) });
        card.replaceChildren(...(open ? [head, strip, body] : [head]));
      }
      if (open) body.replaceChildren(...autoBody(type, P));
    };
    P.refresh = async () => {
      await autoLoad();
      if (!live) {

        try { P.data = await fetch(`/api/auto/made?type=${encodeURIComponent(type)}${P.all ? "&limit=500" : ""}`).then((r) => r.json()); }
        catch (_) {}
      }
      P.paint();
    };
    P.refresh();
    setInterval(() => { if (card.isConnected && document.visibilityState === "visible") P.refresh(); }, 30000);
    return P;
  }
  const madeName = (c, m, type, d) => {
    const i = c ? (c.versions || []).findIndex((v) => v.n === m.n) : -1;
    return i >= 0 ? refOf(c, i) : nameFor(d, { id: m.card, type, name: m.name });
  };

  function autoBody(type, P) {
    if (cap(type, "auto") === "placeholder") return [];
    const d = P.d, made = (P.data || {}).made || [], making = (P.data || {}).making || [];

    const cardOfRow = async (c, m) => c || await fetch(`/api/cards/${encodeURIComponent(m.card)}`)
      .then((r) => (r.ok ? r.json() : null)).catch(() => null);
    const open = async (c0, m) => {
      const c = await cardOfRow(c0, m);
      if (!c || c.archived) { toast("that card is archived"); return; }
      const i = (c.versions || []).findIndex((v) => v.id === m.vid);
      openCard(c, d, spawnNow, i >= 0 ? i : null);
    };
    // returns the vote to show at once (voteCells); a failed save repaints the list as it was
    const vote = (c, m, sign) => {

      if (m.held) {
        writeSignal(c || { id: m.card }, d, { kind: "vote", value: sign, version: m.n }, () => P.refresh(), () => P.paint());
        return sign;
      }
      if (!c) { toast("that card isn't on the grid (archived?)"); return undefined; }
      const nv = (c.versions || []).length, ver = (c.versions || []).find((v) => v.n === m.n);
      const was = m.tapped ?? (nv > 1 ? (ver || {}).vote || 0 : c.vote || 0);       // a quick second tap counts on
      const v = m.tapped = Math.max(-3, Math.min(3, was + sign));
      writeSignal(c, d, nv > 1 ? { kind: "vote", value: v, version: m.n } : { kind: "vote", value: v },
                  () => P.refresh(), () => { delete m.tapped; P.paint(); });
      return v;
    };
    const busy = making.map((j) => el("div.aulog.auwait.making", {}, [
      el("span.auplay.dim", { text: "…" }),
      el("div.auseek", {}, [el("span.auat", { text: `${Math.max(0, Math.round((Date.now() / 1000 - (j.started || j.created || 0)) / 60))} min` }),
        el("span.auname.aumade", { text: j.label || j.card || "" }),
        el("span.auwhy", { text: `being made · ${j.agent || ""}`.replace(/ · $/, "") })])]));

    const rows = (P.all ? made : made.slice(0, 8)).map((m) => {
      const c = (d.cards || []).find((x) => x.id === m.card);
      const rid = `auto:${m.card}:${m.n}`;
      const lead = m.audio
        ? el("button.auplay" + (rank.id === rid ? ".on" : ""), { type: "button", title: "listen", "aria-label": "listen" }, playGlyphs(13))
        : el("button.auplay.authumb", { type: "button", title: c ? "open it at this version" : "not on the grid (archived?)" },
             m.still ? [el("img", { src: thumb(m.still, 360), alt: "", loading: "lazy" })] : []);
      lead.onclick = m.audio ? () => rankPlay(rid, m.audio) : () => open(c, m);
      const nm = el("button.auname", { type: "button", title: m.label, text: `${madeName(c, m, type, d)}${m.vid ? ` ${m.vid}` : ""}` });

      const ver = c && (c.versions || []).find((v) => v.n === m.n);
      const len = ver && (ver.media || {}).ab ? abLength(ver) : 0;
      const split = len > 0 ? Math.min(99, Math.max(1, (100 * (+ver.ab_at || 0)) / len)) : null;
      const sections = split != null && m.still ? el("span.auab", {}, [
        el("img", { src: thumb(m.still, 360), alt: "", loading: "lazy", draggable: "false" }),
        el("i.ausplit", { style: `left:${split.toFixed(2)}%` }),
        el("span.auabl", { text: "A" }), el("span.auabl", { text: "B", style: `left:${split.toFixed(2)}%` })]) : null;
      // an A/B strip is as long as its sound, at most (a wide screen would stretch a one-second kick across it)
      const strip = el("div.auseek" + (m.audio ? ".ausnd" : "") + (sections ? ".capped" : ""),
        sections ? { style: `--cap:${Math.max(280, Math.round(len * 150))}px` } : {}, [sections, el("i.aurfill"),
        el("span.auat", { text: listWhen(m.ts) }), nm, el("span.augap")].filter(Boolean));
      nm.onclick = () => {
        if (strip.dataset.swallow) { delete strip.dataset.swallow; return; }
        open(c, m);
      };
      if (m.audio) rankScrub(strip, { id: rid, audio: m.audio });
      return el("div.aulog" + (rank.id === rid ? ".on" : ""), { "data-card": m.card, "data-v": String(m.n ?? ""),
                                                                 ...(m.audio ? { "data-rk": rid } : {}) }, [lead,
        strip,
        voteCells(m.held && m.vote == null ? "n" : m.vote || 0, (sign) => vote(c, m, sign),
                  m.held && m.vote == null ? "n — kept in this list until you vote it up" : "")]);
    });
    const total = (P.data || {}).total ?? made.length;
    const more = total > 8 ? Object.assign(el("button.aumore", { type: "button",
      text: P.all ? "show fewer" : `show all ${total}` }), { onclick: () => { P.all = !P.all; P.all ? P.refresh() : P.paint(); } }) : null;

    const pooled = (d.cards || []).filter((x) => x.type === type && !x.archived && (x.pools || []).includes("auto"));
    const pool = el("div.aubase", {}, pooled.length
      ? [poolHead(pooled.length), poolPickBtn(type), poolClearBtn(type), el("div.aubts", {}, pooled.map((x) => {
          const t = el("button.aubt", { type: "button", title: "open the card (✓pool there takes it out of the auto pool)" }, [
            x.media && (x.media.still || x.media.poster) ? el("img", { src: thumb(x.media.still || x.media.poster, 360), alt: "", loading: "lazy" })
                                                          : el("span.aubtkind", { text: "no picture" }),
            el("span.aubtname", { text: nameFor(d, x) })]);
          t.onclick = () => openCard(x, d, spawnNow);
          return t;
        }))]
      : [poolHead(0), poolPickBtn(type), el("span.aubaseall", { text: "every active card" }),
         el("span.aubasehow", { text: "mark cards +pool (open a card) to choose" })]);
    if (!busy.length && !rows.length) return [el("div.cnote", { text: "nothing made yet" }), pool];
    return [el("div.aulogs", {}, [...busy, ...rows, more].filter(Boolean)), pool];
  }

  const panels = new Map();
  function panelEntry(t, d) {
    let p = panels.get(t);
    if (!p) {
      p = { el: el("div.panelslot"), d, pause() {}, refresh() {}, busy: () => false };
      panels.set(t, p);
      const hooks = {
        stopOthers: () => stopAudio(),
        cardChanged: (fresh) => {
          const c = (p.d.cards || []).find((x) => x.id === fresh.id);
          if (c) { merge(c, fresh); rebuildCard(c); }
        },
        openCard: (id) => {
          const c = (p.d.cards || []).find((x) => x.id === id);
          if (c) openCard(c, p.d, spawnNow);
          else toast("that card isn't on the grid (archived?)");
        },
        openAuto: () => openAuto(t),
        poolPickBtn: () => poolPickBtn(t),
        poolClearBtn: () => poolClearBtn(t),
        setAuto: (on) => autoSet(t, on),
        panelOpen: () => p.d.panelOpen("panel", t, true),
        setPanelOpen: (v) => p.d.setPanelOpen("panel", t, v),
        toast,
      };
      import(cap(t, "panel")).then((m) => {
        const got = m.mount(hooks);
        p.el.replaceWith(got.el);
        Object.assign(p, { el: got.el, pause: got.pause, refresh: got.refresh, busy: got.busy });
      }).catch((e) => { p.el.textContent = `${typeLabel(t)}'s panel didn't load: ${e.message}`; });
    }
    p.d = d;
    return p.el;
  }
  let addRecNote = "";
  function addRecordingRow(t, d) {
    const pick = el("input", { type: "file", multiple: "", hidden: "",
      accept: ".mp3,.m4a,.wav,.flac,audio/mpeg,audio/mp4,audio/x-m4a,audio/wav,audio/flac" });
    const lbl = el("span.phead-lbl", { text: addRecNote || "Add recording" });
    const btn = el("button.phead-tog", { type: "button", title: "upload an mp3, m4a, wav or flac — it becomes a recording card" },
                   [el("span.addrec-plus", { "aria-hidden": "true" }, [glyph("plus", null)]), lbl]);
    const say = (msg) => { addRecNote = msg; for (const e of document.querySelectorAll(".addrec:not(.addidea) .phead-lbl")) e.textContent = msg || "Add recording"; };
    btn.onclick = () => { if (!addRecNote) pick.click(); };
    pick.onchange = async () => {
      const files = [...pick.files];
      pick.value = "";
      let last = null;
      for (const [i, f] of files.entries()) {
        const of = files.length > 1 ? `${i + 1}/${files.length} · ` : "";
        try {
          last = await uploadRecording(t, f, (pct) => say(`uploading ${of}${pct}%`)) || last;
        } catch (e) { toast(`not uploaded: ${f.name} — ${e.message}`); }
      }
      say("");
      if (!last) return;
      toast(files.length > 1 ? `${files.length} recordings in` : `recording in${last.dedup ? " (it was already here)" : ""}`);
      if (d.reload) { await d.reload(onTypes()); paintGrid(); }
      const nc = (d.cards || []).find((x) => x.id === last.card);
      if (nc) requestAnimationFrame(() => openCard(nc, d, spawnNow));
    };
    return el("article.card.compose.addrec", {}, [el("div.phead", {}, [btn]), pick]);
  }
  /* Use XHR because upload progress is visible in the sheet. */
  function uploadRecording(t, file, onPct) {
    return new Promise((ok, no) => {
      const fd = new FormData();
      fd.append("file", file, file.name);
      const x = new XMLHttpRequest();
      x.open("POST", cap(t, "upload"));
      x.upload.onprogress = (e) => { if (e.lengthComputable) onPct(Math.round(100 * e.loaded / e.total)); };
      x.onload = () => {
        let b = {};
        try { b = JSON.parse(x.responseText); } catch (_) {}
        if (x.status === 200 && b.ok) ok(b);
        else no(new Error(b.description || b.err || `HTTP ${x.status}`));
      };
      x.onerror = () => no(new Error("the connection dropped"));
      x.send(fd);
    });
  }

  function composeCard(type, d) {
    const arrs = (d.arrangements || []).filter((a) => a.type === type);
    const spec = (d.compose || {})[type];

    if (!(spec && spec.kind === "timeline")) return null;
    const host = el("div.tlwrap");

    tlAdopt(arrs, { type, api: tlApi(type, d) });

    tlSetOpen(d.panelOpen("timeline", type, true));

    queueMicrotask(() => mountTimeline(host, { type, api: tlApi(type, d) }));
    return host;
  }

  const gridCups = new Map();
  function cupEntry(type, d) {
    const card = el("article.card.compose.cup");
    let open = d.panelOpen("cup", type, true);
    let line = "…", verb = "\u25b8 start", ranking = [];

    const rankRow = ({ place, card: pc }) => {
      const fc = (d.cards || []).find((x) => x.id === pc.id) || null;
      const c = fc || pc;
      const gone = !fc || !!c.archived;
      const name = el("button.rkname", { type: "button", title: pc.label || pc.id, text: nameFor(d, pc) });
      name.onclick = () => {
        if (name.dataset.swallow) { delete name.dataset.swallow; return; }
        if (fc) openCard(fc, d, spawnNow);
      };
      if (pc.audio) rankScrub(name, pc);
      const vs = (fc && fc.versions) || [], nv = vs.length, at = fc ? shownAt(fc) : 0;
      const base = nv > 1 ? (vs[at] || {}).vote || 0 : c.vote || 0;
      let tapped = base || 0;                       // a quick second tap counts on from the first
      const vote = (sign) => {
        const v = tapped = Math.max(-3, Math.min(3, tapped + sign));
        writeSignal(fc, d, nv > 1
          ? { kind: "vote", value: v, version: (vs[at] || {}).n ?? at + 1 } : { kind: "vote", value: v },
          () => { paint(); const under = foots.get(fc); if (under) under(); }, () => paint());
        return v;
      };
      const votes = fc && !gone ? [voteCells(c.vote || 0, vote)] : [];

      const pooledIn = !!fc && (fc.pools || []).includes("auto");
      const inf = fc && !gone
        ? el("button.rkact.rkpool" + (pooledIn ? ".on" : ""), { type: "button",
            title: pooledIn ? "in the auto pool — tap to take it out" : "add it to the auto pool" }, glyph("pool", 18))
        : null;
      if (inf) inf.onclick = () => writeSignal(fc, d, { kind: "pool", pool: "auto", value: !pooledIn },
        () => { paint(); autoChanged(); });
      const arch = el("button.rkact.rkarch" + (gone ? ".on" : ""), { type: "button",
        title: gone ? "archived — tap to bring it back" : "archive — never deleted" }, glyph("archive", 15));
      arch.onclick = () => writeSignal(fc || { id: pc.id }, d, { kind: "archive", value: !gone }, () => {
        if (gone && !fc && d.reload) d.reload(onTypes()).then(() => { paintGrid(); paint(); });
        else { paint(); paintGrid(); }
      });
      name.append(el("i.rkfill"));
      const pic = !pc.audio && ((pc.media || {}).still || (pc.media || {}).poster);
      const play = pc.audio ? el("button.rkplay" + (rank.id === pc.id ? ".on" : ""), { type: "button",
        title: "listen", "aria-label": "listen" }, playGlyphs(13))
        : el("button.rkplay.rkpic", { type: "button", title: "open it" },
             pic ? [el("img", { src: thumb(pic, 360), alt: "", loading: "lazy" })] : []);
      if (pc.audio) play.onclick = () => rankPlay(pc.id, pc.audio);
      else play.onclick = () => { if (fc) openCard(fc, d, spawnNow); };
      return el("div.rkrow" + (gone ? ".gone" : ""), { "data-cid": pc.id }, [
        play, el("span.rkplace", { text: String(place) }), name, ...votes, inf, arch].filter(Boolean));
    };
    /* Open and closed rows have different structure; rebuild rather than patching fields. */
    const paint = () => {
      const go = el("button.cupgo", { type: "button", text: verb });
      go.onclick = (e) => { e.stopPropagation(); openCup(type, d, refresh); };

      card.replaceChildren(...[
        panelHead({
          label: "cup",
          open,
          onToggle: (v) => { open = v; d.setPanelOpen("cup", type, v); paint(); },
        }),

        open ? (() => {
          const row = el("div.cuprow", {}, [verb ? go : null,
                                            el("span.cnote", { text: line })]);
          row.onclick = () => openCup(type, d, refresh);
          return row;
        })() : null,
        open && ranking.length ? el("div.cuprank", {}, ranking.map(rankRow)) : null,
      ].filter(Boolean));
      keepScroll();
    };

    let rankTop = 0;
    function keepScroll() {
      const l = card.querySelector(".cuprank");
      if (!l) return;
      l.onscroll = () => { rankTop = l.scrollTop; };
      if (rankTop) l.scrollTop = rankTop;
    }
    card.keepScroll = keepScroll;
    const refresh = () => d.cup.status(type).then((r) => {
      line = r.cup
        ? `under way — ${r.cup.stage === "group"
            ? `group ${r.cup.done_groups + 1} of ${r.cup.total_groups}`
            : `knockout, ${(r.cup.ko_log || []).length} judged`}`
        : r.last
          ? `${r.candidates} cards · last won by ${
              nameFor(d, r.last.card || r.last.winner)}`
          : `${r.candidates} cards, none judged yet`;
      verb = r.cup ? "\u25b8 carry on"
        : r.candidates < 2 ? "" : r.last ? "\u25b8 again" : "\u25b8 start";
      ranking = (r.last && r.last.ranking) || [];
      paint();
    }).catch((e) => { line = e.message; paint(); });
    paint();
    refresh();
    return card;
  }

  function openSettings() {
    const host = el("div.sbody.settings");
    openSheet("settings",
      el("div.shead", {}, [el("div.t", { text: "agents" }), closeBtn("settings")]),
      host);
    mountSettings(host, { walk: { steps: () => present(), start: startWalk,
                                  card: firstCard() ? startCardWalk : null } });
  }

  function walkFromSettings() {
    const s = shells.settings;
    if (s) { s.scrim.hidden = true; s.sh.hidden = true; }
    const i = sheetHist.lastIndexOf("settings");
    if (i >= 0) sheetHist[i] = "walk";
    else { sheetHist.push("walk"); history.pushState({ sheet: "walk" }, ""); }
    const t = onTypes().length === 1 ? onTypes()[0] : null;
    return { tab: t && TYPES[t] ? { label: TYPES[t].label, kind: TYPES[t].kind } : null };
  }
  function startWalk(at) {
    walk(walkFromSettings(), at, { end: () => closeSheet("walk") });
  }

  const firstCard = () => document.querySelector(".grid article.card:not(.compose) .ctitle");
  let walkCard = false;
  function startCardWalk() {
    const ctx = walkFromSettings(), m = firstCard();
    if (!m) { closeSheet("walk"); return; }
    m.click();
    const t0 = performance.now();
    const go = () => {
      if (!document.querySelector(".sheet.big:not([hidden]) .cdesc")) {
        if (performance.now() - t0 < 4000) requestAnimationFrame(go); else closeSheet("walk");
        return;
      }
      walkCard = true;
      walk(ctx, 0, { steps: CARD_STEPS, end: () => { walkCard = false; closeSheet("big"); closeSheet("walk"); } });
    };
    requestAnimationFrame(go);
  }

  const guideFiles = (type, q) => fetch(`/api/agents/insight/${encodeURIComponent(type)}?${new URLSearchParams(q)}`)
    .then((r) => (r.ok ? r.json() : {})).catch(() => ({}))
    .then((j) => (j.referenced || []).map((f) => f.path).filter((f) => /\.md$/.test(f)));

  const shortPath = (f) => { const s = f.split("/"); return s.length > 2 ? `${s[0]}/…/${s[s.length - 1]}` : f; };

  const andList = (xs) => xs.map((x, i) => (i === 0 ? "" : i < xs.length - 1 ? ", "
    : / — /.test(xs[i - 1]) ? " — and " : " and ") + x).join("");

  const guideSaid = (kinds, gs) => {
    const files = (g) => g.map(shortPath).join(", ");
    if (!gs.every(Array.isArray)) return " Its guide: …";
    if (gs.every((g) => files(g) === files(gs[0]))) return gs[0].length ? ` Its guide: ${files(gs[0])}.` : "";
    return ` ${kinds.map((k, i) => (gs[i].length ? `${i ? "for " : "Its guide for "}${k}: ${files(gs[i])}` : null))
      .filter(Boolean).join("; ")}.`;
  };

  const seesInfo = (title, say) => {
    const box = el("div.sees");
    const b = el("button.seesb", { type: "button", title, "aria-expanded": "false" }, glyph("info", 18));
    b.onclick = async () => {
      const later = await say(box);
      if (!infoBubble(b, box, "sees") || !later) return;
      await later;
      if (b.getAttribute("aria-expanded") === "true") await say(box);
    };
    return b;
  };

  const runsWith = async (type) => {
    const name = (TYPES[type] || {}).runs;
    const ag = await fetch("/api/agents?cached=1").then((r) => r.json()).catch(() => ({}));
    const a = (ag.agents || []).find((x) => x.name === name);
    return { name, word: a ? a.cli || a.name : name, agent: !!a };
  };

  function addIdeaRow(type, d) {
    const btn = el("button.phead-tog", { type: "button", title: "a new idea, in your words — it becomes a new card" },
                   [el("span.addrec-plus", { "aria-hidden": "true" }, [glyph("plus", null)]), el("span.phead-lbl", { text: "Add idea" })]);
    btn.onclick = () => openIdea(type, d);
    return el("article.card.compose.addrec.addidea", {}, [el("div.phead", {}, [btn])]);
  }
  function openIdea(type, d) {
    const host = el("div.sbody.idea"), foot = el("div.autofoot.ifoot");
    const field = el("textarea.ainstr.awords", { rows: "4", placeholder: "a new idea, in your words — a new card from nothing else" });
    const staged = [], strip = el("div.asumv.istage");
    const paintStage = () => strip.replaceChildren(...staged.map((u, i) => Object.assign(
      el("img.apick", { src: u, alt: "", title: "tap to take it out" }), { onclick: () => { staged.splice(i, 1); paintStage(); } })));

    field.addEventListener("paste", (ev) => {
      const imgs = [...((ev.clipboardData || {}).items || [])].filter((it) => it.kind === "file" && /^image\//.test(it.type));
      if (!imgs.length) return;
      ev.preventDefault();
      for (const it of imgs) {
        const fr = new FileReader();
        fr.onload = () => { staged.push(String(fr.result)); paintStage(); };
        fr.readAsDataURL(it.getAsFile());
      }
    });
    const make = sheetBtn("make", async () => {
      const text = field.value.trim();
      if (!text) { toast("write the idea first"); field.focus(); return; }
      make.disabled = true;
      try {
        await d.q.add({ type, kind: "seed", text, attachments: staged.slice() });
        closeSheet("idea");
        toast(`queued: a new ${typeShort(type)} card from your idea`);
        if (refreshQ) { refreshQ(); setTimeout(refreshQ, 1500); }
      } catch (e) { toast(`not queued: ${e.message}`); make.disabled = false; }
    });

    let guide = null;
    const about = seesInfo("what make hands the agent", async (box) => {
      const r = await runsWith(type), text = field.value.trim();
      const words = text ? `your words, "${text.length > 90 ? `${text.slice(0, 88)}…` : text}",` : "your words";
      const more = el("button.seesmore", { type: "button", text: "the whole brief ›" });
      more.onclick = () => { closeBubble(); openConfigured({ type, agent: r.name, kind: "seed" }); };
      if (r.agent && !guide) guide = guideFiles(type, { agent: r.name, kind: "seed" }).then((fs) => (guide = fs));
      box.replaceChildren(
        el("div", {}, [el("b", { text: "make" }), r.agent
          ? ` hands ${r.word} ${words} alone, to make a new card from nothing else.`
          : ` asks ${r.word}, not an agent, for a new card from ${words} alone.`]),
        el("div.smut", { text: !r.agent ? `No agent reads a brief here: ${r.word} runs the tab's own steps.`
          : `With them: ${staged.length ? `the ${staged.length > 1 ? `${staged.length} images` : "image"} you pasted in`
            : "any image you paste in"}.${guideSaid(["seed"], [guide])}` }),
        ...(r.agent ? [more] : []));
      return r.agent && !Array.isArray(guide) ? guide : null;
    });
    foot.append(about, make);

    openSheet("idea", el("div.shead", {}, [el("div.t", { text: `Add idea · ${typeShort(type)}` }), closeBtn("idea")]),
              host, foot);
    host.replaceChildren(field, strip);
    const sh = shell("idea").sh;
    if (!matchMedia("(hover:hover) and (pointer:fine)").matches) {
      const band = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--band")) || 0;
      sh.style.top = Math.max(band + 12, Math.round(innerHeight * 0.57) - sh.offsetHeight - 12) + "px";
    }
    requestAnimationFrame(() => field.focus());
  }

  function openAudit(c) {
    const host = el("div.sbody.audit");
    openSheet("audit",
      el("div.shead", {}, [el("div.t", { text: `${c.label} · log` }), closeBtn("audit")]),
      host);
    mountAudit(host, c.id, { toast });
  }

  function openConfigured(p) {
    const host = el("div.sbody");
    openSheet("configured",
      el("div.shead", {}, [el("div.t", { text: `${p.kind} with ${p.agent} · as configured` }), closeBtn("configured")]),
      host);
    configured(p).then((n) => host.replaceChildren(n));
  }

  function openCup(type, d, onClose) {
    const host = el("div.cuphost");
    openSheet("cup",

      el("div.shead", {}, [
        el("div.t", { text: `${typeLabel(type)} · cup` }),
        closeBtn("cup"),
      ]),
      host);

    mountCup(host, { ...d.cup,
                     label: typeLabel,
                     status: () => d.cup.status(type),
                     open: () => d.cup.open(type),
                     stopOthers: () => stopAudio(),
                     ref: (c) => nameFor(d, c),

                     media: (id) => {
                       const fc = (d.cards || []).find((x) => x.id === id);
                       return fc && !hasPicture(fc) ? mediaOf(fc, d, { version: shownAt(fc) }) : null;
                     } });
    cupClosed = () => {
      stopCupAudio();
      if (host.querySelector(".vplay.on")) stopAudio();
      if (onClose) onClose();
    };
  }
  /* Called when the cup sheet closes, so the entry's counts catch up with what
     was just judged. One slot: there is one cup sheet. */
  let cupClosed = null;

  let autoClosed = null;

  function tlApi(type, d) {
    return {
      create: (t, name) => d.arrange.create(t || type, name),
      rename: (aid, name) => d.arrange.rename(aid, name),
      remove: (aid) => d.arrange.remove(aid),
      putClip: (aid, body) => d.arrange.putClip(aid, body),
      delClip: (aid, cid) => d.arrange.delClip(aid, cid),
      renderAt: (ref, secs) => d.arrange.renderAt(ref, secs),
      prefix: namePrefix(type),

      setOpen: (open) => d.setPanelOpen("timeline", type, open),

      refresh: async () => {
        await d.reloadArrangements(onTypes());
        tlAdopt((d.arrangements || []).filter((a) => a.type === type),
                { type, api: tlApi(type, d) });
        renderTimeline();
      },
    };
  }

  async function addToArrangement(card, d, part, btn, shown) {
    const type = card.type;
    try {

      const open = tlActive();
      let a = (d.arrangements || []).find((x) => open && x.id === open.id)
           || (d.arrangements || []).find((x) => x.type === type);
      if (!a) a = await d.arrange.create(type, "timeline 1");

      const ver = shown || {};
      const len = (part.time && part.time.len) || ver.duration || 0;

      const used = new Set((a.clips || []).map((x) => Math.round(x.track || 0)));
      let track = 0;
      while (used.has(track) && track < 7) track += 1;
      const start = (a.clips || [])
        .filter((x) => Math.round(x.track || 0) === track)
        .reduce((m, x) => Math.max(m, (x.start || 0) + (x.len || 0)), 0);

      await d.arrange.putClip(a.id, {
        ref: { card: card.id, version: ver.n, part: part.id },
        track, start, len,
        ...(part.time && part.time.gain != null ? { gain: part.time.gain } : {}),
        ...(part.time && part.time.fadeIn != null ? { fadeIn: part.time.fadeIn } : {}),
        ...(part.time && part.time.fadeOut != null ? { fadeOut: part.time.fadeOut } : {}),
        src_len: ver.duration || len,
      });
      await d.reloadArrangements(onTypes());

      tlAdopt((d.arrangements || []).filter((x) => x.type === type),
              { type, api: tlApi(type, d) });
      renderTimeline();
      if (btn) { btn.classList.add("on"); setTimeout(() => btn.classList.remove("on"), 700); }
    } catch (e) {
      console.error("clip:", e);
    }
  }

  const shells = {};

  function shell(kind) {
    if (!shells[kind]) {
      const scrim = el("div.scrim", { hidden: "", "data-kind": kind });
      const sh = el("div.sheet." + kind, { hidden: "" });
      scrim.onclick = () => closeSheet(kind);

      /* the ✕ under the sheet: the open card's, and the code sheet's over it */
      if (kind === "big" || kind === "code") {
        const ex = el("span.scrimx", { "aria-hidden": "true" }, [glyph("cut", 26)]);
        scrim.append(ex);
        const place = () => {
          const b = sh.getBoundingClientRect().bottom, room = window.innerHeight - b;
          ex.hidden = sh.hidden || room < 44;
          ex.style.top = `${Math.round(b + room / 2)}px`;
        };
        new ResizeObserver(place).observe(sh);
        window.addEventListener("resize", place);
        sh.placeX = place;
      }
      document.body.append(scrim, sh);
      shells[kind] = { scrim, sh };
    }
    return shells[kind];
  }

  let auxTab = null, auxRaf = 0;
  function auxPlay() {
    const s = shells.big;
    if (!s || auxTab) return;
    auxTab = el("button.auxplay.no-swipe", { type: "button", title: "play the card · drag: scrub", hidden: "" },
                [el("i.auxfill"), el("i.auxline"), ...playGlyphs(24), el("span.auxab")]);

    const auxA = el("button.auxplay.ab.auxa.no-swipe", { type: "button", title: "A: the reference", hidden: "" },
                    [el("i.auxfill"), el("i.auxline"), el("span.auxab")]);
    const abs = () => (s.sh.hidden ? [] : [...s.sh.querySelectorAll(".abplay")]);
    auxA.onclick = () => { const b = abs()[0]; if (b) b.click(); };
    const scrubBlock = () => [...s.sh.querySelectorAll(".vblock")].find((b) => b.scrub) || null;
    let pid = null, sx = 0, dragging = false, swallow = false, dragF = null;
    const fracX = (x) => { const r = auxTab.getBoundingClientRect(); return Math.max(0, Math.min(1, (x - r.left) / Math.max(1, r.width))); };
    const pin = (t, f) => {
      const [fl, ln] = t.querySelectorAll(".auxfill, .auxline");
      ln.hidden = fl.hidden = f == null;
      if (f != null) { ln.style.left = `${(f * 100).toFixed(1)}%`; fl.style.width = `${(f * 100).toFixed(1)}%`; }
    };

    const mirrorAB = () => {
      const blk = s.sh.querySelector(".abblock"), l = blk && blk.querySelector(".vline");
      const r = l && l.getBoundingClientRect(), x = r && r.width ? r.left + r.width / 2 : null;
      const sl = blk ? [...blk.querySelectorAll(".abslice")] : [];
      for (const [t, slice] of auxA.hidden ? [[auxTab, sl[0]]] : [[auxA, sl[0]], [auxTab, sl[1]]]) {
        const g = slice && slice.getBoundingClientRect();
        pin(t, g && x != null && x >= g.left - 1 && x <= g.right + 1 ? Math.max(0, Math.min(1, (x - g.left) / g.width)) : null);
      }
    };

    const mirror = () => {
      if (auxTab.hidden) return;
      if (auxTab.dataset.ab) return mirrorAB();
      let f = dragF;
      if (f == null) {
        const b = scrubBlock(), l = b && b.querySelector(".vline"), g = l && laneBox(b);
        f = g ? Math.max(0, Math.min(1, (l.getBoundingClientRect().left - g.left) / g.width)) : null;
      }
      pin(auxTab, f);
    };
    const mirrorLoop = () => { mirror(); requestAnimationFrame(mirrorLoop); };
    requestAnimationFrame(mirrorLoop);
    auxTab.addEventListener("pointerdown", (e) => {
      if (e.button) return;
      pid = e.pointerId; sx = e.clientX; dragging = false; swallow = false;
    });
    auxTab.addEventListener("pointermove", (e) => {
      if (e.pointerId !== pid || auxTab.dataset.ab) return;
      const b = scrubBlock();
      if (!b) return;
      if (!dragging) {
        if (Math.abs(e.clientX - sx) < 4) return;
        dragging = true;
        try { auxTab.setPointerCapture(pid); } catch (_) {}
        b.scrub.start();
      }
      e.preventDefault();
      dragF = fracX(e.clientX);
      b.scrub.move(dragF);
      mirror();
    });
    const end = (e) => {
      if (e.pointerId !== pid) return;
      if (dragging) {
        const b = scrubBlock();
        if (b) b.scrub.end(e.type === "pointercancel" ? dragF : fracX(e.clientX));
        swallow = true;
      }
      pid = null; dragging = false; dragF = null;
    };
    auxTab.addEventListener("pointerup", end);
    auxTab.addEventListener("pointercancel", end);
    auxTab.onclick = () => {
      if (swallow) { swallow = false; return; }
      const pb = abs()[1] || abs()[0] || s.sh.querySelector(".vplay");
      if (pb) pb.click();
    };
    const place = () => {
      auxRaf = 0;
      const ab = abs();
      const pb = s.sh.hidden ? null : ab[1] || ab[0] || s.sh.querySelector(".vplay");
      const vs = s.sh.querySelectorAll(":scope > .cfoot > .vcell");
      if (!pb || vs.length < 2) { auxTab.hidden = auxA.hidden = true; return; }
      const a = vs[0].getBoundingClientRect(), b = vs[vs.length - 1].getBoundingClientRect();

      const wide = ab.length === 2 ? 12 : 0;
      const left = ab.length === 2 ? b.left - wide : a.left;
      auxTab.style.left = `${Math.round(left)}px`;
      auxTab.style.width = `${Math.round((ab.length === 2 ? s.sh.getBoundingClientRect().right : b.right) - left)}px`;
      auxTab.style.top = `${Math.round(s.sh.getBoundingClientRect().bottom - 1)}px`;
      auxTab.classList.toggle("on", pb.classList.contains("on"));
      auxTab.hidden = false;
      if (ab.length) auxTab.dataset.ab = "1"; else delete auxTab.dataset.ab;
      auxTab.classList.toggle("ab", ab.length > 0);

      const say = (t, k) => t.querySelector(".auxab").replaceChildren(glyph(t.classList.contains("on") ? "stop" : "play", 14), k);
      auxA.hidden = ab.length !== 2;
      if (ab.length === 2) {
        Object.assign(auxA.style, { left: `${Math.round(a.left - 2 * wide)}px`, width: `${Math.round(b.left - a.left + wide)}px`,
                                    top: auxTab.style.top });
        auxA.classList.toggle("on", ab[0].classList.contains("on"));
        say(auxA, "A");
        say(auxTab, "B");
      } else if (ab.length === 1) say(auxTab, "A");
      else auxTab.querySelector(".auxab").replaceChildren();
    };
    const later = () => { if (!auxRaf) auxRaf = requestAnimationFrame(place); };
    new MutationObserver(later).observe(s.sh, { subtree: true, childList: true, attributes: true,
                                                attributeFilter: ["class", "hidden"] });
    new ResizeObserver(later).observe(s.sh);
    addEventListener("resize", later);
    document.body.append(auxTab, auxA);
    later();
  }

  const sheetHist = [];
  let skipPop = 0;
  addEventListener("popstate", () => {
    if (skipPop) { skipPop--; return; }
    const k = sheetHist.pop();
    if (k) closeSheet(k, true);
  });
  function closeSheet(kind, fromBack = false) {
    closeBubble();
    const s = shells[kind];

    const wasOpen = kind === "walk" ? walking() : kind === "reorder" ? tabsReordering : s && !s.sh.hidden;
    if (kind === "walk") stopWalk();
    if (kind === "reorder" && tabsReordering && tabEnd) tabEnd();
    if (kind === "big" && walkCard) { walkCard = false; queueMicrotask(() => closeSheet("walk")); }
    if (s) { s.scrim.hidden = true; s.sh.hidden = true; }
    if (wasOpen && !fromBack) {
      const i = sheetHist.lastIndexOf(kind);
      if (i >= 0) { sheetHist.splice(i, 1); skipPop++; history.back(); }
    }

    if (kind === "big" && listen.el) {
      if (listen.card) listen.card.at = null;
      stopAudio();
    }

    if (kind === "big") bandGen++;

    if (kind === "big") listen.tick = null;

    if (kind === "big" && gridPausedBySheet) { gridPausedBySheet = false; gifSoon(); }
    if (kind === "cup" && cupClosed) { const f = cupClosed; cupClosed = null; f(); }
    if (kind === "auto" && autoClosed) { const f = autoClosed; autoClosed = null; f(); }
  }

  function sizeSheet(sh) {
    /* Use the layout viewport so keyboard overlays do not resize an open card. */

    const band = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--band")) || 0;
    const vh = (window.innerHeight || document.documentElement.clientHeight) - band;

    const h = Math.min(720, Math.round(vh * 0.74));
    sh.style.setProperty("--sheet-h", h + "px");

    const vw = window.innerWidth;
    const desk = matchMedia("(hover:hover) and (pointer:fine)").matches;
    const mw = (vw >= 549 ? Math.min(540, vw * 0.92) : vw - 24) + 2;
    sh.style.setProperty("--media-h", (desk ? Math.round(mw * 9 / 16)
      : Math.max(120, Math.min(330, Math.round(vh * 0.31)))) + "px");
  }
  addEventListener("orientationchange", () => {
    setTimeout(() => { for (const k in shells)
      if (!shells[k].sh.hidden) sizeSheet(shells[k].sh); }, 120);
  });

  function openSheet(kind, ...nodes) {
    const s = shell(kind);
    sizeSheet(s.sh);
    s.sh.replaceChildren(...nodes);

    if (s.sh.hidden) { sheetHist.push(kind); history.pushState({ sheet: kind }, ""); }
    s.scrim.hidden = false;
    s.sh.hidden = false;
    if (s.sh.placeX) requestAnimationFrame(s.sh.placeX);
  }
  /* Escape closes the topmost. A phone never sends one; a keyboard expects it,
     and it costs one listener for the whole page. */
  document.addEventListener("keydown", (ev) => {
    if (ev.key !== "Escape") return;
    if (walking()) { closeSheet("walk"); return; }
    for (const kind of ["code", "configured", "auto", "idea", "audit", "settings", "cup", "big"]) {
      const s = shells[kind];
      if (s && !s.sh.hidden) { closeSheet(kind); return; }
    }
  });
  /* A voice's source over the open card: coloured, numbered, wrapped or scrolled, copied whole. */
  async function openCode(p) {
    const name = decodeURIComponent(p.src.split("?")[0].split("/").pop());
    const host = el("div.sbody.code", {}, [el("div.snote", { text: "reading…" })]);
    let text = "";
    const wrap = el("button.sopt", { type: "button", title: "wrap long lines, or scroll them sideways", text: "no wrap" });
    wrap.onclick = () => {
      const body = host.querySelector(".codebody");
      if (!body) return;
      wrap.textContent = body.classList.toggle("wrap") ? "no wrap" : "wrap";
    };
    const copy = el("button", { type: "button", title: `copy ${name}` }, [glyph("copy", 16)]);
    copy.onclick = async () => {
      try { await navigator.clipboard.writeText(text); toast(`copied ${name}`); } catch (_) { toast("not copied"); }
    };
    openSheet("code", el("div.shead", {}, [
      el("div.t", { text: p.label || p.id, title: name }), wrap, copy,
      el("a.sopt", { href: p.src, target: "_blank", rel: "noopener", title: `${name}, the file itself`, text: "raw ↗" }),
      closeBtn("code")]), host);
    try {
      const r = await fetch(p.src);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      text = await r.text();
      host.replaceChildren(codeView(text, { name }));
    } catch (e) { host.replaceChildren(el("div.snote", { text: `couldn't read ${name}: ${e.message}` })); }
  }
  const closeBtn = (kind) => {
    const b = el("button", { type: "button", title: "close" }, [glyph("cut", 20)]);
    b.onclick = () => closeSheet(kind);
    return b;
  };

  function requestBlock(text, images) {
    const imgs = requestImages(images);
    if (!text && !imgs) return null;
    return el("div.req", {}, [text ? el("div.reqtext", { text }) : null, imgs]
      .filter(Boolean));
  }

  function requestImages(images) {
    const imgs = (images || []).filter(Boolean);
    return imgs.length ? el("div.reqimgs", {}, imgs.map((u) => {
      const a = el("a.reqimg", { href: u, target: "_blank", rel: "noopener" },
                   [el("img", { src: u, alt: "", loading: "lazy" })]);
      a.onclick = (e) => e.stopPropagation();
      return a;
    })) : null;
  }

  function draftEditor(q, d, after) {
    const field = el("textarea.ideabox", { rows: "3", "aria-label": "edit this request" });
    field.value = q.text || "";
    const note = el("div.reqnote", { text: "waiting — edit until a researcher takes it" });
    let saved = field.value, wait = 0;
    const save = async () => {
      clearTimeout(wait);
      const v = field.value;
      if (v === saved || field.readOnly) return;
      try {
        const r = await d.q.edit(q.id, v);
        if (r === null) { lock("too late — a researcher has already taken it"); return; }
        saved = v; q.text = v;
        note.textContent = "saved";
        if (after) after();
      } catch (e) { note.textContent = `not saved: ${e.message}`; }
    };
    const lock = (why) => { field.readOnly = true; note.textContent = why; };
    field.addEventListener("input", () => { clearTimeout(wait); wait = setTimeout(save, 500); });
    field.addEventListener("change", save);
    const box = el("div.req.draft", {}, [field, requestImages(q.attachments), note]
      .filter(Boolean));
    box.lock = lock;
    return box;
  }

  async function openJob(q, d, after) {
    const pre = el("pre.qconsole", { text: "…" });

    let follow = true, pending = null;
    const jump = el("button.qjump", { type: "button", hidden: "" }, [glyph("chev", 13), "new output"]);
    const toEnd = () => {
      if (pending != null) { pre.textContent = pending; pending = null; }
      jump.hidden = true;
      follow = true;
      pre.scrollTop = pre.scrollHeight;
    };
    jump.onclick = toEnd;
    pre.addEventListener("scroll", () => {
      const atEnd = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 24;
      if (atEnd && !follow) toEnd();
      else follow = atEnd;
    }, { passive: true });

    const stages = el("div.qstages");
    const head = el("div.shead", {}, [
      kindIcon(q.kind, 16),
      el("div.t", { text: `${q.kind}${q.card ? " · " + q.card : ""}` }),
      closeBtn("job"),
    ]);
    const meta = el("div.qmeta");
    const request = q.status === "queued" && d.q
      ? draftEditor(q, d, after) : requestBlock(q.text, q.attachments);

    const paused = q.status === "paused";
    const handoff = (q.status === "waiting" || q.status === "failed" || paused) && d.q
      ? (() => {
          const iss = q.issue || {};
          const agents = (d.typeAgents || {})[q.type] || [];
          const note = el("div.reqnote");
          const go = async (agent, model) => {
            note.textContent = "…";
            const said = agent ? `${agent}${model ? ` · ${model}` : ""}` : "";
            try {
              if (paused) {
                await d.q.resume(q.id, agent, model);
                note.textContent = said ? `resumed with ${said}` : "resumed — back in line";
              } else {
                const r = await d.q.retry(q.id, agent, model);
                note.textContent = [said ? "with " + said : "trying again", r.runner].filter(Boolean).join(" — ");
              }
              if (after) after();
            } catch (e) { note.textContent = e.message; }
          };
          const cur = (q.waiting && q.waiting.agent) || q.backend ||
                      (q.researcher || ":").split(":").pop().split("@").pop();
          return el("div.qhand." + (iss.level || q.status), {}, [
            el("div.qhs", { text: paused ? `paused — on ${cur || "its agent"}` : iss.short || q.status }),
            iss.detail ? el("div.qhd", { text: iss.detail }) : null,
            iss.fix ? el("div.qhf", { text: `→ ${iss.fix}` }) : null,
            el("div.qhb", {}, [
              (() => {
                // the agent menu, the job's agent and model lit; a job not on an agent (a sweep) goes at once
                const b = el("button.chip.qmenu", { type: "button", text: paused ? "▶ resume…" : "↻ retry…" });
                b.onclick = async (ev) => {
                  ev.stopPropagation();
                  if (agentMenuOn(b)) { closeAgentMenu(); return; }
                  const ag = await fetch("/api/agents?cached=1").then((r) => r.json()).catch(() => ({}));
                  const list = (ag.agents || []).filter((a) => a.installed !== false && agents.includes(a.name));
                  if (!(ag.agents || []).some((a) => a.name === cur) || !list.length) return go(null);
                  const mine = list.find((a) => a.name === cur);
                  agentMenu(b, { title: paused ? "resume with" : "retry with", list, cur: mine || list[0],
                    lit: (a) => (a === mine && q.model) || (a.choice || {}).model || null,
                    onPick: (a, model) => go(a.name, model) });
                };
                return b;
              })(),
              q.status === "failed" ? (() => {
                const b = el("button.chip.dismiss", { type: "button" }, [glyph("cut", 12), "dismiss"]);
                b.onclick = async () => { await d.q.dismiss(q.id); note.textContent = "dismissed";
                                          if (after) after(); };
                return b;
              })() : null,
            ].filter(Boolean)),
            note,
          ].filter(Boolean));
        })()
      : null;

    const recHost = el("div", { hidden: "" });
    const recBtn = el("button.sfile", { type: "button" }, [el("span.sfp", { text: "receipts" }),
      el("span.snote", { text: "what each run was given, as it was then" })]);
    recBtn.onclick = async () => {
      recHost.hidden = !recHost.hidden;
      if (!recHost.hidden) recHost.replaceChildren(await receipts(q.id));
    };
    openSheet("job", head, el("div.sbody", {}, [handoff, request, meta, recBtn, recHost, stages, pre, jump]
      .filter(Boolean)));

    let stop = false;
    const shut = shells.job;
    if (shut) shut.scrim.addEventListener("click", () => { stop = true; }, { once: true });

    const tick = async () => {
      if (stop || shells.job.sh.hidden) return;
      let job = null, log = null;
      try {
        [job, log] = await Promise.all([
          fetch(`/api/queue/${encodeURIComponent(q.id)}`).then((r) => r.json()),
          fetch(`/api/queue/${encodeURIComponent(q.id)}/log`).then((r) => r.json()),
        ]);
      } catch (e) { console.error("job:", e); return; }

      if (request && request.lock && job.status !== "queued") {
        request.lock(job.status === "running" ? "a researcher has taken it — no longer editable"
                                              : `${job.status} — no longer editable`);
      }
      meta.replaceChildren(
        el("span", { text: job.status }),
        el("span.qsep", { text: "·" }),
        el("span", { text: job.researcher || "unclaimed" }));

      stages.replaceChildren(...(job.stages || []).map((st, i, a) =>
        el("div.qstage" + (i === a.length - 1 ? ".now" : ""), {},
           [el("span.qst", { text: st.text })])));

      const lines = (log.lines || []);
      const text = lines.length ? lines.join("\n") : (log.note || "no output yet");
      if (follow) {
        if (pre.textContent !== text) pre.textContent = text;
        pre.scrollTop = pre.scrollHeight;
      } else if (text !== (pending ?? pre.textContent)) {
        pending = text;
        jump.hidden = false;
      }

      if (job.status === "running" || job.status === "queued") setTimeout(tick, 2000);
    };
    tick();
  }

  /* A small card is made whole first (whole(), above); the newest open asked for wins, so a second tap while the
     first GET is out opens one sheet, not two. */
  let opening = 0;
  function openCard(c, d, spawn, startAt = null) {
    const my = ++opening;
    if (!c.small) { openWhole(c, d, spawn, startAt); return; }
    whole(c).then(() => { if (my === opening) openWhole(c, d, spawn, startAt); },
                  (e) => { if (my === opening) toast(`${c.id} didn't open: ${e.message}`); });
  }

  /* THE AGENT MENU: the agents as tabs, then the shown agent's models (⚙'s choice marked); a tap on a model picks that
     agent and model. Shared by everything that sends work to an agent: an open card's revise and inspire, a job's resume
     and retry. `lit(a)` is the model lit for agent a; `info` an optional ⓘ in its head. */
  let menuPop = null, menuBtn = null;
  const agentMenuOn = (btn) => menuBtn === btn;
  function closeAgentMenu() {
    if (!menuPop) return;
    menuPop.remove(); menuPop = null; menuBtn = null;
    removeEventListener("pointerdown", outsideMenu, true);
    removeEventListener("scroll", closeAgentMenu, true);
  }
  function outsideMenu(e) {
    if (menuPop && !menuPop.contains(e.target) && !(menuBtn && menuBtn.contains(e.target))) closeAgentMenu();
  }
  const modelsOf = (a) => {
    const mine = (a.choice || {}).model;
    const ms = ((a.menu || []).length ? a.menu : (a.catalogue || {}).models || [])
      .map((m) => ({ id: m.id, label: m.label || m.id }));
    if (mine && !ms.some((m) => m.id === mine)) ms.unshift({ id: mine, label: mine });
    if (!mine) ms.unshift({ id: null, label: "its own default" });
    return ms;
  };
  const keepFocus = (b) => b.addEventListener("mousedown", (ev) => ev.preventDefault());
  /* The picker itself, one component: an optional head (with an ⓘ), the agents as tabs, the shown agent's models as
     rows. `lit(a)` is the model lit for agent a; a tab tap shows that agent (`onTab` hears it), a model tap picks it.
     `tab(a)` gives a tab's text and title. A stub agent (its models not loaded yet) shows no rows. */
  function agentPicker({ title = null, list, cur, lit, onPick, info = null, onTab = null, inline = false,
                         tab = (a) => ({ text: a.cli || a.name, title: a.label || a.name }) }) {
    const box = el("div.whopick" + (inline ? ".inline" : ""));
    const paint = () => {
      const on = lit(cur);
      const tabs = el("div.whotabs", {}, list.map((a) => {
        const t = tab(a);
        const b = el("button.whotab" + (a === cur ? ".on" : ""), { type: "button", text: t.text, title: t.title,
                                                                   "data-agent": a.name });
        b.onclick = (ev) => { ev.stopPropagation(); cur = a; if (onTab) onTab(a); paint(); };
        keepFocus(b);
        return b;
      }));
      const rows = cur.stub ? [] : modelsOf(cur).map((m) => {
        const b = el("button.whom" + (m.id === on ? ".on" : ""), { type: "button",
          title: `${title || "with"} ${cur.name} · ${m.id || "its own default"}` }, [el("span", { text: m.label })]);
        b.onclick = (ev) => { ev.stopPropagation(); onPick(cur, m.id); if (box.isConnected) paint(); };
        keepFocus(b);
        return b;
      });
      const unlisted = !cur.stub && !((cur.catalogue || {}).models || []).length
        ? el("div.whonote", { text: "open ⚙ once to list its models" }) : null;
      const about = info ? el("button.whoinfo", { type: "button", title: info.title(cur) }, [glyph("info", 16)]) : null;
      if (about) {
        about.onclick = (ev) => { ev.stopPropagation(); info.open(cur, on); };
        keepFocus(about);
      }
      box.replaceChildren(...[title || about ? el("div.whohead", {}, [el("span", { text: title || "" }), about].filter(Boolean)) : null,
        tabs, rows.length ? el("div.whoms", {}, rows) : null, unlisted].filter(Boolean));
    };
    paint();
    box.reload = (next, show) => { list = next; cur = show; paint(); };
    box.repaint = () => paint();
    return box;
  }
  /* …as a popover above (or below) a button: an open card's revise and inspire, a job's resume and retry. A second tap
     on the button shuts it; so does a pick. */
  function agentMenu(btn, { title, list, cur, lit, onPick, info = null }) {
    closeAgentMenu();
    menuPop = el("div.revpop.whopop", { role: "dialog", "aria-label": title }, [agentPicker({ title, list, cur, lit,
      info: info && { title: info.title, open: (a, m) => { closeAgentMenu(); info.open(a, m); } },
      onPick: (a, m) => { closeAgentMenu(); onPick(a, m); } })]);
    menuBtn = btn;
    // above its button where there is room, else below
    const r = btn.getBoundingClientRect();
    const w = Math.min(innerWidth - 16, Math.max(240, Math.round(r.width)));
    menuPop.style.width = `${w}px`;
    menuPop.style.left = `${Math.max(8, Math.min(Math.round(r.left), innerWidth - w - 8))}px`;
    if (r.top >= Math.min(320, innerHeight - r.bottom)) {
      menuPop.style.bottom = `${Math.round(innerHeight - r.top + 4)}px`;
      menuPop.style.maxHeight = `${Math.max(160, Math.round(r.top - 12))}px`;
    } else {
      menuPop.style.top = `${Math.round(r.bottom + 4)}px`;
      menuPop.style.maxHeight = `${Math.max(160, Math.round(innerHeight - r.bottom - 12))}px`;
    }
    document.body.append(menuPop);
    addEventListener("pointerdown", outsideMenu, true);
    addEventListener("scroll", closeAgentMenu, true);
  }

  function openWhole(c, d, spawn, startAt = null) {

    const isRec = (c.origin || {}).kind === "recording";

    if (listen.mutedFor !== c.id) { listen.muted.clear(); listen.mutedFor = c.id; }
    const field = el("textarea.ideabox", { rows: "2",
      placeholder: isRec ? "what to make of this recording… (optional)" : "what should change…" });
    field.value = draftGet(c.id);
    field.addEventListener("input", () => draftSet(c.id, field.value));

    const n = Math.max(1, (c.versions || []).length);

    const voteAt = (i) => ((c.versions || [])[i] || {}).vote || 0;

    let sel = Math.max(0, Math.min(n - 1, startAt ?? shownAt(c)));

    const mediaBox = el("div.cmedia");

    mediaBox.addEventListener("lanetag", (e) => {
      const tag = `lane:${e.detail}`;
      const v = field.value;
      const a = field.selectionStart ?? v.length, b = field.selectionEnd ?? v.length;
      const pre = v.slice(0, a), post = v.slice(b);
      const ins = (pre && !/\s$/.test(pre) ? " " : "") + tag + (post && /^\s/.test(post) ? "" : " ");
      field.value = pre + ins + post;
      const caret = (pre + ins).length;
      field.focus();
      field.setSelectionRange(caret, caret);
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });

    let showVideo = false;

    const viewRow = el("div.vthumbs", { hidden: "" });

    const itemRow = el("div.ithumbs", { hidden: "" });
    const itemsOf = (i) => ((c.versions || [])[i] || {}).items || [];
    let item = null;
    const itemAt = (i) => {
      const its = itemsOf(i);
      if (!its.length) return null;
      const face = ((c.versions || [])[i] || {}).face_item;
      return its.find((x) => x.id === item) || its.find((x) => x.id === face) || its[0];
    };

    const shownCard = () => {
      const it = itemAt(sel);
      if (!it) return c;
      const v = c.versions[sel];
      const vs = c.versions.slice();
      vs[sel] = { ...v, id: `${v.id}/${it.id}`, parts: it.parts || [], duration: it.duration || v.duration,
                  media: { ...(v.media || {}), audio: (it.media || {}).audio || null }, bundleItem: it.id };
      return { ...c, versions: vs };
    };
    const paintItems = () => {
      const its = itemsOf(sel), cur = itemAt(sel);
      const face = ((c.versions || [])[sel] || {}).face_item;
      itemRow.hidden = !its.length;
      itemRow.replaceChildren(...its.map((x) => {
        const len = x.duration ? `${x.duration < 10 ? x.duration.toFixed(1) : Math.round(x.duration)} s` : "";
        const b = el("button.ithumb" + (cur && x.id === cur.id ? ".on" : ""), { type: "button",
          title: `${x.label || x.id}${len ? " · " + len : ""}${x.id === face ? " · the face" : ""}`,
          "aria-label": x.id });
        const w = el("span.iwave");
        w.innerHTML = waveSvg(x.peaks, 40);
        b.append(w, el("span.iname", { text: (x.id === face ? "★" : "") + x.id }));
        b.onclick = () => {
          if (cur && x.id === cur.id) return;
          resume = versionSwitched(c);
          item = x.id;
          paintMedia(); paintDesc();
        };
        return b;
      }));
      const on = itemRow.querySelector(".ithumb.on");
      if (on) on.scrollIntoView({ block: "nearest", inline: "nearest" });
    };
    const viewsOf = (i) => ((((c.versions || [])[i] || {}).media || {}).views) || [];
    const faceOf = (i) => Math.max(0, viewsOf(i).findIndex((x) => x.face));
    const VIEW_NAME = { wholebody: "full body", newshort: "close-up" };
    let view = null;
    let trimEl = null;
    let resume = null;

    const onScreen = () => {
      const cur = (c.versions || [])[sel];
      const vnum = cur && (n > 1 || !isRec) ? cur.n ?? sel + 1 : null;
      const it = vnum != null ? itemAt(sel) : null;
      return { vnum, item: it ? it.id : null, trim: isRec && c.trim ? c.trim : null };
    };

    const seesEl = el("div.sees");
    let hearsKey = null, heard = {}, mixed = false;
    const guides = {};
    const seesBtn = el("button.seesb", { type: "button", title: "what inspire and revise hand the agent",
                                         "aria-expanded": "false" }, glyph("info", 18));
    const guideOf = (agent, kind) => {
      const k = `${agent}|${kind}`, o = onScreen();
      if (!(k in guides))
        guides[k] = guideFiles(c.type, { agent, kind, card: c.id, ...(o.vnum != null ? { version: o.vnum } : {}) })
          .then((fs) => (guides[k] = fs));
      return guides[k];
    };

    const votesSaid = () => {
      const vs = (c.versions || []).map((v, i) => ({ n: v.n ?? i + 1, vote: v.vote || 0 }));
      const held = (c.held || []).map((v) => `v${v.n}`).join(", ");
      if (vs.length + (c.held || []).length < 2) return null;
      const on = vs.filter((v) => v.vote).map((v) => `v${v.n} ${v.vote > 0 ? "▲" : "▽"}${Math.abs(v.vote)}`);
      if (!on.length) return `its versions so far (none voted yet${held ? `; ${held} held by AUTO` : ""})`;
      const runs = [];
      for (const v of vs.filter((x) => !x.vote)) {
        const r = runs[runs.length - 1];
        if (r && v.n === r[1] + 1) r[1] = v.n; else runs.push([v.n, v.n]);
      }
      const none = runs.map(([a, b]) => (a === b ? `v${a}` : `v${a}–v${b}`)).join(", ");
      return `your votes (${on.join(", ")}${none ? `; ${none} none` : ""}${held ? `; ${held} held by AUTO` : ""})`;
    };
    const paintSees = (w) => {
      const o = onScreen(), vs = c.versions || [];
      const who = w.cur ? w.cur.cli || w.cur.name : w.first || "the agent";
      const agent = w.cur ? w.cur.name : w.first;
      const kinds = isRec ? ["inspire"] : ["revise", "inspire"];
      const next = Math.max(0, ...vs.map((v, i) => v.n ?? i + 1), ...(c.held || []).map((v) => v.n || 0)) + 1;
      const what = o.item ? `${o.item} of v${o.vnum}` : o.vnum != null ? `v${o.vnum}` : null;
      const hears = (x) => (x && x.label ? `: it ${x.label}` : "");

      const word = { revise: revLbl.textContent || "revise", inspire: insLbl.textContent || "inspire" };
      const shown = what ? `${what}, the version on screen` : "this card";
      const insHears = (heard.ins || {}).label !== (heard.rev || {}).label ? hears(heard.ins) : "";
      const lines = [];
      if (!isRec) lines.push(el("div", {}, [el("b", { text: word.revise }), w.cur
        ? ` hands ${who} ${shown}, to make v${next} of this card${hears(heard.rev)}.`
        : ` asks ${who}, not an agent, for v${next} of this card, from ${shown}${hears(heard.rev)}.`]));
      lines.push(el("div", {}, [el("b", { text: word.inspire }), isRec
        ? (w.cur ? ` hands ${who} this recording, to make a new card from it${hears(heard.ins)}.`
                 : ` asks ${who}, not an agent, for a new card from this recording${hears(heard.ins)}.`)
        : (w.cur ? ` hands it the same, to make a new card from it${insHears}.`
                 : ` asks it for a new card from the same${insHears}.`)]));
      for (const k of kinds) {
        const x = heard[k === "revise" ? "rev" : "ins"];
        if (x && !x.label && x.error) lines.push(el("div.swarn", { text: `${k} can't send: ${x.error}` }));
      }
      const text = field.value.trim();
      const onCard = (c.attachments || []).filter((u) => /\/attach_/.test(u)).length;
      const imgs = [staged.length && `the ${staged.length > 1 ? `${staged.length} images` : "image"} you added`,
                    onCard && `the ${onCard > 1 ? `${onCard} images` : "image"} on this card`].filter(Boolean);
      if (!imgs.length && cap(c.type, "images") !== false) imgs.push("any images you add");
      const words = text ? `your words, "${text.length > 90 ? `${text.slice(0, 88)}…` : text}"`
        : isRec ? "what you write here — or, with nothing, its own judgement"
        : `what you write here — or, with nothing, "the same idea, taken further or fixed" (inspire: its own judgement)`;
      const guide = guideSaid(kinds, kinds.map((k) => guides[`${agent}|${k}`]));
      const more = el("button.seesmore", { type: "button", text: "the whole brief ›",
                                           title: `the brief a ${kinds[0]} would hand ${who} now, and its files` });
      more.onclick = () => {
        closeBubble();
        const lit = w.cur && w.cur.name === w.last.agent && "model" in w.last ? w.last.model ?? null
          : ((w.cur || {}).choice || {}).model ?? null;
        openConfigured({ type: c.type, agent, kind: kinds[0], card: c.id, version: o.vnum, model: lit });
      };
      seesEl.replaceChildren(...lines,
        el("div.smut", { text: w.cur ? `With them: ${andList([votesSaid(), words, ...imgs].filter(Boolean))}.${guide}`
          : `No agent reads a brief here: ${who} runs the tab's own steps.` }),
        ...(mixed ? [el("div.smix", { text: "your mutes and solo aren't sent" })] : []),
        ...(w.cur ? [more] : []));
    };
    seesBtn.onclick = async () => {
      const w = await whoNow(), agent = w.cur ? w.cur.name : w.first;
      const kinds = isRec ? ["inspire"] : ["revise", "inspire"];
      paintSees(w);
      if (!infoBubble(seesBtn, seesEl, "sees") || !w.cur) return;
      await Promise.all(kinds.map((k) => guideOf(agent, k)));
      if (seesBtn.getAttribute("aria-expanded") === "true") paintSees(w);
    };
    const paintHears = async () => {
      mixed = listen.mutedFor === c.id && listen.muted.size > 0 || (!!listen.solo && same(listen.card, c));
      const warn = () => seesBtn.classList.toggle("warn",
        mixed || [heard.ins, heard.rev].some((x) => x && !x.label && x.error));
      if (!(d.typeHears || {})[c.type] || !d.signal) { warn(); return; }
      const o = onScreen(), q = new URLSearchParams();
      if (o.vnum != null) q.set("version", o.vnum);
      if (o.item) q.set("item", o.item);
      if (o.trim) { q.set("start", o.trim.start); q.set("end", o.trim.end); }
      const shown = (shownCard().versions || [])[sel] || {};
      const key = `${q}|${(shown.parts || []).filter((p) => p.archived).map((p) => p.id).join()}`;
      if (key === hearsKey) { warn(); return; }
      hearsKey = key;
      let got = null;
      try {
        const r = await fetch(`/api/cards/${encodeURIComponent(c.id)}/source?${q}`);
        got = r.ok ? await r.json() : null;
      } catch (_) {}
      if (key !== hearsKey) return;
      heard = { ins: got && got.inspire, rev: got && !isRec ? got.revise : null };
      warn();
    };
    const paintMedia = (v) => {

      if (isRec) {
        if (!trimEl) {
          const ver = (c.versions || [])[0] || {};
          const part = (ver.parts || [])[0] || {};
          trimEl = trimEditor({
            src: part.audio || (ver.media || {}).audio || (c.media || {}).audio,
            peaks: part.peaks, duration: ver.duration, trim: c.trim,
            onSave: (t) => new Promise((ok, no) => {
              if (!d.signal) { c.trim = t; ok(); return; }
              d.signal(c.id, { kind: "trim", value: t })
                .then((fresh) => { merge(c, fresh); rebuildCard(c); paintHears(); ok(); }, no);
            }),
          });
        }
        mediaBox.replaceChildren(trimEl);
        viewRow.hidden = true;
        paintHears();
        return;
      }
      if (typeof v === "boolean") showVideo = v;
      const vs = viewsOf(sel);
      if (vs.length < 2) view = null;
      else if (view == null || view >= vs.length) view = faceOf(sel);

      const sc0 = mediaBox.querySelector(".vscroll"), keep = sc0 ? sc0.scrollTop : 0;
      mediaBox.replaceChildren(
        playing(mediaOf(shownCard(), d, { controls: true, version: sel, video: showVideo,
                                          repaint: paintMedia, view, autoplay: resume })));
      paintItems();
      paintHears();
      resume = null;
      const sc1 = mediaBox.querySelector(".vscroll");
      if (sc1 && keep) sc1.scrollTop = keep;
      viewRow.hidden = vs.length < 2;
      viewRow.replaceChildren(...(vs.length < 2 ? [] : vs.map((x, i) => {
        const b = el("button.vthumb" + (i === view ? ".on" : ""), { type: "button",
          title: VIEW_NAME[x.slug] || x.slug, "aria-label": VIEW_NAME[x.slug] || x.slug },
          [el("img", { src: thumb(x.still, 160) || x.gif, alt: "", loading: "lazy" })]);
        b.onclick = () => {
          if (b.dataset.held) { delete b.dataset.held; return; }
          if (i !== view) { view = i; paintMedia(); }
        };

        let timer = 0, sx = 0, sy = 0;
        const cancel = () => clearTimeout(timer);
        b.addEventListener("pointerdown", (e) => {
          sx = e.clientX; sy = e.clientY;
          cancel();
          timer = setTimeout(() => {
            b.dataset.held = "1";
            writeSignal(c, d, { kind: "face", value: x.slug }, () => {
              view = i;
              paintMedia();
              forgetCard(c);
              paintGrid();
              toast(`${VIEW_NAME[x.slug] || x.slug} is now this card's picture`);
            });
          }, 550);
        });
        b.addEventListener("pointermove", (e) => {
          if (Math.abs(e.clientX - sx) + Math.abs(e.clientY - sy) > 10) cancel();
        });
        ["pointerup", "pointercancel", "pointerleave"].forEach((ev) => b.addEventListener(ev, cancel));
        b.addEventListener("contextmenu", (e) => e.preventDefault());
        return b;
      })));
    };

    {
      let sx = null, sy = 0, st = 0;
      mediaBox.addEventListener("pointerdown", (e) => {
        if (viewsOf(sel).length < 2 || e.target.closest("video, .vplay, .vback")) return;
        sx = e.clientX; sy = e.clientY; st = Date.now();
      });
      mediaBox.addEventListener("pointerup", (e) => {
        if (sx == null) return;
        const dx = e.clientX - sx, dy = e.clientY - sy;
        sx = null;
        if (Math.abs(dx) < 40 || Math.abs(dx) < 1.5 * Math.abs(dy) || Date.now() - st > 900) return;
        const to = view + (dx < 0 ? 1 : -1);
        if (to >= 0 && to < viewsOf(sel).length) { view = to; paintMedia(); }
      });
      mediaBox.addEventListener("pointercancel", () => { sx = null; });
    }
    const foot = el("div.cfoot");

    const setVote = (v) => {
      writeSignal(c, d, n > 1
      ? { kind: "vote", value: v, version: (c.versions[sel] || {}).n ?? sel + 1 }
      : { kind: "vote", value: v }, () => {
        paint();
        paintPips();
        const under = foots.get(c);
        if (under) under();

        if (c.need) { const st = desc.scrollTop; paintDesc(); desc.scrollTop = st; }
      });
    };

    const tools = el("div.cutil.ftools");
    const paint = () => foot.replaceChildren(
      tools, voteCell("−", voteAt(sel), setVote), voteCell("+", voteAt(sel), setVote));
    paint();
    paintMedia();

    let vrow = null;

    let paintSplit = () => {};
    const toSel = (i) => {
      if (i < 0 || i >= n || i === sel) return;

      const was = view != null ? (viewsOf(sel)[view] || {}).slug : null;
      resume = versionSwitched(c);
      sel = i;
      item = null;
      const k = was ? viewsOf(i).findIndex((x) => x.slug === was) : -1;
      view = k >= 0 ? k : faceOf(i);
      paintPips(); paint(); paintMedia(); paintDesc();
      paintSplit();
    };
    const paintPips = () => {
      if (!vrow) return;

      const count = cap(c.type, "vote_count") && n > 1
        ? el("span.vcount", { title: "versions voted", text: `${Array.from({ length: n }, (_, i) => voteAt(i)).filter(Boolean).length} / ${n}` })
        : null;
      vrow.replaceChildren(...[count].filter(Boolean), ...Array.from({ length: n }, (_, i) => {
        const v = voteAt(i);

        const vn = ((c.versions || [])[i] || {}).n ?? i + 1;
        const b = el("button.vpip" + (i === sel ? ".on" : ""),
          { type: "button", title: `version ${vn}` },
          [el("span", { text: `v${vn}` })]);
        if (v) {

          const m = Math.min(3, Math.abs(v)), rgb = v > 0 ? UP : DOWN;
          b.append(el("i", { text: v > 0 ? "▲" : "▽" }));
          b.style.cssText = `background:rgba(${rgb},${BACK[m]});` +
            `border-color:rgba(${rgb},${EDGE[m]});` +
            `color:rgba(${v > 0 ? UP_TEXT : DOWN_TEXT},${TEXT[m]})`;
        }
        b.onclick = () => toSel(i);
        return b;
      }));

      requestAnimationFrame(() => {
        const on = vrow.querySelector(".vpip.on");
        if (!on) return;
        const l = on.offsetLeft - vrow.offsetLeft, r = l + on.offsetWidth;
        if (l < vrow.scrollLeft) vrow.scrollLeft = l - 6;
        else if (r > vrow.scrollLeft + vrow.clientWidth) vrow.scrollLeft = r - vrow.clientWidth + 6;
      });
    };

    if (n >= 1) { vrow = el("div.vrow"); paintPips(); }

    const audit = el("button.cdlog", { type: "button", title: "the log: how this card was made", text: "log ›" });
    audit.onclick = () => openAudit(c);

    const nar = c.narrative || {};

    const HUE = { claude: "ant", fable: "ant", codex: "oai",
                  antigravity: "goog", agy: "goog", gemini: "goog" };

    const makeOrig = (sp) => {

      let pc = null, pv = null, rp = null, name = null;
      const from = (c.origin || {}).from;
      const fc = from && (d.cards || []).find((y) => y.id === from.card);
      const fv = fc && (fc.versions || []).find((v) => v.id === from.version);
      const fi = fv && (fv.items || []).find((i) => i.id === from.item);
      if (fi && (fi.media || {}).audio) {
        pc = fc; pv = { duration: fi.duration, media: fi.media };
        rp = { id: fi.id, audio: fi.media.audio, peaks: fi.peaks };
        name = `${fc.name && namePrefix(fc.type) ? `${namePrefix(fc.type)}:${fc.name}` : fc.id}:${fi.id}:v${fv.n}`;
        sp = null;
      }
      for (let id = (c.lineage || {}).parent, k = 0; !pc && id && k < 6; k++) {
        const x = (d.cards || []).find((y) => y.id === id);
        if (!x) break;
        if ((x.origin || {}).kind === "recording") { pc = x; break; }
        id = (x.lineage || {}).parent;
      }
      if (!pc) return null;
      pv = pv || (pc.versions || [])[0] || {};
      rp = rp || (pv.parts || [])[0] || {};
      const recAudio = (pv.media || {}).audio || rp.audio;
      const dur = pv.duration || 0;
      const has = sp && sp.start != null && sp.dur && dur;
      const t = (x) => `${Math.floor(x / 60)}:${String(Math.round(x % 60)).padStart(2, "0")}`;
      const blk = PART_BLOCKS.voice([{ ...rp, id: `orig:${pc.id}`, label: `original · ${name || pc.label}`, time: undefined }],
        { duration: dur, tint: RECORDING_YELLOW,
          trim: has ? { a: sp.start / dur, b: Math.min(1, (sp.start + sp.dur) / dur) } : null });
      const pb = el("button.origpb", { type: "button", "aria-label": "play the original",
                                       title: "play the original — the stretch this was made from" },
                    playGlyphs(16));
      const stop = () => { pb.classList.remove("on"); delete pb.dataset.at; };
      pb.onclick = (e) => {
        e.stopPropagation();

        if (pb.classList.contains("on")) {
          const at = listen.el === player.el && player.el ? player.el.currentTime : 0;
          stopAudio(); pb.classList.remove("on");
          if (at > 0) pb.dataset.at = String(at);
          return;
        }
        const at = Number(pb.dataset.at) || 0;
        delete pb.dataset.at;
        play(pc, recAudio, { tick: lineIn(blk), done: stop,
                             ...(has ? { from: Math.max(sp.start, at), to: sp.start + sp.dur }
                                     : at ? { from: at } : {}) });
        pb.classList.add("on");
      };
      const go = el("button.origgo", { type: "button", "aria-label": "open the original recording",
                                       title: "open the original recording" }, [glyph("open", 18)]);
      go.onclick = (e) => {
        e.stopPropagation();
        closeSheet("big");
        requestAnimationFrame(() => openCard(pc, d, spawn));
      };
      return el("div.origrow", {}, [pb, el("div.origbar", {}, [blk]),
        has ? el("span.origat", { text: `${t(sp.start)}–${t(sp.start + sp.dur)}` }) : null, go].filter(Boolean));
    };
    let origRow = null, origKey;
    const paintOrig = () => {
      if (isRec) return;
      const it = itemAt(sel);
      const sp = (it && it.span) || (c.origin || {}).span;
      const key = JSON.stringify(sp || null);
      if (key !== origKey) { origKey = key; origRow = makeOrig(sp); }
    };
    const desc = el("div.cdesc");

    const moreCue = () => desc.classList.toggle("more",
      desc.scrollHeight - desc.scrollTop - desc.clientHeight > 2);
    desc.addEventListener("scroll", moreCue, { passive: true });
    let tagRO = null;
    const paintDesc = () => {
      paintOrig();
      const v = n > 1 ? (c.versions || [])[sel] || {} : {};
      const vv = (c.versions || [])[n > 1 ? sel : 0] || {};

      const rat = n > 1 && v.rationale ? v.rationale : nar.rationale;
      const why = (c.lineage || {}).why, shots = requestImages(c.attachments);
      const p = (t, cls = "") => el("div.cdp" + cls, { text: t });
      const vk = namePrefix(c.type) && c.name ? `:v${((c.versions || [])[sel] || {}).n ?? sel + 1}` : "";

      const label = vk ? "" : c.label || "";
      const lead = (t) => {
        const own = /^[^:\n]{1,58}:(?=\s)/.exec(t), bold = (head, rest) => el("div.cdp", {}, [el("b", { text: head }), rest]);
        if (own) return bold(own[0], t.slice(own[0].length));
        if (label && t.toLowerCase().startsWith(label.toLowerCase())) return bold(t.slice(0, label.length), t.slice(label.length));
        return label ? bold(`${label}: `, t) : p(t);
      };
      const cardPart = [nar.idea ? lead(nar.idea) : !rat && label ? el("div.cdp", {}, [el("b", { text: label })]) : null,
                        why && p(`asked: ${why}`, ".cdmut"), shots].filter(Boolean);
      const verPart = [rat && (nar.idea ? p(rat) : lead(rat)), (vv.notes || []).length && p(vv.notes.join(" · "), ".cdmut"),
        ...abFacts(vv, c).map(([k, t]) => el("div.cdfact", {}, [el("span.cdfk", { text: k }),
          typeof t === "string" ? el("span", { text: ` ${t}` }) : t]))].filter(Boolean);
      const part = (kids) => kids.length ? el("div.cdsec", {}, kids) : null;

      const it = itemAt(sel);

      const ref = (it ? `${refOf(c, sel)}:${it.id}` : refOf(c, sel)) + vk;

      const ids = el("span.cdid", { role: "button", tabindex: "0", title: `tap to copy ${ref}`,
                                    text: ref });
      ids.onclick = async () => {
        try { await navigator.clipboard.writeText(ref); toast(`copied ${ref}`); }
        catch (_) { toast(ref); }
      };

      const made = madeChips(vv, c), tags = made.map((x) => x.text);

      const hueOf = (i) => made[i].agent && HUE[String(made[i].text).toLowerCase()];
      const chip = (t, i) => el("span.cdtag" + (made[i].method ? ".m" : "") + (hueOf(i) ? ".ag" : ""),
                                { text: t, title: made[i].title, style: hueOf(i) ? `--ag:var(--${hueOf(i)}-text)` : null });
      let cut = tags.length > 1 ? 1 : tags.length;
      for (let k = 1, best = Infinity; k < tags.length; k++) {
        const a = tags.slice(0, k).join("").length + 2 * k, b = tags.slice(k).join("").length + 2 * (tags.length - k);
        if (Math.max(a, b) < best) { best = Math.max(a, b); cut = k; }
      }

      const rows = (k) => [el("div.cdtr", {}, tags.slice(0, k).map(chip)),
                           k < tags.length && el("div.cdtr", {}, tags.slice(k).map((t, i) => chip(t, k + i)))];
      const tagIn = el("div.cdtin", {}, rows(tags.length));
      const tagBox = tags.length ? el("div.cdtags", {}, [tagIn]) : null;
      if (tagRO) tagRO.disconnect();
      tagRO = null;
      if (tagBox) {
        const edge = () => {
          const s = Math.abs(tagBox.scrollLeft), max = tagBox.scrollWidth - tagBox.clientWidth;
          tagBox.classList.toggle("fl", s < max - 1);
          tagBox.classList.toggle("fr", s > 1);
        };
        tagBox.addEventListener("scroll", edge, { passive: true });
        tagRO = new ResizeObserver(edge);
        tagRO.observe(tagBox);
      }
      const topRow = el("div.cdtrow", {}, [ids, tagBox].filter(Boolean));

      desc.classList.toggle("orig", !!origRow);
      desc.replaceChildren(...[topRow, origRow, part(cardPart), part(verPart), audit].filter(Boolean));
      desc.scrollTop = 0;
      const fit = (tries = 0) => {
        if (tagBox && !tagBox.isConnected) { if (tries < 10) requestAnimationFrame(() => fit(tries + 1)); return; }
        if (tagBox && tagBox.scrollWidth > tagBox.clientWidth + 1) tagIn.replaceChildren(...rows(cut).filter(Boolean));
        moreCue();
      };
      requestAnimationFrame(() => fit());
    };
    paintDesc();

    const arch = c.archived
      ? el("button.wide", { type: "button", title: "unarchive — back on the grid" },
           [glyph("archive", 18), el("span", { text: " unarchive" })])
      : el("button", { type: "button", title: "archive — never deleted" },
           glyph("archive", 18));

    arch.onclick = () => writeSignal(c, d, { kind: "archive", value: !c.archived },
      () => { closeSheet("big"); paintGrid(); });

    const poolBtn = el("button.poolbtn.wide", { type: "button" });
    const inPool = () => (c.pools || []).includes("auto");
    const paintPool = () => {
      poolBtn.replaceChildren(glyph(inPool() ? "check" : "plus", 15), glyph("pool", 17));
      poolBtn.classList.toggle("on", inPool());
      poolBtn.title = inPool() ? "in the auto pool: AUTO makes from it — tap to take it out"
                               : "add it to the auto pool: AUTO makes from the cards marked here";
    };
    paintPool();
    poolBtn.onclick = () => writeSignal(c, d, { kind: "pool", pool: "auto", value: !inPool() },
      () => { paintPool(); paintGrid(); autoChanged(); });

    const staged = [];
    const send = (kind, who = null) => async () => {
      const text = field.value.trim();
      const files = staged.splice(0);
      field.value = "";

      draftSet(c.id, "");
      paintStage();
      closePop();
      closeSheet("big");

      const { vnum, item: shownItem, trim: shownTrim } = onScreen();
      const base = { ...(shownTrim ? { trim: shownTrim } : {}), ...(shownItem ? { item: shownItem } : {}) };

      const meths = (d.typeMethods || {})[c.type] || [];
      const method = (d.typeMethodDefault || {})[c.type] || (meths[0] || {}).id || null;
      const N = howMany();
      const ok = await spawn(kind, c, text, files.map((f) => f.url), vnum,
                             { ...base, ...(method ? { method } : {}), ...(N > 1 ? { count: N } : {}), ...(who || {}) });
      const label = `${kind}${N > 1 ? ` ×${N}` : ""}${who ? ` · ${[who.backend, who.model].filter(Boolean).join(" · ")}` : ""}`;
      if (ok === false) {
        if (text && !draftGet(c.id)) draftSet(c.id, text);
        toast(`NOT queued: ${label}${text ? " — your words are back on the card" : ""}`
              + `${files.length ? "; add the images again" : ""}`);
      } else if (N > 1) {
        toast(`${label} queued`);
      }
    };

    const hold = (b) => b.addEventListener("mousedown", (ev) => ev.preventDefault());
    const insLbl = el("span"), revLbl = el("span");
    const ins = el("button", { type: "button",
                   title: isRec ? "an agent makes a card from this recording" : "a new card derived from it" },
                   [kindIcon("inspire", 13), insLbl]);
    const rev = el("button", { type: "button", title: "a new version of this card" },
                   [kindIcon("revise", 13), revLbl]);

    const MAXN = 8;
    let revN = 1;
    const howMany = () => revN;

    const howBtn = el("button.revn", { type: "button", title: "how many — inspire or revise makes this many, in one session",
                                       "aria-label": "how many revisions", "aria-haspopup": "listbox" });
    const paintN = () => {
      howBtn.textContent = String(revN);

      if (isRec) insLbl.textContent = revN > 1 ? "make cards" : "make a card";
      howBtn.classList.toggle("many", revN > 1);
    };
    let pop = null;
    const closePop = () => {
      if (!pop) return;
      pop.remove(); pop = null;
      removeEventListener("pointerdown", outside, true);
      removeEventListener("scroll", closePop, true);
    };
    const outside = (e) => { if (pop && !pop.contains(e.target) && e.target !== howBtn) closePop(); };
    howBtn.onclick = (e) => {
      e.stopPropagation();
      if (pop) { closePop(); return; }
      const r = howBtn.getBoundingClientRect();
      pop = el("div.revpop", { role: "listbox" },
        Array.from({ length: MAXN }, (_, i) => MAXN - i).map((k) => {
          const it = el("button.revpi" + (k === revN ? ".on" : ""), { type: "button", role: "option",
                                                                   text: String(k) });
          it.onclick = (ev) => { ev.stopPropagation(); revN = k; paintN(); closePop(); };
          return it;
        }));
      pop.style.left = `${Math.round(r.left)}px`;
      pop.style.width = `${Math.round(r.width)}px`;
      pop.style.bottom = `${Math.round(innerHeight - r.top + 4)}px`;
      document.body.append(pop);
      addEventListener("pointerdown", outside, true);
      addEventListener("scroll", closePop, true);
    };
    paintN();
    if (!isRec) insLbl.textContent = "inspire";
    revLbl.textContent = "revise";

    const agentsP = fetch("/api/agents?cached=1").then((r) => r.json()).catch(() => ({}));
    const whoKey = `sendWho.${c.type}`;

    const whoNow = async () => {
      const ag = await agentsP;
      const t = (ag.types || []).find((x) => x.type === c.type) || {};
      const list = (ag.agents || []).filter((a) => a.installed !== false
        && (!(t.agents || []).length || t.agents.includes(a.name)));
      let last = {};
      try { last = JSON.parse(localStorage.getItem(whoKey) || "{}") || {}; } catch (_) {}
      const first = (TYPES[c.type] || {}).runs || (t.agents || [])[0] || null;
      return { list, last, first,
               cur: list.find((a) => a.name === last.agent) || list[0]
                 || (ag.agents || []).find((a) => a.name === first) || null };
    };
    const ask = (kind, btn) => async (e) => {
      if (e) e.stopPropagation();
      closePop();
      if (agentMenuOn(btn)) { closeAgentMenu(); return; }
      const { list, last, cur } = await whoNow();
      if (!list.length) return send(kind)();
      agentMenu(btn, { title: `${kind} with`, list, cur,
        lit: (a) => (a.name === last.agent && "model" in last ? last.model ?? null : (a.choice || {}).model ?? null),
        onPick: (a, model) => {
          try { localStorage.setItem(whoKey, JSON.stringify({ agent: a.name, model })); } catch (_) {}
          send(kind, { backend: a.name, ...(model ? { model } : {}) })();
        },
        info: { title: (a) => `what this ${kind} would run with ${a.name}, as configured`,
                open: (a, model) => openConfigured({ type: c.type, agent: a.name, kind, card: c.id,
                                                     version: onScreen().vnum, model }) } });
    };
    ins.onclick = ask("inspire", ins);
    rev.onclick = ask("revise", rev);
    hold(ins); hold(rev);

    const strip = el("div.stage", { hidden: "" });
    const paintStage = () => {
      strip.replaceChildren(...staged.map((sf, i) => {
        const t = el("div.sthumb", {}, [
          el("img", { src: sf.url, alt: "" }),
          el("button", { type: "button", title: "remove" }, [glyph("cut", 12)]),
        ]);
        t.querySelector("button").onclick = () => { staged.splice(i, 1); paintStage(); };
        return t;
      }));
      strip.hidden = staged.length === 0;
    };
    const take = (file) => {
      if (!file || !/^image\//.test(file.type)) return;
      const fr = new FileReader();
      fr.onload = () => { staged.push({ url: String(fr.result) }); paintStage(); };
      fr.readAsDataURL(file);
    };
    const pick = el("input", { type: "file", accept: "image/*", hidden: "" });
    pick.onchange = () => { [...pick.files].forEach(take); pick.value = ""; };
    const clip = el("button", { type: "button", title: "attach an image" },
                    glyph("image", 15));
    clip.onclick = () => pick.click();

    field.addEventListener("paste", (ev) => {
      const items = [...((ev.clipboardData || {}).items || [])];
      const imgs = items.filter((it) => it.kind === "file" && /^image\//.test(it.type));
      if (!imgs.length) return;
      ev.preventDefault();
      imgs.forEach((it) => take(it.getAsFile()));
    });

    const body = el("div.sbody", {}, [
      mediaBox,
      field, strip, pick,

      el("div.acts" + (isRec ? ".rec" : ""), {},
         (isRec ? [seesBtn, clip, ins, howBtn] : [seesBtn, clip, ins, rev, howBtn])
           .filter((b) => b && (cap(c.type, "images") !== false || b !== clip))), desc,
    ].filter(Boolean));

    const splitBtn = el("button", { type: "button", title: "take this version out into a new stack" },
                        glyph("split", 18));
    paintSplit = () => {
      splitBtn.hidden = !(n > 1 && sel > 0 && cap(c.type, "split"));
    };
    paintSplit();
    splitBtn.onclick = async () => {
      const k = ((c.versions || [])[sel] || {}).n ?? sel + 1, ref = refOf(c, sel);
      if (!confirm(`Take v${k} (${ref}) out of this stack, into a new stack of its own?\n\n` +
                   "Its vote goes with it. This can't be undone.")) return;
      try {
        const r = await fetch(`/api/cards/${encodeURIComponent(c.id)}/split`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ version: k }) });
        const b = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(b.description || b.err || `${r.status}`);
        toast(`${ref} is a stack of its own now`);
        closeSheet("big");
        if (d.reload) { await d.reload(onTypes()); paintGrid(); }
      } catch (e) { toast(`not taken out: ${e.message}`); }
    };

    const dupBtn = el("button", { type: "button", title: "duplicate this version as a new card" },
                      glyph("dup", 18));
    dupBtn.hidden = !cap(c.type, "duplicate");
    dupBtn.onclick = async () => {
      const k = ((c.versions || [])[sel] || {}).n ?? sel + 1;
      dupBtn.disabled = true;
      try {
        const r = await fetch(`/api/cards/${encodeURIComponent(c.id)}/duplicate`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ version: k }) });
        const b = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(b.description || `${r.status}`);
        toast(`copied → ${b.card}`);
        closeSheet("big");
        if (d.reload) { await d.reload(onTypes()); paintGrid(); }
        const nc = (d.cards || []).find((x) => x.id === b.card);
        if (nc) requestAnimationFrame(() => openCard(nc, d, spawnNow));
      } catch (e) { toast(`not duplicated: ${e.message}`); dupBtn.disabled = false; }
    };

    const dlBtn = el("button", { type: "button", title: "download as .m4a — this version, as you hear it" },
                     glyph("download", 18));
    dlBtn.hidden = !(c.versions || []).some((v) => (v.media || {}).audio || (v.parts || []).some((p) => p.audio));
    dlBtn.onclick = () => {
      const v = (c.versions || [])[sel] || {};
      const q = new URLSearchParams();
      if (n > 1) q.set("version", v.n ?? sel + 1);

      const bands = (v.parts || []).filter((p) => p.audio && p.kind === "voice");
      const off = (p) => p.archived || (listen.mutedFor === c.id && listen.muted.has(p.id));
      if (bands.some(off)) {
        const on = bands.filter((p) => !off(p));
        if (!on.length) { toast("every band is muted — nothing to download"); return; }
        q.set("bands", on.map((p) => p.id).join(","));
      }
      if (isRec && c.trim) { q.set("start", c.trim.start); q.set("end", c.trim.end); }
      // the browser's own download (a phone saves only that); its response sets dl_<token> once the file is made
      const token = Math.random().toString(36).slice(2, 12);
      q.set("token", token);
      const a = el("a", { href: `/api/cards/${encodeURIComponent(c.id)}/download?${q}`, download: "" });
      document.body.append(a); a.click(); a.remove();
      toast(`making the .m4a${q.has("bands") ? " (without the muted bands)" : ""}…`);
      dlBtn.classList.add("busy");
      const t0 = Date.now();
      const poll = setInterval(() => {
        const made = document.cookie.split("; ").some((x) => x.startsWith(`dl_${token}=`));
        if (!made && Date.now() - t0 < 180000) return;
        clearInterval(poll);
        dlBtn.classList.remove("busy");
        document.cookie = `dl_${token}=; max-age=0; path=/`;
      }, 300);
    };

    tools.append(...[poolBtn, arch, dupBtn, splitBtn, dlBtn].filter(Boolean));

    const anyViews = Array.from({ length: n }, (_, i) => viewsOf(i).length > 1).some(Boolean);
    const anyItems = Array.from({ length: n }, (_, i) => itemsOf(i).length > 0).some(Boolean);
    const bar = vrow || anyViews || anyItems ? el("div.cbar", {}, [
      anyItems ? itemRow : null, viewRow, vrow ? el("div.vbox", {}, [vrow]) : null].filter(Boolean)) : null;

    gifPoint = null; clearTimeout(pointWait); clearTimeout(pointLeave);
    if (animOf(gifLive)) { gifStop(gifLive); gifLive = null; gridPausedBySheet = true; }
    openSheet("big", ...[body, bar, foot].filter(Boolean));
    auxPlay();
  }

  return { css, render };
}
