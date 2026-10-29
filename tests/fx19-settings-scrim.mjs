import { withPage, assert, eq, sleep, showTab } from "./lib.mjs";
export const name = "settings over a card — a tap beside ⚙ closes ⚙ and leaves the card open";

export async function run(log) {
  await withPage(async (page, errs) => {
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    await showTab(page, "fx_music");
    const opened = await page.evaluate(() => {
      const a = document.querySelector(".grid article.card:not(.compose)");
      if (!a) return false;
      (a.querySelector(".media, .vblock") || a).click();
      return true;
    });
    assert(opened, "a card on the grid");
    await page.waitForSelector(".sheet.big:not([hidden])", { timeout: 10000 });
    await page.evaluate(() => document.querySelector('button[title^="agents:"]').click());
    await page.waitForSelector(".sheet.settings:not([hidden])", { timeout: 10000 });
    await sleep(400);
    const state = () => page.evaluate(() => [document.querySelector(".sheet.settings").hidden,
                                            document.querySelector(".sheet.big").hidden].join());
    eq(await state(), "false,false", "⚙ open over the card");
    const r = await page.$eval(".sheet.settings", (s) => { const b = s.getBoundingClientRect(); return { l: b.left, b: b.bottom }; });
    const at = { x: Math.max(3, r.l - 6), y: Math.min(840, r.b + 12) };
    const hit = await page.evaluate((p) => { const e = document.elementFromPoint(p.x, p.y); return e && (e.dataset.kind || e.className); }, at);
    eq(hit, "settings", "beside ⚙, the tap lands on ⚙'s scrim");
    await page.mouse.click(at.x, at.y);
    await sleep(400);
    eq(await state(), "true,false", "the tap closes ⚙ and leaves the card open");
    assert(!errs.length, "page errors: " + errs.slice(0, 4).join(" | "));
    log("⚙ over a card: a tap beside it closes ⚙ only");
  });
}
