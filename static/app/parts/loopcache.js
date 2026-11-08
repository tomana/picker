/* A loop's bytes, fetched whole before it plays (no stall in the middle), and kept on the device (Cache Storage) while
   there is room, the oldest let go first. A loop's name stays when it is rendered again, so a kept one is checked against the
   server once a visit (its ETag). `loopsAhead` fetches, one at a time, what may play later. */

const NAME = "loops";
const BUDGET = 1 << 30;                  // bytes of loops kept, at most; and never past half the origin's quota
const files = new Map();                 // url → { p: Promise<object URL>, got, of, seen: Set<fn> }, this page's
const checked = new Set();
let store, index = null;                 // index: url → size, in the order they were kept

const open = () => (store ??= (self.caches ? caches.open(NAME) : Promise.reject(new Error("no Cache Storage")))
  .then(async (c) => {
    index = new Map();
    for (const k of await c.keys()) index.set(k.url, +((await c.match(k))?.headers.get("content-length")) || 0);
    return c;
  }).catch(() => null));
const abs = (url) => new URL(url, location.href).href;

async function keep(c, url, blob, etag) {
  try {
    const { quota = 0, usage = 0 } = navigator.storage?.estimate ? await navigator.storage.estimate() : {};
    if (!quota || usage + blob.size > quota / 2) return false;
    let total = [...index.values()].reduce((a, b) => a + b, 0);
    for (const [k, n] of index) {
      if (total + blob.size <= BUDGET) break;
      await c.delete(k);
      index.delete(k);
      total -= n;
    }
    await c.put(url, new Response(blob, { headers: { "content-type": blob.type, "content-length": String(blob.size),
                                                     ...(etag ? { etag } : {}) } }));
    index.delete(abs(url));
    index.set(abs(url), blob.size);
    return true;
  } catch (_) {
    return false;
  }
}

async function download(url, f, c) {
  const r = await fetch(url, { cache: "no-cache" });     // asked again: a loop rendered anew keeps its name
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  f.of = +r.headers.get("content-length") || 0;
  const parts = [], rd = r.body.getReader();
  for (;;) {
    const { done, value } = await rd.read();
    if (done) break;
    parts.push(value);
    f.got += value.length;
    for (const fn of f.seen) fn(f.of ? f.got / f.of : 0);
  }
  const blob = new Blob(parts, { type: r.headers.get("content-type") || "video/mp4" });
  // once kept, the store's copy (on disk) stands in for the one in memory
  if (c && await keep(c, url, blob, r.headers.get("etag"))) return (await c.match(url))?.blob() || blob;
  return blob;
}

// a kept loop whose file changed since: let go, so the next play fetches it again (this one may still show it)
async function check(c, url, hit) {
  if (checked.has(url)) return;
  checked.add(url);
  try {
    const r = await fetch(url, { method: "HEAD", cache: "no-store" });
    const was = hit.headers.get("etag"), now = r.headers.get("etag");
    if (r.ok && was && now && was !== now) {
      await c.delete(url);
      index.delete(abs(url));
      files.delete(url);
    }
  } catch (_) {}
}

function file(url) {
  let f = files.get(url);
  if (f) {                               // the newest last: the oldest are the first let go
    files.delete(url);
    files.set(url, f);
    return f;
  }
  f = { got: 0, of: 0, seen: new Set(), src: null };
  f.p = (async () => {
    const c = await open();
    const hit = c && await c.match(url).catch(() => null);
    if (hit) check(c, url, hit);
    const blob = hit ? await hit.blob() : await download(url, f, c);
    return (f.src = URL.createObjectURL(blob));
  })();
  f.p.catch(() => files.delete(url));
  files.set(url, f);
  trim();
  return f;
}

// a few kept in this page, the oldest let go; one a video still shows stays
function trim() {
  let over = files.size - 12;
  for (const [url, f] of files) {
    if (over <= 0) break;
    if (!f.src || document.querySelector(`video[src="${f.src}"]`)) continue;
    files.delete(url);
    URL.revokeObjectURL(f.src);
    over--;
  }
}

let waiting = 0, free = null;             // plays waiting for their bytes; what wakes the fetches ahead when none are

/* An object URL for the loop at `url`; `progress(share)` is called as its bytes come, when they aren't kept already. */
export async function loopSrc(url, progress = null) {
  const f = file(url);
  if (progress) f.seen.add(progress);
  waiting++;
  try {
    return await f.p;
  } finally {
    f.seen.delete(progress);
    if (!--waiting && free) { free(); free = null; }
  }
}

const later = [];
let fetching = false;
/* Fetches `urls` into the store in turn, the first first, while it has room, never while a play waits for its bytes;
   never on a data-saving connection. */
export function loopsAhead(urls, { first = false } = {}) {
  if (navigator.connection?.saveData) return;
  const fresh = urls.filter((u) => u && !files.has(u) && !later.includes(u));
  if (first) later.unshift(...fresh);
  else later.push(...fresh);
  pump();
}

async function pump() {
  if (fetching) return;
  fetching = true;
  try {
    while (later.length) {
      const url = later.shift();
      const c = await open();
      if (!c) { later.length = 0; break; }
      while (waiting) await new Promise((ok) => { free = ok; });
      if (files.has(url) || await c.match(url).catch(() => null)) continue;
      try {
        await file(url).p;               // as a play would: one that starts meanwhile shares it, bar and all
      } catch (_) {
        continue;
      }
      if (!index.has(abs(url))) { later.length = 0; break; }      // no room: nothing more ahead
    }
  } finally {
    fetching = false;
  }
}
