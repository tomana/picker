import { withPage, showTab, ensurePanel, api, assert, eq, sleep } from "./lib.mjs";
export const name = "scroll — a sound tab plays as you scroll";
export async function run(log) {
  const { types } = await api("/api/types");
  const audio = [];
  for (const t of types) {
    const { cards } = await api(`/api/cards?type=${encodeURIComponent(t.type)}`);
    if (cards.some((c) => (c.media || {}).audio)) audio.push(t.type);
  }
  assert(audio.length, "no type has cards with a mix — nothing to play");
  await withPage(async (page, errs) => {
    const mp3 = [];
    page.on("response", (r) => { if (/\.mp3(\?|$)/.test(r.url())) mp3.push(r.url()); });
    await showTab(page, audio[0]);
    await ensurePanel(page, "timelines", false);
    await ensurePanel(page, "cup", false);
    const preloaded = mp3.length;
    for (const y of [0, 24]) {
      await page.evaluate((v) => scrollTo(0, v), y);
      await sleep(900);
      eq(await page.evaluate(() =>
        document.querySelectorAll("article.card .vplay.on").length), 0,
        `something was playing at the top (scrollY ${y})`);
    }
    eq(mp3.length - preloaded, 0,
       `a mix was fetched before any scroll: ${mp3.length - preloaded}`);
    log("at the top: nothing lit, nothing fetched");
    const firstTop = await page.evaluate(() =>
      document.querySelector(".grid .cardwrap").getBoundingClientRect().top + scrollY);
    const litNow = () => page.evaluate(() => {
      const on = document.querySelector("article.card .vplay.on");
      const cards = [...document.querySelectorAll("article.card:not(.compose)")];
      return on ? cards.indexOf(on.closest("article.card")) : null;
    });
    await page.evaluate((v) => scrollTo(0, v), Math.max(30, firstTop - 0.33 * 900));
    await sleep(1200);
    eq(await litNow(), null, "the first row a third of the way down already plays");
    // the turn line: 17 % of what shows below the band (none here)
    const line = await page.evaluate(() => {
      const b = document.querySelector("nav.band"), head = b ? Math.max(0, b.getBoundingClientRect().bottom) : 0;
      return head + (innerHeight - head) * 0.17;
    });
    const at = firstTop - line + 6;                   // the first row just past the line
    await page.evaluate((v) => scrollTo(0, v), at);
    await sleep(1400);
    eq(await litNow(), 0, "the first row at the line: the first card plays");
    log(`the first card plays as the first row reaches the line (${Math.round(line)} px down; row at ${Math.round(firstTop)} px)`);
    const lit = [];
    for (const k of [300, 700, 1100]) {
      await page.evaluate((v) => scrollTo(0, v), Math.round(at + k));
      await sleep(1400);
      lit.push(await page.evaluate(() => {
        const on = document.querySelector("article.card .vplay.on");
        const cards = [...document.querySelectorAll("article.card:not(.compose)")];
        return { card: on ? cards.indexOf(on.closest("article.card")) : null,
                 n: document.querySelectorAll("article.card .vplay.on").length,
                 head: !!document.querySelector("article.card .vline") };
      }));
    }
    log(`${audio[0]} alone: turns played ${lit.map((l) => l.card).join(" -> ")}`);
    assert(lit.some((l) => l.card != null), "scrolling never started anything");
    assert(lit.every((l) => l.n <= 1), "more than one card playing at once");
    assert(lit.some((l) => l.head), "playing with no playhead");
    assert(mp3.length > preloaded, "nothing was fetched");
    await page.evaluate(() => scrollTo(0, 0));
    await sleep(1000);
    eq(await page.evaluate(() =>
      document.querySelectorAll("article.card .vplay.on").length), 0,
      "scrolling back to the top left something playing");
    log("back at the top: quiet again");
    assert(!errs.length, "page errors: " + errs.slice(0, 3).join(" | "));
  }, { width: 412, height: 900, dpr: 1 });
}
