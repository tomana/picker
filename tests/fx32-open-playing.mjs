import { withPage, assert, sleep, showTab } from "./lib.mjs";
export const name = "opening a card that plays on the grid — its open player takes over, from where it was, and plays on";

const secs = (t) => { const m = /^(\d+):(\d+(?:\.\d+)?)$/.exec(t || ""); return m ? +m[1] * 60 + +m[2] : null; };
export async function run(log) {
  await withPage(async (page, errs) => {
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    await showTab(page, "fx_music");
    const ids = await page.$$eval(".grid article.card[data-cid]", (a) => a.slice(0, 3).map((x) => x.dataset.cid));
    const seen = [];
    for (const id of ids) {
      await page.evaluate((id) => { const a = document.querySelector(`.grid article.card[data-cid="${id}"]`);
        a.scrollIntoView({ block: "center" }); a.querySelector(".vplay").click(); }, id);
      await sleep(1500);                                                   // ~1.5 s in on the grid
      await page.evaluate((id) => { const a = document.querySelector(`.grid article.card[data-cid="${id}"]`);
        (a.querySelector(".media, .vblock") || a).click(); }, id);
      await page.waitForSelector(".sheet.big:not([hidden]) .vblock .vline[data-t]", { timeout: 8000 });
      const at = () => page.evaluate(() => {
        const s = document.querySelector(".sheet.big"), l = s.querySelector(".vblock .vline");
        return { on: !!s.querySelector(".vplay.on"), t: l && l.dataset.t };
      });
      await sleep(300);
      const a = await at();
      await sleep(600);
      const b = await at();
      seen.push(`${id} ${a.t}→${b.t}`);
      assert(a.on && b.on, `${id}: the open card's ▶ shows it playing: ${JSON.stringify([a, b])}`);
      assert(secs(a.t) >= 1, `${id}: it went on from the grid's place, not from the start: ${a.t}`);
      assert(secs(b.t) > secs(a.t), `${id}: and plays on: ${a.t} → ${b.t}`);
      await page.keyboard.press("Escape");
      await sleep(300);
      await page.evaluate(() => document.querySelectorAll(".vplay.on").forEach((x) => x.click()));
      await sleep(300);
    }
    assert(!errs.length, "page errors: " + errs.slice(0, 4).join(" | "));
    log(`played on the grid, then opened: ${seen.join(", ")}`);
  });
}
