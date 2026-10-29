import { withPage, assert, eq, sleep, BASE } from "./lib.mjs";
export const name = "tabs — whole tabs that fit, ⋯ for the rest, reorder by taps in the bar (PATCH answered)";
export async function run(log) {
  await withPage(async (page, errs) => {
    const sent = [];
    let failNext = false, holdNext = 0;
    page.on("request", (r) => {
      if (r.method() === "GET" || r.method() === "HEAD") return r.continue();
      sent.push({ path: new URL(r.url()).pathname, body: JSON.parse(r.postData() || "{}") });
      const fail = failNext && /\/api\/prefs$/.test(r.url()) && /tab_order/.test(r.postData() || "");
      if (fail) failNext = false;
      const hold = holdNext && /tab_order/.test(r.postData() || "") ? holdNext : 0;
      if (hold) holdNext = 0;
      return sleep(hold).then(() => r.respond({ status: fail ? 500 : 200, contentType: "application/json", body: "{}" }));
    });
    await page.setViewport({ width: 412, height: 900, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
    await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".cardsbar .chip", { timeout: 20000 });
    await sleep(800);
    const bar = () => page.evaluate(() => {
      const b = document.querySelector(".cardsbar"), host = b.parentElement.getBoundingClientRect();
      const tabs = [...b.querySelectorAll(".chip:not(.tabmore)")];
      return {
        all: tabs.map((c) => c.textContent),
        shown: tabs.filter((c) => !c.hidden).map((c) => c.textContent),
        on: (tabs.find((c) => c.classList.contains("on")) || {}).textContent,
        cut: tabs.filter((c) => !c.hidden && c.scrollWidth > c.clientWidth + 1).map((c) => c.textContent),
        more: !!b.querySelector(".tabmore"), holds: b.querySelector(".tabmore").classList.contains("holds"),
        right: Math.round(b.getBoundingClientRect().right), room: Math.round(host.right),
      };
    });
    let b = await bar();
    log(`at 412 px: ${b.shown.join(", ")} in the bar of ${b.all.length}; ⋯ ${b.more ? "at the end" : "missing"}`);
    assert(b.more, "no ⋯ in the bar");
    eq(b.cut.length, 0, "a tab in the bar is cut off");
    assert(b.right <= b.room, `the bar runs past the row: ${b.right} > ${b.room}`);
    assert(b.shown.includes(b.on) !== b.holds, `the tab that is on is in the bar, or ⋯ is lit for it (${JSON.stringify(b)})`);
    const hidden = b.all.filter((t) => !b.shown.includes(t));
    assert(hidden.length > 0, `all ${b.all.length} tabs fit at 412 px — the check needs one behind ⋯`);
    await page.click(".cardsbar .tabmore");
    await sleep(300);
    const items = await page.$$eval(".tabmenu .revpi", (xs) => xs.map((x) => x.textContent));
    eq(JSON.stringify(items), JSON.stringify([...hidden, "reorder"]), "⋯ lists the tabs behind it, then reorder");
    await page.evaluate((t) => [...document.querySelectorAll(".tabmenu .revpi")].find((x) => x.textContent === t).click(),
                        hidden[hidden.length - 1]);
    await sleep(700);
    b = await bar();
    eq(b.on, hidden[hidden.length - 1], "the tab picked behind ⋯ is on");
    assert(!b.shown.includes(b.on) && b.holds, `…stays behind ⋯, ⋯ lit (${JSON.stringify(b)})`);
    assert(!(await page.$(".tabmenu")), "the menu closes");
    await page.click(".cardsbar .tabmore");
    await sleep(250);
    eq(await page.$$eval(".tabmenu .revpi.on", (xs) => xs.map((x) => x.textContent).join()), b.on, "the menu shows it on");
    await page.click(".cardsbar .tabmore");
    await sleep(150);
    log(`picked ${b.on} behind ⋯: on, behind ⋯ (lit), on in its menu; the bar ${b.shown.join(", ")}`);
    await page.evaluate(() => scrollTo(0, 0));
    await page.click(".cardsbar .tabmore");
    await sleep(200);
    await page.evaluate(() => [...document.querySelectorAll(".tabmenu .revpi")].find((x) => x.textContent === "reorder").click());
    await page.waitForSelector(".cardsbar.reorder .tord", { timeout: 5000 });
    await sleep(300);
    const tiles = await page.$$eval(".cardsbar .tord", (xs) => xs.map((x) => ({ s: x.dataset.slug, t: x.textContent,
                                                                           h: Math.round(x.getBoundingClientRect().height) })));
    log(`reorder: ${tiles.length} tabs, ${Math.min(...tiles.map((t) => t.h))}–${Math.max(...tiles.map((t) => t.h))} px tall`);
    assert(tiles.every((t) => t.h >= 28 && t.h <= 40), "the tabs the bar's size");
    const state = () => page.evaluate(() => {
      const sel = document.querySelector(".cardsbar .tord.sel");
      const ar = sel ? [...sel.querySelectorAll(".tordar")] : [];
      return { order: [...document.querySelectorAll(".cardsbar .tord")].map((x) => x.dataset.slug),
               sel: sel ? sel.dataset.slug : null, earlier: ar[0] ? ar[0].disabled : null, later: ar[1] ? ar[1].disabled : null };
    });
    let st = await state();
    eq(st.sel, null, "nothing picked: no arrows");
    const last = tiles[tiles.length - 1].s;
    await page.click(`.cardsbar .tord[data-slug="${last}"]`);
    st = await state();
    eq(st.sel, last, "a tap picks it: it grows ‹ ›");
    assert(!st.earlier && st.later, `last: › off (${JSON.stringify(st)})`);
    for (let k = 1; k < tiles.length; k++) await page.click(".cardsbar .tord.sel .tordar:first-child");
    st = await state();
    eq(st.order[0], last, "‹, four times: it is first");
    assert(st.earlier && !st.later, `first: ‹ off (${JSON.stringify(st)})`);
    await page.click(".cardsbar .tord.sel .tordn");
    eq((await state()).sel, null, "a tap on its name puts it down");
    eq(sent.filter((x) => x.body.tab_order).length, 0, "nothing saved before done");
    failNext = true;
    await page.click(".cardsbar .tabdone");
    await sleep(500);
    assert(await page.$(".cardsbar.reorder"), "a failed save: it stays open, the order kept");
    eq((await state()).order[0], last, "…the draft as it was");
    holdNext = 800;
    await page.click(".cardsbar .tabdone");
    await sleep(250);
    const busy = await page.evaluate(() => [...document.querySelectorAll(".cardsbar .tord, .cardsbar .tord button, .cardsbar .tabdone")]
      .filter((x) => x.tagName === "BUTTON").every((x) => x.disabled));
    assert(busy, "while done saves, every tab, arrow and done is off");
    await sleep(1000);
    const patch = sent.filter((x) => x.path === "/api/prefs" && x.body.tab_order);
    eq(patch.length, 2, "done saved once each time");
    eq(patch.at(-1).body.tab_order.length, tiles.length, "the saved order names every tab");
    log(`saved tab_order (after one failed try): ${JSON.stringify(patch.at(-1).body.tab_order)}`);
    assert(!(await page.$(".cardsbar.reorder")), "done: the bar is the bar again");
    b = await bar();
    eq(b.all[0], tiles[tiles.length - 1].t, "the bar follows the new order");
    const kept = (await bar()).all.join();
    for (const how of ["cancel", "back"]) {
      await page.click(".cardsbar .tabmore");
      await sleep(200);
      await page.evaluate(() => [...document.querySelectorAll(".tabmenu .revpi")].find((x) => x.textContent === "reorder").click());
      await page.waitForSelector(".cardsbar.reorder .tord", { timeout: 5000 });
      await page.click(`.cardsbar .tord[data-slug="${(await state()).order.at(-1)}"]`);
      await page.click(".cardsbar .tord.sel .tordar:first-child");
      if (how === "cancel") await page.click(".cardsbar .tabcancel");
      else await page.goBack({ timeout: 2000 }).catch(() => {});
      await sleep(400);
      assert(!(await page.$(".cardsbar.reorder")), `${how}: the bar is the bar again`);
      eq((await bar()).all.join(), kept, `${how}: the tabs as they were`);
    }
    eq(sent.filter((x) => x.path === "/api/prefs" && x.body.tab_order).length, 2, "cancel and back saved nothing");
    log("cancel and back: the tabs as they were, nothing saved");
    const real = errs.filter((e) => !/HTTP 500 \/api\/prefs|status of 500/.test(e));
    assert(!real.length, real.join("\n"));
  });
}
