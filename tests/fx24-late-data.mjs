import { withPage, assert, eq, sleep, BASE } from "./lib.mjs";
export const name = "late data — the queue, usage and timelines arriving late leave the built cards as they are; a reload applies while later pages are still coming";

export async function run(log) {
  await withPage(async (page, errs) => {
    let stamp = "s1", sinceAt = 0, released = false;
    await page.setRequestInterception(true);
    const seen = [];
    page.on("request", async (r) => {
      const u = new URL(r.url());
      if (u.pathname.startsWith("/api/cards")) seen.push(`${((Date.now() % 100000) / 1000).toFixed(1)} ${u.pathname}${u.search}`);
      if (r.method() !== "GET" && r.method() !== "HEAD")
        return r.respond({ status: 200, contentType: "application/json", body: "{}" });
      // late arrivals: the queue, usage and timelines answer a second after the cards
      if (/^\/api\/(queue|usage\/all|arrangements)/.test(u.pathname)) { await sleep(1500); return r.continue(); }
      if (u.pathname === "/api/cards/stamp")
        return r.respond({ status: 200, contentType: "application/json", body: JSON.stringify({ stamp }) });
      if (u.pathname === "/api/cards" && u.searchParams.get("type") === "fx_visual") {
        if (u.searchParams.has("since")) {
          sinceAt = Date.now();
          const all = await (await fetch(`${BASE}/api/cards?type=fx_visual&limit=24`)).json();
          const c = { ...all.cards[0], label: "changed while paging" };
          return r.respond({ status: 200, contentType: "application/json",
                             body: JSON.stringify({ gen: "g2", changed: [c], removed: [] }) });
        }
        if (u.searchParams.has("skip")) {              // the later pages: held back until the check lets them go
          while (!released) await sleep(100);
          return r.respond({ status: 200, contentType: "application/json", body: JSON.stringify({ cards: [], more: 0 }) });
        }
        const res = await (await fetch(BASE + u.pathname + u.search)).json();
        return r.respond({ status: 200, contentType: "application/json", body: JSON.stringify({ ...res, more: 40 }) });
      }
      return r.continue();
    });
    await page.goto(BASE + "/?tab=fx_visual", { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".grid article.card:not(.compose)", { timeout: 30000 });
    await page.evaluate(() => { window.__marked = [...document.querySelectorAll(".grid article.card:not(.compose)")];
                                window.__marked.forEach((a) => { a.__first = true; }); });
    await sleep(2500);                                 // the late arrivals have come
    const kept = await page.evaluate(() => ({ n: window.__marked.length, still: window.__marked.filter((a) => a.isConnected).length }));
    eq(kept.still, kept.n, `the cards built first are still on the page, the same elements, after the late data`);
    stamp = "s2";
    const t0 = Date.now();
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange", { bubbles: true })));
    await page.waitForFunction(() => !document.querySelector(".grid article.card:not(.compose)").__first, { timeout: 4000 })
      .catch((e) => { console.log(seen.join("\n")); throw e; });
    const took = Date.now() - t0;
    assert(sinceAt && !released, "the reload's changes came while the later pages were still held back");
    released = true;
    assert(took < 2000, `the changed card was rebuilt in ${took} ms, not after the paging`);
    assert(!errs.length, "page errors: " + errs.slice(0, 4).join(" | "));
    log(`${kept.n} cards kept through the late queue, usage and timelines; a reload during paging applied in ${took} ms`);
  });
}
