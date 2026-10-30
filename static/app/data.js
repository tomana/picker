/* Render server shapes directly; fabricated fallback data would conceal API failures. */

const j = async (url) => {
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) throw new Error(`${url} → ${r.status}`);
  return r.json();
};

/* Draw the server-folded result, not optimistic local state. */

export async function signal(id, body) {
  const r = await fetch(`/api/cards/${encodeURIComponent(id)}/signal`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`signal ${id} → ${r.status}`);
  return r.json();
}

/* Queue writes return folded jobs; redraw from those rather than guessing state. */

export const queue = {
  /* Failed jobs remain visible until retry or dismissal. */

  async list({ open = false } = {}) {
    const q = open ? "?open=1" : "";

    return ((await j(`/api/queue${q}`)).queue || []).filter((x) => x.kind !== "ping");
  },

  async retry(id, agent = null, model = undefined) {   // model: undefined keeps the job's, null its agent's own
    const r = await fetch(`/api/queue/${encodeURIComponent(id)}/retry`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...(agent ? { agent } : {}), ...(model !== undefined ? { model } : {}) }),
    });
    const b = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(b.err || `retry ${id} → ${r.status}`);
    return b;
  },
  async dismiss(id) {
    const r = await fetch(`/api/queue/${encodeURIComponent(id)}/dismiss`, { method: "POST" });
    if (!r.ok) throw new Error(`dismiss ${id} → ${r.status}`);
    return r.json();
  },
  async add(body) {
    const r = await fetch("/api/queue", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`enqueue → ${r.status}`);
    return r.json();
  },
  async edit(id, text) {
    const r = await fetch(`/api/queue/${encodeURIComponent(id)}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    /* A claim conflict leaves the running job unchanged; do not overwrite its claimed text. */

    if (r.status === 409) return null;
    if (!r.ok) throw new Error(`edit ${id} → ${r.status}`);
    return r.json();
  },

  async pause(id) {
    const r = await fetch(`/api/queue/${encodeURIComponent(id)}/pause`, { method: "POST" });
    const b = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(b.err || `pause ${id} → ${r.status}`);
    return b;
  },
  async resume(id, agent = null, model = undefined) {   // model: undefined keeps the job's, null its agent's own
    const r = await fetch(`/api/queue/${encodeURIComponent(id)}/resume`, { method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...(agent ? { agent } : {}), ...(model !== undefined ? { model } : {}) }) });
    const b = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(b.err || `resume ${id} → ${r.status}`);
    return b;
  },
  async cancel(id) {
    const r = await fetch(`/api/queue/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (r.status === 409) return null;
    if (!r.ok) throw new Error(`cancel ${id} → ${r.status}`);
    return r.json();
  },
};

/* Stale and unavailable usage must remain distinct from fresh zero usage. */

const POOLS = [
  { src: "anthropic", pool: "ant", name: "claude",
    rows: [["session", "s", "var(--ant)"], ["weekly", "w", "var(--ant-deep)"]] },
  { src: "codex", pool: "oai", name: "codex",
    rows: [["session", "s", "var(--oai)"], ["weekly", "w", "var(--oai-deep)"]] },
  /* Usage windows are source-specific; do not merge model families. */

  { src: "agy", pool: "agy", name: "agy", rows: [] },
];

function until(iso) {
  if (!iso) return "";
  const secs = (new Date(iso).getTime() - Date.now()) / 1000;
  if (!isFinite(secs) || secs <= 0) return "";
  const d = Math.floor(secs / 86400), h = Math.floor((secs % 86400) / 3600),
        m = Math.floor((secs % 3600) / 60);
  return d ? ` / ${d}d${h}h` : ` / ${h}h${m}m`;
}

/* An agent's highest use outside its weekly windows, for its lit model: an agent with pools (agy) counts only the pool
   whose model patterns hold the model; no model, every pool. */
export function sessionPct(src, model) {
  const hit = (p) => (p.endsWith("*") ? model.startsWith(p.slice(0, -1)) : model === p);
  const pool = model && Object.entries(src.groups || {}).find(([, g]) => (g.model_patterns || []).some(hit));
  const used = (src.windows || []).filter((w) => w.used_pct != null && !/(_week|:weekly)$/.test(w.key)
                                           && (!pool || w.group === pool[0]));
  return used.length ? Math.round(Math.max(...used.map((w) => w.used_pct))) : null;
}

