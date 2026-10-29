import { withPage, assert, eq, sleep, BASE } from "./lib.mjs";
export const name = "pointer — hover (mouse) or hold (finger) plays the card under it";
const CARD = ".grid article.card:not(.compose)";
const VIEW = BASE + "/?tab=fx_visual";
async function readOnly(page) {
  await page.setRequestInterception(true);
  page.on("request", (r) => (r.method() === "GET" ? r.continue() : r.abort()));
}
const moving = (page) => page.$$eval(`${CARD} img.anim[data-playing]`,
  (xs) => xs.map((x) => x.closest("article.card").dataset.cid));
async function target(page) {
  return page.evaluate((sel) => {
    const live = new Set([...document.querySelectorAll(`${sel} img.anim[data-playing]`)]
      .map((x) => x.closest("article.card")));
    for (const c of document.querySelectorAll(sel)) {
      if (live.has(c) || !c.querySelector("img.anim[data-gif]")) continue;
      const r = c.querySelector(".media").getBoundingClientRect();
      if (r.top > 80 && r.bottom < innerHeight - 20)
        return { cid: c.dataset.cid, x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }
    return null;
  }, CARD);
}
export async function run(log) {
  await withPage(async (page, errs) => {
    await readOnly(page);
    await page.goto(VIEW, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(`${CARD} img.anim[data-gif]`, { timeout: 30000 });
    await page.evaluate(() => scrollTo(0, 400));
    await sleep(900);
    const before = await moving(page);
    const t = await target(page);
    assert(t, "a gif card on screen that isn't playing");
    await page.mouse.move(t.x, t.y, { steps: 4 });
    await sleep(700);
    const over = await moving(page);
    eq(over.length, 1, "one moving while hovered");
    eq(over[0], t.cid, "the hovered card is the one moving");
    log(`hover: ${before.join(",") || "nothing"} → ${over[0]} (the card under the mouse)`);
    await page.mouse.move(t.x, 20, { steps: 3 });
    await sleep(900);
    const after = await moving(page);
    assert(after.length <= 1, `one at most after leaving, got ${after.join(",")}`);
    assert(!after.includes(t.cid) || before.includes(t.cid), "the hovered card gave the turn back");
    log(`left the card: the scroll's pick again (${after.join(",") || "nothing"})`);
    assert(!errs.length, "page errors: " + errs.slice(0, 3).join(" | "));
  }, { width: 1280, height: 900, dpr: 1 });
  await withPage(async (page, errs) => {
    await readOnly(page);
    await page.setViewport({ width: 412, height: 900, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    await page.goto(VIEW, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(`${CARD} img.anim[data-gif]`, { timeout: 30000 });
    await page.evaluate(() => scrollTo(0, 400));
    await sleep(900);
    const t = await target(page);
    assert(t, "a gif card on screen that isn't playing");
    const cdp = await page.target().createCDPSession();
    const touch = (type) => cdp.send("Input.dispatchTouchEvent",
      { type, touchPoints: type === "touchEnd" ? [] : [{ x: t.x, y: t.y }] });
    await touch("touchStart"); await sleep(80); await touch("touchEnd");
    await sleep(500);
    const opened = await page.$$eval("div.sheet.big:not([hidden])", (x) => x.length);
    eq(opened, 1, "a tap opens the card");
    await page.evaluate(() => document.querySelector("div.sheet.big .x, div.scrim:not([hidden])")?.click());
    await page.keyboard.press("Escape").catch(() => {});
    await sleep(400);
    await page.evaluate(() => { for (const s of document.querySelectorAll("div.sheet, div.scrim")) s.hidden = true; });
    log("tap: opens the card, as before");
    await touch("touchStart");
    await sleep(800);
    const held = await moving(page);
    eq(held.length, 1, "one moving while held");
    eq(held[0], t.cid, "the held card is the one moving");
    const menu = await page.$eval(`${CARD}[data-cid="${t.cid}"] .media`,
      (m) => getComputedStyle(m).webkitTouchCallout || getComputedStyle(m).getPropertyValue("-webkit-touch-callout"));
    await touch("touchEnd");
    await sleep(600);
    const after = await moving(page);
    const sheet = await page.$$eval("div.sheet.big:not([hidden])", (x) => x.length);
    eq(sheet, 0, "lifting after a hold doesn't open the card");
    assert(after.length <= 1, `one at most after the lift, got ${after.join(",")}`);
    log(`hold: ${held[0]} plays while held (touch-callout ${menu || "n/a"}); lifted → ${after.join(",") || "nothing"}, card not opened`);
    assert(!errs.length, "page errors: " + errs.slice(0, 3).join(" | "));
  });
}
