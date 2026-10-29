import { withPage, assert, eq, sleep, BASE, api } from "./lib.mjs";
export const name = "one grid, the archive at the bottom — open it, come back (writes intercepted)";
const SHOTS = process.env.SHOTS;
const gridIds = (page) => page.$$eval(".grid article.card:not(.compose), .grid .cardph",
  (cs) => cs.map((c) => c.dataset.cid));
const lastIsArchiveBtn = (page) => page.$eval(".grid", (g) =>
  g.lastElementChild && g.lastElementChild.classList.contains("archbtn") ? g.lastElementChild.textContent : null);
export async function run(log) {
  const active = (await api("/api/cards?type=fx_visual")).cards.map((c) => c.id);
  const all = (await api("/api/cards?type=fx_visual&archived=1")).cards;
  const archived = new Set(all.filter((c) => c.archived).map((c) => c.id));
  await withPage(async (page, errs) => {
    const sent = [];
    await page.setRequestInterception(true);
    page.on("request", async (r) => {
      const u = r.url();
      if (r.method() === "GET") return r.continue();
      const body = JSON.parse(r.postData() || "{}");
      sent.push({ url: u.replace(BASE, ""), method: r.method(), body });
      const m = u.match(/\/api\/cards\/([^/]+)\/signal$/);
      if (m && body.kind === "pool") {
        const card = await api(`/api/cards/${m[1]}`);
        return r.respond({ status: 200, contentType: "application/json",
                           body: JSON.stringify({ ...card, pools: body.value ? ["auto"] : [] }) });
      }
      if (/\/api\/prefs$/.test(u)) return r.respond({ status: 200, contentType: "application/json", body: "{}" });
      r.abort();
    });
    await page.goto(BASE + "/?tab=fx_visual", { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".grid article.card:not(.compose)", { timeout: 30000 });
    await sleep(500);
    const shown = await gridIds(page);
    eq(shown.length, active.length, "the grid shows every card that is not archived");
    assert(shown.every((id) => !archived.has(id)), "no archived card on the grid");
    const lead = await page.$eval(".grid", (g) => [...g.children].slice(0, 3).map((e) =>
      e.classList.contains("autop") ? "auto" : e.classList.contains("cup") ? "cup" : e.className.split(" ")[0]));
    eq(lead.slice(0, 2).join(" "), "auto cup", "AUTO, then the cup, at the top of the grid");
    eq(await lastIsArchiveBtn(page), "archive", "the archive button is the grid's last element");
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/archive-1-grid.png` });
    log(`grid: ${shown.length} cards, the archive button last`);
    await page.click(`.grid article.card[data-cid="${shown[0]}"] .media`);
    await page.waitForSelector("div.sheet.big:not([hidden]) .poolbtn", { timeout: 10000 });
    const before = await page.$eval(".poolbtn", (b) => (b.classList.contains("on") ? "in the pool" : "not in the pool"));
    await page.click(".poolbtn");
    await sleep(400);
    const sig = sent.find((s) => /\/signal$/.test(s.url));
    assert(sig && sig.body.kind === "pool" && sig.body.pool === "auto", `the pool button writes a pool signal: ${JSON.stringify(sig && sig.body)}`);
    eq(await page.$$eval(".poolbtn svg", (x) => x.length), 2, "the pool button carries a drawn + or ✓ and the pool's icon");
    log(`open card: "${before}" → a pool signal`);
    await page.keyboard.press("Escape");
    await page.evaluate(() => document.querySelector("div.scrim:not([hidden])")?.click());
    await sleep(400);
    if (!(await page.$(".card.compose.autop .astrip"))) { await page.click(".card.compose.autop .phead-tog"); await sleep(800); }
    await page.click(".card.compose.autop .poolpickb");
    await sleep(500);
    eq(await page.$$eval(".grid.poolpicking .ppick", (x) => x.length), shown.length, "a pool toggle on every card");
    const n0 = sent.length;
    await page.$eval(".grid .ppick", (b) => b.click());
    await sleep(400);
    const ps = sent.slice(n0).find((x) => /\/signal$/.test(x.url));
    assert(ps && ps.body.kind === "pool" && ps.body.pool === "auto", `the corner toggle writes a pool signal: ${JSON.stringify(ps && ps.body)}`);
    await page.click(".card.compose.autop .poolpickb");
    await sleep(300);
    eq(await page.$$eval(".grid .ppick", (x) => x.length), 0, "done takes the toggles away");
    log(`pick: ${shown.length} corner toggles, one tap → a pool signal; done: none`);
    await page.$eval(".grid .archbtn", (b) => b.scrollIntoView());
    await page.click(".grid .archbtn");
    await page.waitForSelector(".grid .archhead", { timeout: 30000 });
    await page.waitForFunction(() => !/loading/.test(document.querySelector(".archhead").textContent), { timeout: 30000 });
    const order = await page.$eval(".grid", (g) => [...g.children].map((e) =>
      e.classList.contains("archtop") ? "exit" : e.classList.contains("archbtn") ? "back"
        : e.classList.contains("archhead") ? "head" : e.classList.contains("cup") ? "cup"
        : e.classList.contains("cardwrap") || e.classList.contains("gblock") ? "card" : "other"));
    eq(order.slice(0, 3).join(" "), "exit head card", "the archive opens with the way out, then the cards — no cup");
    eq(order[order.length - 1], "back", "and ends with the way out");
    const inArch = await gridIds(page);
    eq(inArch.length, archived.size, "the archive shows every archived visual card");
    assert(inArch.every((id) => archived.has(id)), "only archived cards in the archive");
    eq(await lastIsArchiveBtn(page), "back to the cards", "the way back is at the bottom too");
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/archive-2-archive.png` });
    log(`archive: ${inArch.length} cards — ${await page.$eval(".archhead", (x) => x.textContent)}`);
    await page.click(`.grid article.card[data-cid="${inArch[0]}"] .media`);
    await page.waitForSelector("div.sheet.big:not([hidden])", { timeout: 10000 });
    const arch = await page.$$eval("div.sheet.big:not([hidden]) button.wide", (bs) => bs.map((b) => b.textContent.trim()));
    assert(arch.some((t) => /unarchive/.test(t)), "an archived card's button says unarchive");
    await page.keyboard.press("Escape");
    await page.evaluate(() => document.querySelector("div.scrim:not([hidden])")?.click());
    await sleep(400);
    await page.$eval(".grid .archbtn", (b) => b.scrollIntoView());
    await page.click(".grid .archbtn");
    await page.waitForFunction(() => !document.querySelector(".grid .archhead"), { timeout: 30000 });
    eq((await gridIds(page)).length, active.length, "back: the grid again");
    log("back to the cards");
    assert(!sent.some((s) => s.body.kind === "archive"), "nothing was archived or unarchived");
    assert(!errs.filter((e) => !/ERR_FAILED|aborted/i.test(e)).length,
           "page errors: " + errs.slice(0, 3).join(" | "));
  });
}
