/* A frozen picker (tools/freeze/freeze.mjs): the page's requests answered from the files saved beside it, so it runs on
   a static site with no server. A vote, an archive or a pool mark is kept in this browser until a reload; anything
   that would start work says that nothing runs here. Loaded before the page's own scripts. */
(() => {
  const INDEX = "@INDEX@";                                // request → {f: file, t: content type}, written by freeze.mjs
  const root = new URL(".", document.currentScript.src);
  const DROP = new Set(["since", "gen", "t", "_"]);       // what changes per visit, not what is asked for
  const NOTHING = "a frozen copy of the picker: nothing runs here (clone it to run it)";

  // a request as the server saw it: its path from the site's root, the lasting parameters in order
  const key = (u) => {
    const x = new URL(u, location.href);
    if (x.origin !== location.origin) return null;
    let p = x.pathname;
    if (p.startsWith(root.pathname)) p = "/" + p.slice(root.pathname.length);
    const q = [...x.searchParams].filter(([k]) => !DROP.has(k)).sort(([a], [b]) => (a < b ? -1 : 1));
    return p + (q.length ? "?" + new URLSearchParams(q) : "");
  };
  const fileOf = (k) => (k && INDEX[k] ? new URL(INDEX[k].f, root).href : null);
  const local = (u) => {
    if (typeof u !== "string" || !u.startsWith("/") || u.startsWith("//")) return u;
    return fileOf(key(u)) || new URL(u.slice(1), root).href;
  };

  const realFetch = window.fetch.bind(window);
  const json = (body, status = 200) => new Response(JSON.stringify(body),
    { status, headers: { "Content-Type": "application/json" } });
  const cards = new Map();                                // a card with this visitor's marks on it

  // a list of a tab's cards, at any page size: sliced from the whole list the copy keeps
  async function page(k) {
    const x = new URL(k, location.origin), t = x.searchParams.get("type");
    if (x.pathname !== "/api/cards" || !t || x.searchParams.has("archived")) return null;
    const whole = fileOf(`/api/cards?limit=100000&type=${encodeURIComponent(t)}`);
    if (!whole) return null;
    const all = await (await realFetch(whole)).json();
    const skip = Number(x.searchParams.get("skip") || 0), limit = Number(x.searchParams.get("limit") || all.cards.length);
    const part = all.cards.slice(skip, skip + limit).map((c) => cards.get(c.id) || c);
    return { ...all, cards: part, more: Math.max(0, all.cards.length - skip - part.length) };
  }

  function mark(c, b) {
    if (b.kind === "vote") {
      const vs = c.versions || [], v = b.version != null ? vs.find((x) => x.n === b.version) : null;
      if (v) v.vote = b.value;
      if (!v || v === vs[vs.length - 1]) c.vote = b.value;
    } else if (b.kind === "archive" && b.voice == null) {
      c.archived = !!b.value;
    } else if (b.kind === "pool") {
      const ps = new Set(c.pools || []);
      if (b.value) ps.add(b.pool || "auto"); else ps.delete(b.pool || "auto");
      c.pools = [...ps];
    }
  }

  window.fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input.url;
    const method = (init.method || (typeof input === "object" && input.method) || "GET").toUpperCase();
    const k = key(url);
    if (k === null) return realFetch(input, init);
    const one = k.match(/^\/api\/cards\/([^/?]+)(\/signal)?$/);
    if (method === "GET" || method === "HEAD") {
      if (one && !one[2] && cards.has(one[1])) return json(cards.get(one[1]));
      const f = fileOf(k);
      if (f) {
        const r = await realFetch(f);
        return new Response(await r.blob(), { status: 200, headers: { "Content-Type": INDEX[k].t } });
      }
      const sliced = await page(k);
      if (sliced) return json(sliced);
      if (k.startsWith("/api/")) return json({ description: "not in this frozen copy" }, 404);
      return realFetch(local(url), init);
    }
    if (one && one[2]) {
      const c = cards.get(one[1]) || await (await window.fetch(`/api/cards/${one[1]}`)).json();
      mark(c, JSON.parse(init.body || "{}"));
      cards.set(one[1], c);
      return json(c);
    }
    if (k.startsWith("/api/prefs")) return json({ ok: true });
    return json({ ok: false, err: NOTHING, description: NOTHING }, 409);
  };

  // pictures, sounds and links the page names by the server's paths: the saved files instead
  for (const [C, attr] of [[HTMLImageElement, "src"], [HTMLMediaElement, "src"], [HTMLSourceElement, "src"],
                           [HTMLVideoElement, "poster"], [HTMLAnchorElement, "href"], [HTMLLinkElement, "href"]]) {
    const d = Object.getOwnPropertyDescriptor(C.prototype, attr);
    if (d && d.set) Object.defineProperty(C.prototype, attr, { ...d, set(v) { d.set.call(this, local(v)); } });
  }
  const setAttr = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function (n, v) {
    return setAttr.call(this, n, n === "src" || n === "href" || n === "poster" ? local(v) : v);
  };
  const RealAudio = window.Audio;
  window.Audio = function Audio(u) { return u === undefined ? new RealAudio() : new RealAudio(local(u)); };
  window.Audio.prototype = RealAudio.prototype;
  window.EventSource = class { constructor() {} addEventListener() {} close() {} };      // no live events
})();
