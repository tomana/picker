import { withPage, assert, eq, sleep, BASE } from "./lib.mjs";
export const name = "scroll play — on a phone's two columns, the line below the bar plays a row's left card, then its right";

export async function run(log) {
  await withPage(async (page, errs) => {
    await page.setViewport({ width: 384, height: 832, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    await page.evaluateOnNewDocument(() => {
      // a play needs no sound: Audio stands still and says it plays
      const A = window.Audio;
      window.Audio = function (u) { const a = new A(); a.play = () => Promise.resolve(); a.src = u || ""; return a; };
    });
    await page.goto(BASE + "/?tab=fx_music", { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForSelector(".grid article.card:not(.compose) .vblock[data-audio]", { timeout: 30000 });
    // a configured band, as an operator's (40 px, sticky over the grid's top); the fixture has none
    await page.addStyleTag({ content: "nav.band { display:block; position:sticky; top:0; z-index:5; height:40px; background:#111 }" });
    await sleep(800);
    const geo = await page.evaluate(() => {
      const cards = [...document.querySelectorAll(".grid article.card:not(.compose)")]
        .filter((c) => c.querySelector(".vblock[data-audio]"));
      const lefts = [...new Set(cards.map((c) => Math.round(c.getBoundingClientRect().left)))];
      const tops = [...new Set(cards.map((c) => Math.round(c.getBoundingClientRect().top + scrollY)))].sort((a, b) => a - b);
      const band = document.querySelector("nav.band").getBoundingClientRect().bottom;   // at the top, unscrolled
      return { cols: lefts.length, tops, band, vh: innerHeight };
    });
    eq(geo.cols, 2, "two columns at 384 px");
    assert(geo.tops.length >= 3, `rows enough to scroll: ${geo.tops.length}`);
    const rowH = geo.tops[2] - geo.tops[1];
    const line = geo.band + (geo.vh - geo.band) * 0.17;
    const lit = () => page.evaluate(() => {
      const on = document.querySelector(".grid article.card .vplay.on");
      const c = on && on.closest("article.card");
      return c ? { top: Math.round(c.getBoundingClientRect().top + scrollY), left: Math.round(c.getBoundingClientRect().left) } : null;
    });
    const seen = [];
    for (const [share, side] of [[0.25, 0], [0.75, 1]]) {
      // row 1 crossing the line: a quarter of it above (its left), then three quarters (its right)
      await page.evaluate((y) => scrollTo(0, y), Math.round(geo.tops[1] + rowH * share - line));
      await sleep(900);
      const got = await lit();
      assert(got, `something plays with row 1 ${share * 100}% past the line`);
      eq(got.top, geo.tops[1], `row 1 plays at ${share * 100}%`);
      seen.push(got.left);
      if (side === 1) assert(got.left > seen[0], `then its right card (${seen.join(" → ")})`);
    }
    assert(!errs.length, "page errors: " + errs.slice(0, 4).join(" | "));
    log(`two columns, line ${Math.round(line)} px (bar ${Math.round(geo.band)}): row 1 left at a quarter past, right at three quarters`);
  });
}
