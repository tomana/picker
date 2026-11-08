import { withPage, assert, eq, sleep, showTab, api, BASE } from "./lib.mjs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
const SHOTS = process.env.SHOTS;
export const name = "a loop's download — a bar on its picture while it comes, then it plays from one fetch; kept on the device and played from there next visit, checked against the server, fetched again when it changed; the tab's loops fetched ahead one at a time, after what plays; with no room, nothing kept (loops given from outside)";

async function video() {
  const dir = await mkdtemp(join(tmpdir(), "picker-loopcache-"));
  const f = join(dir, "a.mp4");
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=320x320:d=2:r=30", "-f", "lavfi",
    "-i", "sine=f=440:d=2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-movflags", "+faststart",
    "-shortest", f]);
  const b = await readFile(f);
  await rm(dir, { recursive: true, force: true });
  return b;
}

// the loops' own server, slow (a bar has time to show): every path the same video, its ETag per path; what it was asked
function loopServer(body) {
  const S = { gets: [], heads: [], ranges: 0, open: 0, most: 0, tag: {}, t: [], t0: Date.now() };
  S.srv = createServer(async (q, a) => {
    const p = new URL(q.url, "http://x").pathname;
    const head = { "Access-Control-Allow-Origin": "*", "Access-Control-Expose-Headers": "ETag",
                   "Content-Type": "video/mp4", "Content-Length": body.length, ETag: `"${S.tag[p] || 1}"` };
    if (q.method === "HEAD") { S.heads.push(p); a.writeHead(200, head); return a.end(); }
    S.gets.push(p);
    if (q.headers.range) S.ranges++;
    S.most = Math.max(S.most, ++S.open);
    S.t.push(`${Date.now() - S.t0}+${p}`);
    a.writeHead(200, head);
    for (let i = 0; i < body.length; i += 3000) {
      if (i) await sleep(40);
      a.write(body.subarray(i, i + 3000));
    }
    S.open--;
    S.t.push(`${Date.now() - S.t0}-${p}`);
    a.end();
  });
  return new Promise((ok) => S.srv.listen(0, "127.0.0.1", () => { S.url = `http://127.0.0.1:${S.srv.address().port}`; ok(S); }));
}

// every card of the tab carries its own loop, and its views theirs
function withLoops(x, ids, at) {
  if (Array.isArray(x)) return x.map((y) => withLoops(y, ids, at));
  if (!x || typeof x !== "object") return x;
  const o = Object.fromEntries(Object.entries(x).map(([k, v]) => [k, withLoops(v, ids, at)]));
  if (ids.has(o.id)) {
    const add = (m) => m && (m.still || m.gif) ? { ...m, loop: `${at}/${o.id}.mp4`,
      ...(m.views ? { views: m.views.map((v, i) => ({ ...v, loop: `${at}/${o.id}.v${i}.mp4` })) } : {}) } : m;
    o.media = add(o.media);
    if (o.versions) o.versions = o.versions.map((v) => ({ ...v, media: add(v.media) }));
  }
  return o;
}

