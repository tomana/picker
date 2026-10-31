import { withPage, assert, eq, sleep, showTab } from "./lib.mjs";
export const name = "a ✕ under every sheet, the top one only: settings, settings over a card, AUTO";

export async function run(log) {
  await withPage(async (page, errs) => {
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    await showTab(page, "fx_visual");
    const xs = () => page.evaluate(() => [...document.querySelectorAll(".scrim:not([hidden]) .scrimx:not([hidden])")]
      .map((x) => x.closest(".scrim").dataset.kind).join());
    const tapX = (kind) => page.evaluate((k) => document.querySelector(`.scrim[data-kind="${k}"]`).click(), kind);
    const open = (k) => page.evaluate((k) => !document.querySelector(`.sheet.${k}`)?.hidden, k);

    await page.evaluate(() => document.querySelector('button[title^="agents:"]').click());
    await page.waitForSelector(".sheet.settings:not([hidden])", { timeout: 10000 });
    await sleep(400);
    eq(await xs(), "settings", "settings alone: its ✕");
    await tapX("settings");
    await sleep(300);
    eq(await open("settings"), false, "the ✕ closes it");

    await page.evaluate(() => { const a = document.querySelector(".grid article.card:not(.compose)"); (a.querySelector(".media, .vblock") || a).click(); });
    await page.waitForSelector(".sheet.big:not([hidden])", { timeout: 10000 });
    await sleep(400);
    eq(await xs(), "big", "an open card: its ✕");
    await page.evaluate(() => document.querySelector('button[title^="agents:"]').click());
    await page.waitForSelector(".sheet.settings:not([hidden])", { timeout: 10000 });
    await sleep(400);
    eq(await xs(), "settings", "settings over the card: one ✕, settings'");
    await tapX("settings");
    await sleep(400);
    eq(JSON.stringify([await open("settings"), await open("big")]), "[false,true]", "it closes settings, the card stays");
    eq(await xs(), "big", "and the card's ✕ is back");
    await page.keyboard.press("Escape");
    await sleep(300);

    if (!(await page.$(".card.compose.autop .phead.open"))) await page.click(".card.compose.autop .phead-tog");
    await sleep(300);
    await page.click(".card.compose.autop .astrip .astext");
    await page.waitForSelector(".sheet.auto:not([hidden])", { timeout: 10000 });
    await sleep(400);
    eq(await xs(), "auto", "the AUTO sheet: its ✕");
    assert(!errs.length, "page errors: " + errs.slice(0, 4).join(" | "));
    log("settings, settings over a card, the card again, AUTO: one ✕ each, the top sheet's");
  });
}
