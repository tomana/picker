import { withPage, assert, eq, sleep } from "./lib.mjs";
export const name = "walkthrough — from ⚙, a spotlight on each part of the page; back ends it (nothing written)";
export async function run(log) {
  await withPage(async (page, errs) => {
    const sent = [];
    page.on("request", (r) => {
      if (r.method() === "GET" || r.method() === "HEAD") return r.continue();
      sent.push(new URL(r.url()).pathname);
      return r.respond({ status: 200, contentType: "application/json", body: "{}" });
    });
    await page.waitForSelector('button[title^="agents:"]', { timeout: 20000 });
    await sleep(800);
    await page.click('button[title^="agents:"]');
    const openList = async () => {
      await page.waitForSelector(".sheet.settings .swhead", { timeout: 10000 });
      eq(await page.$eval(".sheet.settings .sbody > :first-child .swhead", (b) => b.textContent), "help",
         "the walkthrough is ⚙'s first, headed help");
      eq(await page.$eval(".sheet.settings .swalk", (l) => l.hidden), true, "its pane starts shut");
      await page.click(".sheet.settings .swhead");
      eq(await page.$eval(".sheet.settings .swalk", (l) => l.hidden), false, "its head opens it");
    };
    const pick = (key) => page.evaluate((k) => document.querySelector(`.sheet.settings .swk[data-key="${k}"]`).click(), key);
    await openList();
    const lines = await page.$$eval(".sheet.settings .swk", (x) => x.map((y) => [y.dataset.key, y.textContent]));
    const keys = lines.map(([k]) => k).filter((k) => k !== "an open card");
    for (const [k, t] of lines) assert(/^[A-Z].{4,48}\.$/.test(t), `the line for "${k}" is not one short sentence: ${t}`);
    for (const k of ["the picker", "tabs", "a card", "add", "usage and queue", "settings"])
      assert(keys.includes(k), `no "${k}" step on the made-up picker: ${keys.join(", ")}`);
    await pick(keys[0]);
    await page.waitForSelector(".walk .wcap", { timeout: 5000 });
    eq(await page.$eval(".sheet.settings", (s) => s.hidden), true, "⚙ goes when the walk starts");
    const seen = [];
    for (let i = 0; i < keys.length; i++) {
      const st = await page.evaluate(() => {
        const hole = document.querySelector(".walk .whole"), cap = document.querySelector(".walk .wcap");
        const h = hole.getBoundingClientRect(), c = cap.getBoundingClientRect();
        return { k: document.querySelector(".walk .wk span").textContent, of: document.querySelector(".walk .wk span:last-child").textContent,
                 hole: !hole.hidden, words: document.querySelector(".walk .wt").textContent,
                 onScreen: c.top >= 0 && c.bottom <= innerHeight, clear: hole.hidden || c.bottom <= h.top + 1 || c.top >= h.bottom - 1,
                 inView: hole.hidden || (h.bottom > 0 && h.top < innerHeight), next: document.querySelector(".walk .wnav .wbtn:last-child").textContent };
      });
      eq(st.k, keys[i], `step ${i + 1} is the one ⚙ listed`);
      eq(st.of, `${i + 1} / ${keys.length}`, "its count");
      assert(st.words.length > 30, `step "${st.k}" says little: ${st.words}`);
      assert(st.onScreen && st.clear && st.inView, `step "${st.k}": the box ${JSON.stringify(st)}`);
      eq(st.hole, st.k !== "the picker", `"${st.k}": a part in the light, except the first, the whole page`);
      if (st.k === "tabs") assert(/This one, .+, is (picked|hybrid|scored)/.test(st.words), `the tabs step names this tab's kind: ${st.words}`);
      seen.push(st.k);
      if (i < keys.length - 1) { await page.click(".walk .wnav .wbtn:last-child"); await sleep(250); }
      else eq(st.next, "done", "the last step's button is done");
    }
    await page.goBack().catch(() => {});
    await sleep(400);
    eq(await page.$(".walk"), null, "back ended the walk");
    assert(await page.$('button[title^="agents:"]'), "back left the page");
    await page.click('button[title^="agents:"]');
    await openList();
    await pick("a card");
    await page.waitForSelector(".walk .wcap", { timeout: 5000 });
    eq(await page.$eval(".walk .wk span", (s) => s.textContent), "a card", "a step from ⚙ starts there");
    await page.keyboard.press("Escape");
    await sleep(300);
    eq(await page.$(".walk"), null, "Escape ended it");
    await page.click('button[title^="agents:"]');
    await openList();
    await pick("an open card");
    await page.waitForSelector(".walk .wcap", { timeout: 8000 });
    assert(await page.$(".sheet.big:not([hidden])"), "the card walk opened a card");
    const cardSteps = [];
    for (let i = 0; i < 12; i++) {
      const st = await page.evaluate(() => {
        const hole = document.querySelector(".walk .whole").getBoundingClientRect(), sh = document.querySelector(".sheet.big:not([hidden])").getBoundingClientRect();
        const c = document.querySelector(".walk .wcap").getBoundingClientRect();
        return { k: document.querySelector(".walk .wk span").textContent, of: document.querySelector(".walk .wk span:last-child").textContent,
                 inSheet: hole.top >= sh.top - 4 && hole.bottom <= sh.bottom + 4 && hole.height > 10,
                 clear: c.bottom <= hole.top + 1 || c.top >= hole.bottom - 1, onScreen: c.top >= 0 && c.bottom <= innerHeight,
                 next: document.querySelector(".walk .wnav .wbtn:last-child").textContent };
      });
      assert(st.inSheet && st.onScreen, `card step "${st.k}": ${JSON.stringify(st)}`);
      cardSteps.push(st.k + (st.clear ? "" : " (box over it)"));
      if (st.next === "done") break;
      await page.click(".walk .wnav .wbtn:last-child");
      await sleep(250);
    }
    for (const k of ["the card", "send it on", "the text", "versions", "the foot"])
      assert(cardSteps.some((x) => x.startsWith(k)), `no "${k}" step in the card walk: ${cardSteps.join(", ")}`);
    await page.click(".walk .wnav .wbtn:last-child");
    await sleep(500);
    eq(await page.$(".walk"), null, "done ended the card walk");
    eq(await page.$(".sheet.big:not([hidden])"), null, "…and shut the card it opened");
    eq(sent.length, 0, `the walk wrote: ${sent.join(", ")}`);
    eq(errs.length, 0, `page errors: ${errs.join(" | ")}`);
    log(`${keys.length} steps: ${seen.join(" · ")}; back and Escape end it; an open card's: ${cardSteps.join(" · ")}; nothing written`);
  });
}
