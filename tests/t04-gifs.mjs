import { withPage, showTab, assert, eq, sleep } from "./lib.mjs";
export const name = "gifs — the turn only moves forward, and reaches the end";
export async function run(log) {
  await withPage(async (page, errs) => {
    await showTab(page, "fx_visual");
    const total = await page.evaluate(() =>
      document.querySelectorAll("article.card:not(.compose)").length);
    assert(total > 12, `only ${total} cards — too few to test the turn`);
    const maxY = await page.evaluate(() =>
      document.documentElement.scrollHeight - innerHeight);
    const seen = [];
    for (let y = 0; y <= maxY; y += 60) {
      await page.evaluate((v) => scrollTo(0, v), y);
      await sleep(110);
      const i = await page.evaluate(() => {
        const on = document.querySelector("img.anim[data-playing]");
        if (!on) return null;
        return [...document.querySelectorAll("article.card:not(.compose)")]
          .indexOf(on.closest("article.card"));
      });
      if (i != null && i >= 0 && (!seen.length || seen[seen.length - 1] !== i)) seen.push(i);
    }
    const back = seen.filter((v, k) => k > 0 && v < seen[k - 1]);
    log(`${seen.length} turns over ${total} cards, ${back.length} backwards`);
    assert(!back.length, `the turn moved BACKWARDS ${back.length} time(s): ${back.slice(0, 5)}`);
    await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
    await sleep(900);
    const last = await page.evaluate(() => {
      const on = document.querySelector("img.anim[data-playing]");
      const cards = [...document.querySelectorAll("article.card:not(.compose)")];
      return on ? cards.indexOf(on.closest("article.card")) : -1;
    });
    log(`at maximum scroll the turn is on card ${last} of ${total - 1}`);
    assert(last === total - 1,
      `the last ${total - 1 - last} card(s) can never animate — check the grid's padding`);
    await page.evaluate(() => scrollTo(0, 400));
    await sleep(1500);
    const movingGrid = () => page.evaluate(() =>
      [...document.querySelectorAll(".grid img.anim.on")].filter((i) => i.dataset.playing).length);
    eq(await movingGrid(), 1, "the grid's turn was not running before the card opened");
    await page.evaluate(() => {
      const c = [...document.querySelectorAll("article.card:not(.compose)")]
        .find((a) => a.querySelector("img[data-gif]"));
      (c.querySelector(".cmedia, .media") || c).click();
    });
    await sleep(2000);
    const big = await page.evaluate(() => {
      const i = document.querySelector(".sheet.big img.anim[data-gif]");
      return i && { gif: /\.gif($|\?)/.test(i.currentSrc || i.src),
                    shown: i.classList.contains("on") && getComputedStyle(i).opacity === "1",
                    decoded: i.complete && i.naturalWidth > 0 };
    });
    assert(big, "the open card has no animated layer at all");
    assert(big.gif, "the open card's animated layer has no gif source — it is showing the still");
    assert(big.decoded && big.shown, `the open card's gif is not on show: ${JSON.stringify(big)}`);
    eq(await movingGrid(), 0, "the grid kept animating behind the open card");
    await page.keyboard.press("Escape");
    await sleep(1500);
    eq(await movingGrid(), 1, "the grid's turn did not resume after the card closed");
    log("the open card animates; the grid pauses behind it and resumes on close");
    assert(!errs.length, "page errors: " + errs.slice(0, 3).join(" | "));
  });
}
