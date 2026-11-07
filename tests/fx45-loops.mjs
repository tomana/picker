import { withPage, assert, eq, sleep, showTab, api, BASE } from "./lib.mjs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
const SHOTS = process.env.SHOTS;
export const name = "loops — a card's video plays as a gif does, muted, one at a time; the speaker gives every loop its sound, seamless and in step with the picture, until pressed again; the open card and its views too (loops given from outside)";

const VIEWS = "fxvws1";

// two short videos with a steady tone each (a gap in it is a seam heard), 2 s and 3 s; served from outside, as the
// cards that carry them are
async function videos() {
  const dir = await mkdtemp(join(tmpdir(), "picker-loops-"));
  const out = {};
  for (const [k, hz, src, d] of [["a", 440, "testsrc2", 2], ["b", 660, "smptebars", 3]]) {
    const f = join(dir, `${k}.mp4`);
    execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", `${src}=s=240x240:d=${d}:r=24`, "-f", "lavfi",
      "-i", `sine=f=${hz}:d=${d}`, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-movflags", "+faststart",
      "-shortest", f]);
    out[`/zz-loops/${k}.mp4`] = await readFile(f);
  }
  await rm(dir, { recursive: true, force: true });
  return out;
}

// served as the picker serves media, in byte ranges (a video that can't be sought in can't be kept in step)
function ranged(body, range) {
  const m = /bytes=(\d*)-(\d*)/.exec(range || "");
  if (!m) return { status: 200, contentType: "video/mp4", headers: { "Accept-Ranges": "bytes" }, body };
  const a = m[1] ? +m[1] : 0, b = m[2] ? Math.min(+m[2], body.length - 1) : body.length - 1;
  return { status: 206, contentType: "video/mp4", body: body.subarray(a, b + 1),
           headers: { "Accept-Ranges": "bytes", "Content-Range": `bytes ${a}-${b}/${body.length}` } };
}

// every card of the tab carries loops: its media, its versions' and its views' (the first view a, the others b)
function withLoops(x, ids) {
  if (Array.isArray(x)) return x.map((y) => withLoops(y, ids));
  if (!x || typeof x !== "object") return x;
  const o = Object.fromEntries(Object.entries(x).map(([k, v]) => [k, withLoops(v, ids)]));
  if (ids.has(o.id)) {
    const add = (m) => m && (m.still || m.gif) ? { ...m, loop: "/zz-loops/a.mp4",
      ...(m.views ? { views: m.views.map((v, i) => ({ ...v, loop: `/zz-loops/${i ? "b" : "a"}.mp4` })) } : {}) } : m;
    o.media = add(o.media);
    if (o.versions) o.versions = o.versions.map((v) => ({ ...v, media: add(v.media) }));
  }
  return o;
}

// the page's sound from outside: the buffer sources playing, and what reaches the output (its peak per 256 samples)
const SPY = () => {
  const S = window.__snd = { live: new Set(), starts: 0, heard: [] };
  const B = AudioBufferSourceNode.prototype, start = B.start, stop = B.stop;
  B.start = function (when = 0, offset = 0, ...a) {
    S.live.add(this); S.starts++;
    this.__at = { t: this.context.currentTime, offset };
    this.addEventListener("ended", () => S.live.delete(this));
    return start.call(this, when, offset, ...a);
  };
  B.stop = function (...a) { S.live.delete(this); return stop.apply(this, a); };
  const N = AudioNode.prototype, connect = N.connect;
  N.connect = function (to, ...a) {
    if (to instanceof AudioDestinationNode && this instanceof AudioBufferSourceNode) {
      const ctx = this.context;
      if (!ctx.__rec) {
        const r = ctx.__rec = ctx.createScriptProcessor(256, 1, 1);
        r.onaudioprocess = (e) => {
          const d = e.inputBuffer.getChannelData(0);
          let m = 0;
          for (let i = 0; i < d.length; i++) m = Math.max(m, Math.abs(d[i]));
          S.heard.push(m);
        };
        connect.call(r, ctx.destination);
      }
      connect.call(this, ctx.__rec);
    }
    return connect.call(this, to, ...a);
  };
  // the sound's place in its loop, less what the output adds: where the picture should be
  S.voice = () => {
    const n = [...S.live][0];
    if (!n) return { n: 0, starts: S.starts };
    const c = n.context, d = n.buffer.duration;
    const at = (((c.currentTime - n.__at.t + n.__at.offset - (c.baseLatency || 0) - (c.outputLatency || 0)) % d) + d) % d;
    return { n: S.live.size, starts: S.starts, dur: +d.toFixed(2), loop: n.loop, loopEnd: +n.loopEnd.toFixed(2), at };
  };
};