export async function run(log) {
  const body = await video();
  const S = await loopServer(body);
  const ids = new Set((await api("/api/cards?type=fx_visual")).cards.map((c) => c.id));
  const room = (page, quota) => quota && page.evaluateOnNewDocument((q) => {
    navigator.storage.estimate = async () => ({ quota: q, usage: 0 });
  }, quota);
  const visit = async ({ quota = 0 } = {}, fn) => withPage(async (page, errs) => {
    await room(page, quota);
    await page.setRequestInterception(true);
    page.on("request", async (r) => {
      const u = new URL(r.url()), get = r.method() === "GET";
      if (u.origin === S.url) return r.continue();
      if (get && u.pathname.startsWith("/api/cards")) {
        const res = await fetch(BASE + u.pathname + u.search);
        return r.respond({ status: res.status, contentType: "application/json",
                           body: JSON.stringify(withLoops(await res.json(), ids, S.url)) });
      }
      return get || r.method() === "HEAD" ? r.continue() : r.respond({ status: 200, contentType: "application/json", body: "{}" });
    });
    return fn(page, errs);
  });
  const hits = (p) => S.gets.filter((x) => x === p).length;
  try {
    await visit({}, async (page, errs) => {
      // what plays, and the bar of each loop that comes
      const look = () => page.evaluate(() => ({
        plays: [...document.querySelectorAll(".grid video.anim")].filter((v) => !v.paused && v.classList.contains("on"))
          .map((v) => ({ id: v.closest("article").dataset.cid, src: v.getAttribute("src") || "" })),
        bars: [...document.querySelectorAll(".grid .lload > i")].map((i) => ({ id: i.closest("article").dataset.cid,
                                                                            w: parseFloat(i.style.width) || 0 })) }));
      const until = async (what, fn, ms = 15000) => {
        for (const t = Date.now(); Date.now() - t < ms;) { const s = await look(); if (fn(s)) return s; await sleep(40); }
        throw new Error(`${what}: ${JSON.stringify(await look())}`);
      };
      const hover = async (id) => {
        const b = await page.$eval(`.grid article.card[data-cid="${id}"] .media`, (m) => {
          m.scrollIntoView({ block: "center" }); const r = m.getBoundingClientRect(); return { x: r.left + r.width / 3, y: r.top + r.height / 2 }; });
        await page.mouse.move(b.x, b.y);
      };
      // a loop not on the device (the one at the turn line, from the start): a bar on its picture that grows, then it
      // plays from one fetch
      await page.goto(`${BASE}/?tab=fx_visual`, { waitUntil: "domcontentloaded" });
      const ws = {};
      let shot = false;
      const shown = await until("a bar, then its picture", (s) => {
        for (const b of s.bars) (ws[b.id] ||= []).push(b.w);
        if (SHOTS && !shot && s.bars.some((b) => b.w > 30)) { shot = true; page.screenshot({ path: `${SHOTS}/loop-bar.png` }); }
        return s.plays.length > 0;
      }, 30000);
      const one = shown.plays[0].id, w = ws[one] || [];
      assert(w.some((x) => x > 0 && x < 100) && w.some((x, i) => i && x > w[i - 1]), `${one}: a bar that grows: ${w.join(",")}`);
      eq((await look()).bars.filter((b) => b.id === one).length, 0, "no bar once it plays");
      assert(shown.plays[0].src.startsWith("blob:"), `it plays its fetched bytes: ${shown.plays[0].src}`);
      const all = await page.$$eval(".grid article.card[data-cid]", (as) => as.map((a) => a.dataset.cid));
      const tiles = [one, ...all.filter((id) => id !== one).slice(0, 2)];
      const loop = (id) => `/${id}.mp4`;
      await page.$eval(`.grid article.card[data-cid="${one}"] .lsound`, (b) => b.click());
      await sleep(800);
      eq(hits(loop(tiles[0])), 1, "picture and sound from one fetch");
      eq(S.ranges, 0, "no byte ranges asked: it plays from the device");

      // the tab's loops come ahead, one at a time beside what plays
      for (const t = Date.now(); Date.now() - t < 20000 && !tiles.slice(1).every((id) => hits(loop(id))); ) await sleep(200);
      assert(tiles.slice(1).every((id) => hits(loop(id)) === 1), `the next tiles' loops fetched ahead, once each: ${S.gets.join(" ")}`);
      eq(S.most, 1, `one at a time: what plays first, then those ahead (${S.t.join(" ")}; plays: ${one})`);
      eq(S.heads.length, 0, "nothing kept yet, nothing to check");
      const kept = () => page.evaluate(async () => (await (await caches.open("loops")).keys()).map((k) => new URL(k.url).pathname));
      for (const t = Date.now(); Date.now() - t < 20000; ) {
        const k = await kept();
        if (tiles.every((id) => k.includes(loop(id)))) break;
        await sleep(200);
      }
      const k = await kept();
      assert(tiles.every((id) => k.includes(loop(id))), `kept on the device: ${k.join(" ")}`);

      // the next visit: kept ones play at once, with no fetch, each checked once
      const gets = S.gets.length;
      await showTab(page, "fx_visual");
      await page.waitForSelector(".grid article.card video.anim[data-loop]", { timeout: 15000 });
      for (const id of [tiles[2], tiles[0]]) {
        await hover(id);
        const s = await until(`${id} plays`, (s) => s.plays.some((p) => p.id === id) || s.bars.some((b) => b.id === id));
        eq(s.bars.filter((b) => b.id === id).length, 0, `${id}: kept, no bar`);
      }
      eq(S.gets.slice(gets).filter((p) => [tiles[0], tiles[2]].map(loop).includes(p)).length, 0, "kept ones aren't fetched");
      assert([tiles[0], tiles[2]].every((id) => S.heads.filter((p) => p === loop(id)).length === 1),
             `each checked once against the server: ${S.heads.join(" ")}`);

      // rendered again (its ETag changed): the visit's check lets the kept one go, and the new one is fetched, once
      S.tag[loop(tiles[0])] = 2;
      await showTab(page, "fx_visual");
      await page.waitForSelector(".grid article.card video.anim[data-loop]", { timeout: 15000 });
      await hover(tiles[0]);
      await until("it plays", (s) => s.plays.some((p) => p.id === tiles[0]));
      for (let i = 0; i < 40 && S.heads.filter((p) => p === loop(tiles[0])).length < 2; i++) await sleep(100);
      eq(S.heads.filter((p) => p === loop(tiles[0])).length, 2, "checked again this visit");
      await showTab(page, "fx_visual");
      await page.waitForSelector(".grid article.card video.anim[data-loop]", { timeout: 15000 });
      await hover(tiles[0]);
      await until("the new one plays", (s) => s.plays.some((p) => p.id === tiles[0]));
      eq(hits(loop(tiles[0])), 2, "the new one fetched once");
      const now = await kept();
      assert(now.includes(loop(tiles[0])), "and kept");
      assert(!errs.length, "page errors: " + errs.slice(0, 4).join(" | "));
      log(`${one} (${body.length} bytes): a bar to ${Math.max(...w)}% over ${w.length} looks, then one fetch for picture and sound; ${tiles.slice(1).join(", ")} fetched ahead after it, one at a time; next visit from the device, each checked once; changed, fetched again once and kept`);
    });

    // no room on the device: it plays, nothing is kept, nothing more is fetched ahead
    S.gets.length = 0;
    await visit({ quota: 1000 }, async (page, errs) => {
      await showTab(page, "fx_visual");
      await page.waitForSelector(".grid article.card video.anim.on", { timeout: 20000 });
      const first = S.gets.slice();
      await sleep(5000);
      assert(S.gets.length <= first.length + 1, `with no room, at most one tried ahead: ${S.gets.join(" ")}`);
      const n = S.gets.length;
      await showTab(page, "fx_visual");
      await page.waitForSelector(".grid article.card video.anim.on", { timeout: 20000 });
      assert(S.gets.length > n, "nothing was kept: the next visit fetches again");
      assert(!errs.length, "page errors: " + errs.slice(0, 4).join(" | "));
      log(`no room: ${first.length} played, ${S.gets.length - n} fetched again the next visit`);
    });
  } finally {
    S.srv.close();
  }
}
