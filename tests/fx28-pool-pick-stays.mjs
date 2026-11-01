import { withPage, assert, sleep, showTab, api } from "./lib.mjs";
export const name = "a pool pick stays put — the reload a real save brings rebuilds the grid without moving the card tapped";

export async function run(log) {
  await withPage(async (page, errs) => {
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    let stamp = null, changed = null;
    await page.setRequestInterception(true);
    page.on("request", async (r) => {
      const u = new URL(r.url());
      const m = u.pathname.match(/^\/api\/cards\/([^/]+)\/signal$/);
      if (r.method() === "POST" && m) {                  // the save, answered as the store would
        const body = JSON.parse(r.postData() || "{}"), c = await api(`/api/cards/${m[1]}`);
        const ps = new Set(c.pools || []); if (body.value) ps.add("auto"); else ps.delete("auto");
        changed = { ...c, pools: [...ps] }; stamp = `s${Date.now()}`;
        return r.respond({ status: 200, contentType: "application/json", body: JSON.stringify(changed) });
      }
      if (u.pathname === "/api/cards/stamp" && stamp)
        return r.respond({ status: 200, contentType: "application/json", body: JSON.stringify({ stamp }) });
      if (u.pathname === "/api/cards" && u.searchParams.has("since") && changed)
        return r.respond({ status: 200, contentType: "application/json",
                           body: JSON.stringify({ gen: `g${stamp}`, changed: [changed], removed: [] }) });
      if (r.method() === "GET" || r.method() === "HEAD") return r.continue();
      return r.respond({ status: 200, contentType: "application/json", body: "{}" });
    });
    await showTab(page, "fx_music");
    await page.waitForSelector(".card.compose.autop .phead-tog", { timeout: 30000 });
    if (!(await page.$(".card.compose.autop .phead.open"))) await page.click(".card.compose.autop .phead-tog");
    await sleep(1200);
    await page.evaluate(() => document.querySelector(".card.compose.autop .poolpickb:not(.poolclearb)").click());
    await sleep(600);
    const n = await page.$$eval(".grid article.card:not(.compose)", (a) => a.length);
    const moves = [];
    for (const k of [Math.min(9, n - 1), Math.min(13, n - 1)]) {
      const at = await page.evaluate((k) => {
        const a = document.querySelectorAll(".grid article.card:not(.compose)")[k];
        a.scrollIntoView({ block: "center" });
        return a.dataset.cid;
      }, k);
      await sleep(500);
      const top = () => page.evaluate((id) => Math.round(document.querySelector(`.grid article.card[data-cid="${id}"]`).getBoundingClientRect().top), at);
      const t0 = await top();
      const p = await page.evaluate((id) => { const r = document.querySelector(`.grid article.card[data-cid="${id}"] .ppick`).getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }, at);
      await page.touchscreen.tap(p.x, p.y);
      await sleep(500);
      await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange", { bubbles: true })));
      await sleep(1200);
      moves.push(`${at} ${t0}→${await top()}`);
      assert(Math.abs((await top()) - t0) <= 2, `the card tapped moved: ${moves.at(-1)}`);
    }
    assert(changed, "a pool save went out");
    assert(!errs.length, "page errors: " + errs.slice(0, 4).join(" | "));
    log(`tapped, saved, reloaded, the grid rebuilt: ${moves.join(", ")}`);
  });
}
