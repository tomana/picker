import { withPage, assert, eq, sleep, BASE, api, showTab } from "./lib.mjs";
export const name = "fixture — the made-up store: grid, music lanes, a vote, the archive, the queue";
const VISUAL = ["fxlat1", "fxdun1", "fxemb1", "fxgrd1", "fxmoi1", "fxtid1", "fxsnd1", "fxfrn1", "fxhaz1", "fxkil1",
                "fxpol1", "fxspr1", "fxlnk1", "fxvws1",
                ...Array.from({ length: 16 }, (_, k) => `fxv${String(k + 1).padStart(2, "0")}`)];
const MUSIC = ["fx0a1b2c3d4e", "fx1b2c3d4e5f", "fx2c3d4e5f60", "fx3d4e5f6071", "fx4e5f607182", "fx6a7b8c9d0e",
               "fx7b8c9d0e1f", "fx8c9d0e1f20", "fx9d0e1f2031", "fx7a8b9c0d1e", "fxsame000001",
               ...Array.from({ length: 8 }, (_, k) => `fxe${String(k + 1).padStart(2, "0")}0000000`)];
const SHOW = ["fxshw1"];
const FITS = Array.from({ length: 7 }, (_, k) => `fxfit0${k + 1}`);
const CODE = Array.from({ length: 8 }, (_, k) => `fxcode0${k + 1}`);
const EXAMPLES = ["vis", "mus"].flatMap((p) => Array.from({ length: 8 }, (_, k) => `${p}0${k + 1}`));
export async function run(log) {
  const live = await api("/api/cards");
  const ids = (live.cards || live).map((c) => c.id).sort();
  const recordings = live.cards.filter((c) => c.type === "music" && c.origin?.kind === "recording");
  assert(recordings.length > 0, "the example has recording cards");
  const based = recordings.flatMap((c) => [c.id, `${c.id}loop`]);
  eq(ids.join(" "), [...VISUAL, ...MUSIC, ...SHOW, ...FITS, ...CODE, ...EXAMPLES, ...based].sort().join(" "), "the store's cards, the archived two left out");
  const all = await api("/api/cards?archived=1");
  eq((all.cards || all).length, ids.length + 2, "with ?archived=1, all of them");
  log(`the store: ${ids.length} cards on the grid, 2 archived`);
  await withPage(async (page, errs) => {
    await showTab(page, "fx_visual");
    const vis = await page.$$eval(".grid article.card[data-cid]", (as) => as.map((a) => ({
      id: a.dataset.cid, img: !!a.querySelector("img") })));
    eq(vis.map((v) => v.id).sort().join(" "), [...VISUAL].sort().join(" "), "the visual tab's cards");
    assert(vis.every((v) => v.img), `a visual card without a picture: ${JSON.stringify(vis)}`);
    await page.evaluate(() => {
      const a = document.querySelector('.grid article.card[data-cid="fxgrd1"]');
      a.scrollIntoView({ block: "center" });
      [...a.querySelectorAll(".cfoot .vcell, .cfoot button")].find((b) => b.textContent.trim().startsWith("+")).click();
    });
    await sleep(900);
    const grd = await api("/api/cards/fxgrd1");
    const shown = (grd.versions || []).at(-1);
    assert((shown && shown.vote) === 1 || grd.vote === 1, `the + didn't reach the store: ${JSON.stringify({ vote: grd.vote, v: shown && shown.vote })}`);
    log("+ on fxgrd1: written to the store and read back");
    await showTab(page, "fx_music");
    const mus = await page.$$eval(".grid article.card[data-cid]", (as) => as.map((a) => ({
      id: a.dataset.cid, lanes: a.querySelectorAll(".lane").length })));
    eq(mus.map((m) => m.id).sort().join(" "), [...MUSIC].sort().join(" "), "the music tab's cards");
    assert(mus.every((m) => m.lanes >= 2), `a music card with under two lanes: ${JSON.stringify(mus)}`);
    const mp3 = await fetch(`${BASE}/media/fx0a1b2c3d4e/v3__mix.mp3`);
    eq(mp3.status, 200, "a mix is served");
    log(`music: ${mus.length} cards, ${mus.reduce((n, m) => n + m.lanes, 0)} lanes, the mixes served`);
    await showTab(page, "fx_visual", { view: "archive" });
    await page.waitForFunction(() => document.querySelector(".archhead") && !/loading/.test(document.querySelector(".archhead").textContent), { timeout: 30000 });
    const arch = await page.$$eval(".grid article.card[data-cid]", (as) => as.map((a) => a.dataset.cid));
    eq(arch.join(" "), "fxold1", "the archive view");
    const q = await api("/api/queue");
    const failed = (q.queue || []).find((j) => j.id === "fxjob000002");
    eq(failed && failed.status, "failed", "the failed job");
    log("archive: fxold1 alone; the queue's failed job folds as failed");
    assert(!errs.length, "page errors: " + errs.slice(0, 4).join(" | "));
  }, { writes: true });
}
