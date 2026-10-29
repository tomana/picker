import { withPage, showTab, assert, eq, sleep, BASE } from "./lib.mjs";
export const name = "what a send hands — the ⓘ before the sends (the open card's, + add idea's, AUTO's) says what goes to the agent";
const CARD = "fx0a1b2c3d4e";
export async function run(log) {
  await withPage(async (page, errs) => {
    await page.goto(`${BASE}/?card=${CARD}`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".sheet.big:not([hidden]) .acts .seesb", { timeout: 20000 });
    await sleep(800);
    const open = async () => {
      await page.click(".sheet.big:not([hidden]) .acts .seesb");
      await page.waitForFunction(() => {
        const t = document.querySelector(".ibub.sees")?.textContent || "";
        return t && !/Its guide: …/.test(t);
      }, { timeout: 20000 });
      return page.$$eval(".ibub.sees .sees > *", (x) => x.map((n) => n.textContent));
    };
    const s = await open();
    const v = await page.evaluate(() => document.querySelector(".sheet.big .vpip.on")?.textContent.replace(/\D/g, ""));
    assert(new RegExp(`^revise hands \\S+ v${v}, the version on screen, to make v4 of this card\\.$`).test(s[0]),
           `revise's sentence: ${s[0]}`);
    eq(s[1], "inspire hands it the same, to make a new card from it.", "inspire's sentence");
    assert(/^With them: your votes \(v2 ▲1; v1 none; v3 held by AUTO\)/.test(s[2]), `the votes: ${s[2]}`);
    assert(/what you write here — or, with nothing, "the same idea, taken further or fixed"/.test(s[2]),
           `what no words mean: ${s[2]}`);
    assert(/ Its guide: \S*program\.md\.$/.test(s[2]), `the guide the brief names: ${s[2]}`);
    eq(s.at(-1), "the whole brief ›", "the link to the brief");
    const at = await page.evaluate(() => {
      const b = document.querySelector(".ibub.sees").getBoundingClientRect();
      const i = document.querySelector(".sheet.big .acts .seesb").getBoundingClientRect();
      return { up: document.querySelector(".ibub.sees").classList.contains("up"), bottom: b.bottom, top: b.top,
               left: b.left, right: b.right, itop: i.top, w: innerWidth };
    });
    assert(at.up && at.bottom <= at.itop && at.top >= 0, `the bubble isn't over its ⓘ: ${JSON.stringify(at)}`);
    assert(at.left >= 0 && at.right <= at.w, `the bubble leaves the screen: ${JSON.stringify(at)}`);
    log(`${s[0]} ${s[1]} ${s[2]}`);
    await page.click(".sheet.big:not([hidden]) .acts .seesb");
    eq(await page.$(".ibub.sees"), null, "a second tap closes it");
    await page.type(".sheet.big textarea.ideabox", "zz slower");
    const t = await open();
    assert(/your words, "zz slower"/.test(t[2]), `the words in the field: ${t[2]}`);
    await page.click(".ibub.sees .seesmore");
    await page.waitForSelector(".sheet.configured:not([hidden])", { timeout: 10000 });
    const head = await page.$eval(".sheet.configured .shead .t", (x) => x.textContent);
    assert(/^revise with \S+ · as configured$/.test(head), `the brief's sheet: ${head}`);
    eq(await page.$(".ibub.sees"), null, "the bubble goes with the tap");
    await page.keyboard.press("Escape");
    const bubble = async (sel) => {
      await page.click(sel);
      await page.waitForFunction(() => {
        const t = document.querySelector(".ibub.sees")?.textContent || "";
        return t && !/Its guide: …/.test(t);
      }, { timeout: 20000 });
      return page.$$eval(".ibub.sees .sees > *", (x) => x.map((n) => n.textContent));
    };
    await showTab(page, "fx_visual");
    await page.waitForSelector(".card.compose.addidea", { timeout: 20000 });
    await page.click(".card.compose.addidea .phead-tog");
    await page.waitForSelector(".sheet.idea:not([hidden]) textarea", { timeout: 8000 });
    await page.type(".sheet.idea textarea", "zz a bell in fog");
    const i = await bubble(".sheet.idea .autofoot .seesb");
    assert(/^make hands \S+ your words, "zz a bell in fog", alone, to make a new card from nothing else\.$/.test(i[0]),
           `make's sentence: ${i[0]}`);
    assert(/^With them: any image you paste in\. Its guide: \S*program\.md\.$/.test(i[1]), `the idea's rest: ${i[1]}`);
    log(`${i[0]} ${i[1]}`);
    await page.click(".sheet.idea .autofoot .seesb");
    await page.keyboard.press("Escape");
    await page.waitForSelector(".card.compose.autop .phead-tog", { timeout: 20000 });
    if (!(await page.$(".card.compose.autop .phead.open"))) { await page.click(".card.compose.autop .phead-tog"); await sleep(400); }
    await page.click(".card.compose.autop .astrip .astext");
    await page.waitForSelector(".sheet.auto:not([hidden]) .acrit", { timeout: 15000 });
    await page.evaluate(() => [...document.querySelectorAll(".sheet.auto .akind")][2].click());
    await page.type(".sheet.auto textarea.ainstr", "zz darker");
    const u = await bubble(".sheet.auto .autofoot .seesb");
    assert(/^revise hands \S+ a card from the .+ auto pool \(none marked: every active card\), .+, at its newest version not voted down, to make its next version, with AUTO's words: ".+"$/.test(u[0]),
           `AUTO's revise: ${u[0]}`);
    assert(/^inspire, by turns, hands it a card the same way, to make a new card from it, with AUTO's words: ".+"$/.test(u[1]),
           `AUTO's inspire: ${u[1]}`);
    assert(/^With them: your votes on the card and your comment as its direction, "zz darker", which wins where it and the votes disagree\./.test(u[2]),
           `AUTO's rest: ${u[2]}`);
    log(u.join(" "));
    assert(!errs.length, errs.join("\n"));
  });
}