export function mapUsage(payload) {
  const usage = [];
  for (const P of POOLS) {
    const src = (payload.sources || {})[P.src] || {};
    const dim = !!src.stale;
    const windowOf = (key) => (src.windows || []).find((w) => w.key === key) || {};
    let rows = P.rows;
    if (P.src === "agy") {
      // always its two pools, gemini then claude/gpt (a missing one reads "—"); a pool with no family (one model's
      // own quota) isn't shown
      const pools = [["gemini", "g", "goog", "Gemini"], ["claude_gpt", "c+g", "goog", "Claude/GPT"]];
      rows = pools.flatMap(([family, short, colour, name]) => {
        const keys = (Object.values(src.groups || {}).find((g) => g.family === family) || {}).windows || {};
        return ["5h", "weekly"].map((p) => [keys[p] || "", p === "5h" ? short : "w",
          `var(--${colour}${p === "weekly" ? "-deep" : ""})`, family, name, p]);
      });
    }
    for (const [key, label, color, column, groupName, period] of rows) {
      const w = windowOf(key);
      const known = src.available !== false && Number.isFinite(w.used_pct);
      const pct = known ? Math.round(w.used_pct) : 0;
      /* An authentication failure is not an empty usage reading. */

      const why = src.missing ? `${src.missing} CLI not installed` : /\b401\b/.test(src.error || "") ? "locked" : "—";
      const title = groupName ? `${groupName} ${period === "weekly" ? "week" : period}` : label;
      let caption = known ? `${title}: ${pct}%${until(w.resets_at)}` : `${title}: ${why}${column ? until(w.resets_at) : ""}`;
      if (src.cap_note) caption += ` · ${src.cap_note}`;

      const text = color.replace(/^var\((--[\w-]+)\)$/, "var($1-text)");

      usage.push({ pool: P.pool, src: P.src, name: P.name, label, pct, color, text, caption,
                   ...(column ? {column, period} : {}),
                   ...(src.cap_note && key === src.cap_window ? {capNote: src.cap_note,
                     capUnknown: src.cap_note.includes("unknown"), sessionCap: src.session_cap} : {}),
                   left: known ? until(w.resets_at).replace(" / ", "") : "",
                   ...(dim ? { dim: true } : {}),
                   ...(known ? {} : { unknown: true }), ...(src.missing ? { missing: src.missing } : {}) });
    }
  }
  return { usage };
}

/* Preference writes are fire-and-forget; failure must not undo a visible toggle. */

export async function saveFilters(slugs) {
  savePref("filters", slugs);
}

/* Keep immediate panel state in memory; persist it for other devices and future loads. */

export const panels = { open: {} };

export function panelOpen(surface, type, dflt = true) {
  const v = panels.open[`${surface}:${type}`];
  return v === undefined ? dflt : !!v;
}

export function setPanelOpen(surface, type, open) {
  const k = `${surface}:${type}`;
  /* Write only changed preferences to avoid redundant append-only log entries. */

  if (panels.open[k] === !!open) return;
  panels.open[k] = !!open;
  savePref("panels", panels.open);
}

/* Serialize preference writes: last-write-wins folding must preserve the order of user actions. */

let prefQueue = Promise.resolve();

function savePref(key, value) {
  /* Snapshot before enqueueing; later mutations must not rewrite queued request bodies. */

  const body = JSON.stringify({ [key]: value });
  prefQueue = prefQueue.then(() => fetch("/api/prefs", {
    method: "PATCH", headers: { "Content-Type": "application/json" }, body,
  })).catch((e) => { console.warn("prefs:", e.message); });
  return prefQueue;
}

/* Close reorder only after save succeeds; retain the draft on failure. */

function saveTabOrder(slugs) {
  const body = JSON.stringify({ tab_order: slugs });
  const p = prefQueue.then(() => fetch("/api/prefs", { method: "PATCH", headers: { "Content-Type": "application/json" }, body }))
    .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); });
  prefQueue = p.catch(() => {});
  return p;
}

