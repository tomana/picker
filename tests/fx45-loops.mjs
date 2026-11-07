import { withPage, assert, eq, sleep, showTab, api, BASE } from "./lib.mjs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
const SHOTS = process.env.SHOTS;
export const name = "loops — a card's video with its sound plays as a gif does, muted, one at a time; the speaker gives every loop its sound until pressed again; the open card and its views too (loops given from outside)";

const VIEWS = "fxvws1";

// two short videos with a tone each, as the cards' loops; served from outside, as the cards that carry them are
async function videos() {
  const dir = await mkdtemp(join(tmpdir(), "picker-loops-"));
  const out = {};
  for (const [k, hz, src] of [["a", 440, "testsrc2"], ["b", 660, "smptebars"]]) {
    const f = join(dir, `${k}.mp4`);
    execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", `${src}=s=240x240:d=2:r=24`, "-f", "lavfi",
      "-i", `sine=f=${hz}:d=2`, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-movflags", "+faststart",
      "-shortest", f]);
    out[`/zz-loops/${k}.mp4`] = await readFile(f);
  }
  await rm(dir, { recursive: true, force: true });
  return out;
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

export async function run(log) {
  const files = await videos();
  const ids = new Set((await api("/api/cards?type=fx_visual")).cards.map((c) => c.id));
  assert(ids.has(VIEWS), "the card with two renders is on the tab");
  await withPage(async (page, errs) => {
    await page.setRequestInterception(true);
    page.on("request", async (r) => {
      const u = new URL(r.url()), get = r.method() === "GET";
      if (files[u.pathname]) return r.respond({ status: 200, contentType: "video/mp4", body: files[u.pathname] });
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
                     muted: v.muted, loop: v.loop, on: v.classList.contains("on"), t: v.currentTime })));
    const until = async (what, fn) => {
      for (let i = 0; i < 60; i++) { const s = await state(); if (fn(s)) return s; await sleep(100); }
      throw new Error(`${what}: ${JSON.stringify(await state())}`);
    };
    const hover = async (id) => {
      const b = await page.$eval(`.grid article.card[data-cid="${id}"] .media`, (m) => {
        m.scrollIntoView({ block: "center" }); const r = m.getBoundingClientRect(); return { x: r.left + r.width / 3, y: r.top + r.height / 2 }; });
      await page.mouse.move(b.x, b.y);
    };
    const speaker = (sel) => page.$eval(sel, (b) => b.click());

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
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/loops-grid.png` });

    // the speaker: this loop's sound, and every loop's after it; the card stays shut
    await speaker(`.grid article.card[data-cid="${tiles[1]}"] .lsound`);
    s = await until("the speaker gives it its sound", (s) => s.length === 1 && !s[0].muted);
    eq(await page.evaluate(() => !!document.querySelector(".sheet.big:not([hidden])")), false, "the speaker didn't open the card");
    eq(await page.$$eval(".grid .lsound", (bs) => bs.every((b) => b.classList.contains("on"))), true, "every speaker says sound on");
    eq(JSON.stringify(await page.$$eval(".grid .lsound", (bs) => bs.filter((b) => b.offsetParent).map((b) => b.closest("article").dataset.cid))),
       JSON.stringify([tiles[1]]), "the speaker shows on the loop that plays, and only there");
    await hover(tiles[0]);
    await until("the next loop has its sound too", (s) => s.length === 1 && s[0].in === tiles[0] && !s[0].muted);
    await speaker(`.grid article.card[data-cid="${tiles[0]}"] .lsound`);
    await until("pressed again: muted", (s) => s.length === 1 && s[0].muted);

    // the open card plays its loop, the grid's stops; its views each their own; the sheet's close stops it
    await page.mouse.move(2, 2);
    await page.evaluate((id) => { const a = document.querySelector(`.grid article.card[data-cid="${id}"]`);
      a.scrollIntoView({ block: "center" }); a.querySelector(".media").click(); }, VIEWS);
    await page.waitForSelector(".sheet.big:not([hidden]) video.anim", { timeout: 10000 });
    s = await until("the open card plays its loop, alone", (s) => s.length === 1 && s[0].in === "sheet" && s[0].on);
    const first = s[0].src;
    await speaker(".sheet.big .lsound");
    await until("its speaker", (s) => s.length === 1 && s[0].in === "sheet" && !s[0].muted);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/loops-open.png` });
    const other = await page.$$eval(".sheet.big .vthumb", (bs) => bs.findIndex((b) => !b.classList.contains("on")));
    assert(other >= 0, "a second render to pick");
    await page.$$eval(".sheet.big .vthumb", (bs, i) => bs[i].click(), other);
    s = await until("the other render plays its own loop", (s) => s.length === 1 && s[0].in === "sheet" && s[0].src !== first);
    eq(s[0].muted, false, "with its sound, as the speaker was left");
    await speaker(".sheet.big .lsound");
    await page.evaluate(() => document.querySelector('.scrim[data-kind="big"]').click());
    await sleep(400);
    eq(await page.evaluate(() => [...document.querySelectorAll(".sheet video.anim")].some((v) => !v.paused)), false,
       "the open card's loop stopped with the sheet");
    assert(!errs.length, "page errors: " + errs.slice(0, 4).join(" | "));
    log(`tiles ${tiles.join(", ")}: one loop at a time, muted, round again past its end; the speaker's sound went on to the next; ${VIEWS}: ${first} then ${s[0].src}`);
  });
}
