import { withPage, showTab, assert, eq, sleep } from "./lib.mjs";
export const name = "the grid's window — near cards built, far ones slots, a stepped version kept";
export async function run(log) {
  await withPage(async (page, errs) => {
    await showTab(page, "fx_music");
    await page.waitForSelector(".grid article.card");
    await sleep(800);
    const state = () => page.evaluate(() => {
      const ws = [...document.querySelectorAll(".grid .gblock > .cardwrap")], vh = innerHeight;
      const slots = ws.filter((w) => w.classList.contains("cardph"));
      return { cards: ws.length, slots: slots.length,
               blank: slots.filter((w) => { const r = w.getBoundingClientRect(); return r.bottom > 0 && r.top < vh; }).length,
               named: slots.every((w) => (w.querySelector(".phname") || {}).textContent),
               end: scrollY + vh >= document.documentElement.scrollHeight - 2 };
    });
    const s0 = await state();
    assert(s0.slots > 0, `every one of ${s0.cards} cards was built in a 100 px window`);
    assert(s0.named, "a slot without its name (the page's find)");
    await page.evaluate(() => document.querySelector(".grid .gblock").scrollIntoView({ block: "start" }));
    await sleep(600);
    const id = await page.evaluate(() => {
      const a = [...document.querySelectorAll(".grid article.card")].find((x) => x.querySelector(".vnav.prev:not([disabled])"));
      if (!a) return null;
      a.querySelector(".vnav.prev").click();
      return a.dataset.cid;
    });
    assert(id, "no stack to step on the first screen");
    await sleep(200);
    const shows = () => page.evaluate((id) => {
      const a = document.querySelector(`.grid article.card[data-cid="${id}"]`);
      const b = a && a.querySelector("[data-audio]");
      return a ? (b ? b.dataset.audio : "no sound") : null;
    }, id);
    const was = await shows();
    let dropped = false;
    for (let i = 0; i < 200; i++) {
      await page.evaluate(() => scrollBy(0, innerHeight * 0.8));
      await sleep(80);
      const s = await state();
      eq(s.blank, 0, `an empty slot in view at ${i}`);
      if (await shows() === null) dropped = true;
      if (s.end) break;
    }
    assert(dropped, `${id} was never dropped`);
    await page.evaluate((id) => document.querySelector(`.grid .cardph[data-cid="${id}"]`).scrollIntoView({ block: "center" }), id);
    await sleep(800);
    eq(await shows(), was, `${id} built again on another version`);
    eq((await state()).blank, 0, "an empty slot in view back at the card");
    eq(errs.length, 0, `page errors: ${errs.join(" | ")}`);
    log(`${s0.cards} cards, ${s0.slots} slots at the top; scrolled to the end and back with none empty in view; ${id} dropped and built again on the version it was stepped to`);
  }, { height: 100 });
}