export async function run(log) {
  const files = await videos();
  const ids = new Set((await api("/api/cards?type=fx_visual")).cards.map((c) => c.id));
  assert(ids.has(VIEWS), "the card with two renders is on the tab");
  await withPage(async (page, errs) => {
    await page.evaluateOnNewDocument(SPY);
    await page.setRequestInterception(true);
    page.on("request", async (r) => {
      const u = new URL(r.url()), get = r.method() === "GET";
      if (files[u.pathname]) return r.respond(ranged(files[u.pathname], r.headers().range));
      if (get && u.pathname.startsWith("/api/cards")) {
        const res = await fetch(BASE + u.pathname + u.search);
        return r.respond({ status: res.status, contentType: "application/json", body: JSON.stringify(withLoops(await res.json(), ids)) });
      }
      return get || r.method() === "HEAD" ? r.continue() : r.respond({ status: 200, contentType: "application/json", body: "{}" });
    });
    await showTab(page, "fx_visual");
    await page.waitForSelector(".grid article.card video.anim[data-loop]", { timeout: 15000 });
    await sleep(400);
    eq(await page.$$eval(".grid article.card img.anim", (x) => x.length), 0, "a card with a loop has no gif to play");
    const tiles = await page.$$eval(".grid article.card[data-cid]", (as) => as.slice(0, 2).map((a) => a.dataset.cid));

    const state = () => page.evaluate(() => [...document.querySelectorAll("video.anim")].filter((v) => !v.paused)
      .map((v) => ({ in: v.closest(".sheet") ? "sheet" : v.closest("article.card").dataset.cid, src: v.currentSrc.split("/").pop(),
                     muted: v.muted, loop: v.loop, on: v.classList.contains("on"), t: v.currentTime, d: v.duration })));
    const voice = () => page.evaluate(() => window.__snd.voice());
    const until = async (what, fn, get = state) => {
      for (let i = 0; i < 60; i++) { const s = await get(); if (fn(s)) return s; await sleep(100); }
      throw new Error(`${what}: ${JSON.stringify(await get())}`);
    };
    const hover = async (id) => {
      const b = await page.$eval(`.grid article.card[data-cid="${id}"] .media`, (m) => {
        m.scrollIntoView({ block: "center" }); const r = m.getBoundingClientRect(); return { x: r.left + r.width / 3, y: r.top + r.height / 2 }; });
      await page.mouse.move(b.x, b.y);
    };
    const speaker = (sel) => page.$eval(sel, (b) => b.click());
    // a tone heard for `ms`: the silent runs in it (a seam is one), in 256-sample blocks
    const gaps = async (ms) => {
      const h = await page.evaluate(async (ms) => { const S = window.__snd; S.heard.length = 0;
        await new Promise((ok) => setTimeout(ok, ms)); return S.heard.slice(); }, ms);
      const runs = [];
      for (let i = 0; i < h.length; i++) if (h[i] < 1e-3) { let j = i; while (j < h.length && h[j] < 1e-3) j++; runs.push(j - i); i = j; }
      return { blocks: h.length, runs };
    };
    // the picture against the sound, a dozen times over three seconds: the worst gap between them
    const step = async () => {
      let worst = 0;
      for (let i = 0; i < 12; i++) {
        const [v, s] = await Promise.all([voice(), state()]);
        let off = s[0].t - v.at;
        if (off > v.dur / 2) off -= v.dur; else if (off < -v.dur / 2) off += v.dur;
        worst = Math.max(worst, Math.abs(off));
        await sleep(250);
      }
      return +worst.toFixed(3);
    };

    // a tile at the pointer plays its loop, muted, on and on; one at a time
    await hover(tiles[0]);
    let s = await until("the first tile plays its loop", (s) => s.length === 1 && s[0].in === tiles[0] && s[0].on);
    eq(JSON.stringify([s[0].muted, s[0].loop]), "[true,true]", "muted, looping");
    await hover(tiles[1]);
    s = await until("the next tile takes over", (s) => s.length === 1 && s[0].in === tiles[1] && s[0].on);
    eq(await page.$eval(`.grid article.card[data-cid="${tiles[0]}"] video.anim`, (v) => v.getAttribute("src")), null,
       "the one before let go of its video");
    await sleep(2600);
    s = await state();
    assert(s.length === 1 && s[0].t < 2, `past its 2 s it went round again: ${JSON.stringify(s)}`);
    eq((await voice()).n, 0, "no sound until the speaker");
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/loops-grid.png` });

    // the speaker: this loop's sound, seamless and in step with the picture; the card stays shut
    await speaker(`.grid article.card[data-cid="${tiles[1]}"] .lsound`);
    let v = await until("the speaker gives it its sound", (v) => v.n === 1, voice);
    eq(JSON.stringify([v.dur, v.loop, v.loopEnd]), "[2,true,2]", "its sound loops at its own length");
    eq((await state())[0].muted, true, "the video stays muted: the sound is the voice's");
    eq(await page.evaluate(() => !!document.querySelector(".sheet.big:not([hidden])")), false, "the speaker didn't open the card");
    eq(await page.$$eval(".grid .lsound", (bs) => bs.every((b) => b.classList.contains("on"))), true, "every speaker says sound on");
    eq(JSON.stringify(await page.$$eval(".grid .lsound", (bs) => bs.filter((b) => b.offsetParent).map((b) => b.closest("article").dataset.cid))),
       JSON.stringify([tiles[1]]), "the speaker shows on the loop that plays, and only there");
    await sleep(300);
    const g = await gaps(4600);
    eq(g.runs.join(), "", `over two seams of a steady tone, no silence (${g.blocks} blocks)`);
    const worst = await step();
    assert(worst < 0.12, `the picture keeps step with the sound: ${worst} s apart at worst`);

    // the next loop has its sound too; pressed again, none
    const starts = v.starts;
    await hover(tiles[0]);
    await until("the next loop has its sound", (s) => s.length === 1 && s[0].in === tiles[0]);
    await until("its own voice", (v) => v.n === 1 && v.starts > starts, voice);
    await speaker(`.grid article.card[data-cid="${tiles[0]}"] .lsound`);
    await until("pressed again: silent", (v) => v.n === 0, voice);

    // the open card plays its loop, the grid's stops; its views each their own, with their own sound; the sheet's close
    // stops it
    await page.mouse.move(2, 2);
    await page.evaluate((id) => { const a = document.querySelector(`.grid article.card[data-cid="${id}"]`);
      a.scrollIntoView({ block: "center" }); a.querySelector(".media").click(); }, VIEWS);
    await page.waitForSelector(".sheet.big:not([hidden]) video.anim", { timeout: 10000 });
    s = await until("the open card plays its loop, alone", (s) => s.length === 1 && s[0].in === "sheet" && s[0].on);
    const first = s[0];
    await speaker(".sheet.big .lsound");
    v = await until("its speaker", (v) => v.n === 1, voice);
    eq(v.dur, Math.round(first.d), "the sound is its render's");
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/loops-open.png` });
    const other = await page.$$eval(".sheet.big .vthumb", (bs) => bs.findIndex((b) => !b.classList.contains("on")));
    assert(other >= 0, "a second render to pick");
    await page.$$eval(".sheet.big .vthumb", (bs, i) => bs[i].click(), other);
    s = await until("the other render plays its own loop", (s) => s.length === 1 && s[0].in === "sheet" && s[0].src !== first.src && s[0].d > 0);
    v = await until("with its own sound, as the speaker was left", (v) => v.n === 1 && v.dur === Math.round(s[0].d), voice);
    await page.evaluate(() => document.querySelector('.scrim[data-kind="big"]').click());
    await sleep(400);
    eq(await page.evaluate(() => [...document.querySelectorAll(".sheet video.anim")].some((v) => !v.paused)), false,
       "the open card's loop stopped with the sheet");
    await speaker(".grid .lsound.on, .grid .lsound").catch(() => {});
    assert(!errs.length, "page errors: " + errs.slice(0, 4).join(" | "));
    log(`tiles ${tiles.join(", ")}: one loop at a time, muted; with sound, ${g.blocks} blocks over two seams with no silence, the picture ${worst} s from the sound at worst; ${VIEWS}: ${first.src} then ${s[0].src}, each its own sound`);
  });
}
