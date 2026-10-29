import { withPage, showTab, assert, eq, sleep, BASE } from "./lib.mjs";
export const name = "fixture — a reload reads only what changed; the other cards stay as they are";
export async function run(log) {
  await withPage(async (page, errs) => {
    const asked = [];
    page.on("request", (r) => { const u = new URL(r.url()); if (u.pathname === "/api/cards") asked.push(u.search); });
    await showTab(page, "fx_music");
    await page.waitForSelector(".grid article.card");
    await sleep(1000);
    const [a, b] = await page.evaluate(() => {
      const cs = [...document.querySelectorAll(".grid article.card:not(.compose)")].slice(0, 2);
      cs.forEach((c, i) => { c.dataset.mark = String(i); });
      return cs.map((c) => c.dataset.cid);
    });
    assert(a && b, "two cards on screen");
    asked.length = 0;
    const r = await fetch(`${BASE}/api/cards/${a}/signal`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind: "vote", value: 2 }) });
    eq(r.status, 200, "the vote");
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange", { bubbles: true })));
    let after = null;
    for (let i = 0; i < 40 && !after; i++) {
      await sleep(200);
      after = await page.evaluate((a, b) => {
        const ea = document.querySelector(`.grid article.card[data-cid="${a}"]`);
        const eb = document.querySelector(`.grid article.card[data-cid="${b}"]`);
        return ea && !ea.dataset.mark ? { a: !!ea, aMark: ea.dataset.mark || null, bMark: eb && eb.dataset.mark } : null;
      }, a, b);
    }
    assert(after, `${a} was not built again after its vote`);
    eq(after.bMark, "1", `${b} was built again though it didn't change`);
    assert(asked.some((q) => /since=/.test(q)), `the reload didn't ask what changed: ${asked.join(" | ")}`);
    assert(!asked.some((q) => /limit=|skip=/.test(q) || q === `?type=fx_music`), `the reload read the list again: ${asked.join(" | ")}`);
    eq(errs.length, 0, `page errors: ${errs.join(" | ")}`);
    log(`${a} voted past the page: built again; ${b} the same element; asked ${asked.join(" ")}`);
  }, { writes: true });
}