export const arrange = {
  async list(type) {
    const q = type ? `?type=${encodeURIComponent(type)}` : "";
    return (await j(`/api/arrangements${q}`)).arrangements || [];
  },
  async create(type, name) {
    const r = await fetch("/api/arrangements", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type, name }),
    });
    if (!r.ok) throw new Error(`arrange create → ${r.status}`);
    return r.json();
  },
  /* Validate clip references on placement, not during a later read. */

  async putClip(aid, body) {
    const r = await fetch(`/api/arrangements/${encodeURIComponent(aid)}/clips`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`clip → ${r.status}`);
    return r.json();
  },
  async rename(aid, name) {
    const r = await fetch(`/api/arrangements/${encodeURIComponent(aid)}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    if (!r.ok) throw new Error(`rename → ${r.status}`);
    return r.json();
  },
  async remove(aid) {
    const r = await fetch(`/api/arrangements/${encodeURIComponent(aid)}`,
                          { method: "DELETE" });
    if (!r.ok) throw new Error(`delete → ${r.status}`);
    return r.json();
  },
  /* Return render URLs directly so the timeline can cache decoded buffers by URL. */

  renderAt(ref, secs) {
    const q = new URLSearchParams({ card: ref.card, part: ref.part,
                                    len: String(secs) });
    if (ref.version != null) q.set("version", String(ref.version));
    return `/api/arrangements/render?${q}`;
  },
  async delClip(aid, cid) {
    const r = await fetch(
      `/api/arrangements/${encodeURIComponent(aid)}/clips/${encodeURIComponent(cid)}`,
      { method: "DELETE" });
    if (!r.ok) throw new Error(`unclip → ${r.status}`);
    return r.json();
  },
};

/* Cup position belongs to the server decision log, not a second client-side bracket. */

export const cup = {

  async status(type) {
    return j(`/api/cup?type=${encodeURIComponent(type)}`);
  },
  async open(type) {
    return post("/api/cup", { type });
  },
  async pick(id, group, picks) {
    return post(`/api/cup/${encodeURIComponent(id)}/pick`, { group, picks });
  },
  async duel(id, a, b, winner) {
    return post(`/api/cup/${encodeURIComponent(id)}/duel`, { a, b, winner });
  },
};

/* Report the server reason, not just the status code, for rejected writes. */

async function post(url, body) {
  const r = await fetch(url, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error((await r.text()).trim() || `${url} → ${r.status}`);
  return r.json();
}

/* a type's first page of cards: page.js builds its first 24 at once (FIRST, beside cardEl); the rest in pages of REST */
const FIRST_PAGE = 24, REST = 1000;

export async function load() {
  /* Paint cards before waiting for independent usage, queue and arrangement reads. */

  const boot = window.pickerBoot || {};          /* asked by the shell while the scripts came (shell.html) */
  const [{ types }, saved, auto0] = await Promise.all([
    boot.types || j("/api/types"),
    /* Load shared filters with types; the first card request depends on both. */

    boot.prefs || j("/api/prefs").catch(() => ({})),

    boot.auto || j("/api/auto").catch(() => null),
  ]);

  /* Seed panel state before first paint to avoid flashing closed panels open. */

  panels.open = (saved && typeof saved.panels === "object" && saved.panels) || {};

  /* A URL-selected tab is temporary and must not overwrite saved filters. */

  const asked = new URLSearchParams(location.search).get("tab");
  const want = asked ? [asked] : (Array.isArray(saved.filters) ? saved.filters : null);
  const known = new Set(types.map((t) => t.type));
  /* Keep saved tab order; append unfamiliar types in config order. */

  const ord = Array.isArray(saved.tab_order) ? [...new Set(saved.tab_order)].filter((x) => known.has(x)) : [];
  const ordered = [...ord.map((x) => types.find((t) => t.type === x)), ...types.filter((t) => !ord.includes(t.type))];

  const one = (want || []).find((x) => known.has(x)) || (ordered[0] || {}).type;
  const filters = ordered.map((t) => ({ slug: t.type, on: t.type === one }));
  const on = filters.filter((f) => f.on).map((f) => f.slug);

  /* Start independent requests before awaiting cards. */

  const usageP = j("/api/usage/all").then(mapUsage).catch(() => null);
  const queueP = queue.list({ open: true }).catch(() => []);
  const arrP = Promise.all(on.map((t) => arrange.list(t).catch(() => []))).then(
    (ls) => ls.flat());

  /* Only the newest request for each type may apply; remaining pages share the first page generation. */

  const gen = new Map(), heads = new Map();
  const take = (t) => { const g = (gen.get(t) || 0) + 1; gen.set(t, g); return g; };
  const firstOf = on.map(take);

  const early = on.length && boot.cards ? await boot.cards : null;
  const lists = early && boot.cardsType === on[0] && Array.isArray(early.cards) ? [early]
    : await Promise.all(on.map((t) => j(`/api/cards?type=${encodeURIComponent(t)}&limit=${FIRST_PAGE}`)));
  const cards = lists.flatMap((l) => l.cards);
  on.forEach((t, i) => heads.set(t, lists[i].gen));

  const out = {

    typeAgents: Object.fromEntries((types || []).map((t) =>
      [t.type, (t.agents || []).filter((a) => a !== "sweep")])),

    typeMethods: Object.fromEntries((types || []).map((t) => [t.type, t.methods || []])),
    typeMethodDefault: Object.fromEntries((types || []).map((t) => [t.type, t.default_method || null])),
    /* Read source context through manifest capabilities, not type-specific branches. */
    typeHears: Object.fromEntries((types || []).map((t) => [t.type, !!(t.capabilities || {}).hears])),
    /* Type words and capabilities come from manifests so renaming a type does not change behavior. */

    typeInfo: Object.fromEntries((types || []).map((t) => [t.type, {
      label: t.label || t.type, short: t.short || t.label || t.type, name_prefix: t.name_prefix || null,
      kind: t.kind || null, capabilities: t.capabilities || {}, auto_placeholder: t.auto_placeholder || null,

      runs: (t.start || []).includes("--agent") ? t.start[t.start.indexOf("--agent") + 1] || null : (t.agents || [])[0] || null,
    }])),
    /* Unknown usage must not appear as fabricated quota. */
    ...mapUsage({}),

    compose: Object.fromEntries((types || []).filter((t) => (t.capabilities || {}).timeline)
      .map((t) => [t.type, { kind: "timeline" }])),
    filters,
    auto: auto0 && auto0.settings ? auto0 : null,
    cards,
    queue: [],
    q: queue,
    arrange,
    cup,
    saveFilters,
    saveTabOrder,
    panelOpen, setPanelOpen,   /* Fetch arrangements with the grid so its leading panel does not arrive as a separate layout shift. */

    arrangements: [],

    signal,               /* Repaint as independent data arrives rather than delaying first paint for all requests. */

    onUpdate: () => {},
    /* Appending card pages must repaint only the grid, preserving existing card elements. */

    onCards: () => out.onUpdate(),
  };

  /* Page through one generation in order; abandon stale requests and restart on expired generations. */

  const paging = new Map();
  const rest = (t, g, n) => {
    const p = pages(t, g, n);
    paging.set(t, p);
    p.finally(() => { if (paging.get(t) === p) paging.delete(t); });
    return p;
  };
  const pages = async (t, g, n) => {
    try {
      for (let more = 1; more > 0 && gen.get(t) === g;) {
        const r = await fetch(`/api/cards?type=${encodeURIComponent(t)}&gen=${encodeURIComponent(heads.get(t))}`
                              + `&skip=${n}&limit=${REST}`, { cache: "no-store" });
        if (gen.get(t) !== g) return;
        if (r.status === 410) { await whole(t); out.onCards(); return; }
        if (!r.ok) throw new Error(`→ ${r.status}`);
        const l = await r.json();
        if (gen.get(t) !== g) return;
        const have = new Set(out.cards.filter((c) => c.type === t).map((c) => c.id));
        out.cards.push(...l.cards.filter((c) => !have.has(c.id)));
        n += l.cards.length;
        more = l.more;
        out.onCards();
      }
    } catch (e) { console.error(`${t}: the cards after the first ${n}:`, e); }
  };
  on.forEach((t, i) => { if (lists[i].more) rest(t, firstOf[i], lists[i].cards.length); });

  /* Mutate shared data in place so cached elements retain valid references. */

  usageP.then((live) => {
    /* Retry an unknown initial usage reading once without waiting for the regular interval. */

    if (!live || live.usage.some((u) => u.unknown && !u.missing)) setTimeout(() => out.refreshUsage(), 10000);
    if (!live) return;
    out.usage = live.usage;
    out.onUpdate();
  });
  /* Refresh usage in place without repainting open cards or disturbing scroll position. */

  out.stamp = () => j("/api/cards/stamp").then((r) => r.stamp).catch(() => null);

  out.refreshUsage = async (src) => {
    const live = await j(`/api/usage/all${src ? `?refresh=${src}` : ""}`).then(mapUsage).catch(() => null);
    if (!live) return;
    out.usage.splice(0, out.usage.length, ...live.usage);
    if (out.onUsage) out.onUsage();
  };
  queueP.then((rows) => {
    if (!rows.length) return;
    out.queue.push(...rows);
    out.onUpdate();
  });
  arrP.then((rows) => {
    if (!rows.length) return;
    out.arrangements.push(...rows);
    out.onUpdate();
  });

  /* Reload explicit types from the caller; local filter state may differ from the loader snapshot. */

  const onTypes = (types) =>
    types || out.filters.filter((f) => f.on).map((f) => f.slug);

  out.reloadArrangements = async (types) => {
    const lists = await Promise.all(
      onTypes(types).map((t) => arrange.list(t).catch(() => [])));
    out.arrangements.length = 0;
    out.arrangements.push(...lists.flat());
  };

  /* Fetch archived cards only on demand, never with the active grid. */

  out.archived = async (types) => {
    const lists = await Promise.all(onTypes(types).map((t) =>
      j(`/api/cards?type=${encodeURIComponent(t)}&archived=1`)));
    return lists.flatMap((l) => l.cards).filter((c) => c.archived);
  };

  /* Apply only the newest answer for requested types; preserve other types until their own refresh. */

  const replaceType = (t, cards) => {
    /* Need-ordered cards retain their visible order after votes; insert newly discovered cards first. */

    const was = out.cards.filter((c) => c.type === t).map((c) => c.id);
    if (((out.typeInfo[t] || {}).capabilities || {}).need && was.length) {
      const at = new Map(was.map((id, i) => [id, i]));
      cards = [...cards.filter((c) => !at.has(c.id)),
               ...cards.filter((c) => at.has(c.id)).sort((a, b) => at.get(a.id) - at.get(b.id))];
    }
    for (let i = out.cards.length - 1; i >= 0; i--) if (out.cards[i].type === t) out.cards.splice(i, 1);
    out.cards.push(...cards);
  };
  /* a type's cards read again from the start: its first page now, the rest after it (`rest`) */
  const whole = async (t) => {
    const g = take(t);
    const l = await j(`/api/cards?type=${encodeURIComponent(t)}&limit=${FIRST_PAGE}`);
    if (gen.get(t) !== g) return;
    replaceType(t, l.cards);
    heads.set(t, l.gen);
    if (l.more) rest(t, g, l.cards.length);
  };
  /* Apply generation deltas in place; fall back to a full type fetch when no delta is available. */

  const changes = (t, l) => {
    const gone = new Set(l.removed), fresh = new Map(l.changed.map((c) => [c.id, c]));
    for (let i = out.cards.length - 1; i >= 0; i--) {
      const c = out.cards[i];
      if (c.type !== t) continue;
      if (gone.has(c.id)) out.cards.splice(i, 1);
      else if (fresh.has(c.id)) { out.cards[i] = fresh.get(c.id); fresh.delete(c.id); }
    }
    const at = out.cards.findIndex((c) => c.type === t);
    out.cards.splice(at < 0 ? out.cards.length : at, 0, ...fresh.values());
    if (!((out.typeInfo[t] || {}).capabilities || {}).need) {
      const slots = [], mine = [];
      out.cards.forEach((c, i) => { if (c.type === t) { slots.push(i); mine.push(c); } });
      mine.sort((a, b) => (b.updated || 0) - (a.updated || 0));
      slots.forEach((i, k) => { out.cards[i] = mine[k]; });
    }
  };
  out.reload = async (types) => {
    const want = onTypes(types);
    await Promise.all(want.map(async (t) => {
      if (paging.has(t)) await paging.get(t);
      const head = heads.get(t);
      if (!head || !fetched.has(t)) { await whole(t); return; }
      const g = take(t);
      const l = await j(`/api/cards?type=${encodeURIComponent(t)}&since=${encodeURIComponent(head)}`);
      if (gen.get(t) !== g) return;
      if (l.full) { await whole(t); return; }
      changes(t, l);
      heads.set(t, l.gen);
    }));
    want.forEach((t) => fetched.add(t));
    for (const t of [...fetched]) if (!want.includes(t)) fetched.delete(t);
  };

  /* Fetch newly selected types without replacing the shared array or rebuilding cached cards. */

  const fetched = new Set(on);
  out.ensure = async (type) => {
    if (fetched.has(type)) return;
    fetched.add(type);
    const g = take(type);
    try {
      const l = await j(`/api/cards?type=${encodeURIComponent(type)}&limit=${FIRST_PAGE}`);
      /* Replace only this type and only if no newer request has answered. */

      if (gen.get(type) === g) {
        replaceType(type, l.cards);
        heads.set(type, l.gen);
        if (l.more) rest(type, g, l.cards.length);
      }
    } catch (e) {
      fetched.delete(type);                 /* Failed fetches must remain retryable. */
      throw e;
    }
  };
  return out;
}
