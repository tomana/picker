import { withPage, api, assert, eq, sleep, BASE } from "./lib.mjs";
export const name = "stubs — the rest of a tab comes without its rows; the grid fetches them by id as it nears them, under the same names";

export async function run(log) {
  const all = (await api("/api/cards?type=fx_visual")).cards;
  assert(all.length >= 5, `fx_visual has ${all.length} cards, the check wants 5`);
  await withPage(async (page, errs) => {
    let released = false;
    const asked = [], rest = [];
    await page.setRequestInterception(true);
    page.on("request", async (r) => {
      const u = new URL(r.url());
      if (r.method() !== "GET" && r.method() !== "HEAD")
        return r.respond({ status: 200, contentType: "application/json", body: "{}" });
      if (u.pathname === "/api/cards" && u.searchParams.get("type") === "fx_visual") {
        if (u.searchParams.has("ids")) {               // rows by id: held back until the check lets them go
          asked.push(...u.searchParams.get("ids").split(","));
          while (!released) await sleep(100);
          return r.continue();
        }
        if (u.searchParams.has("skip")) { rest.push(u.search); return r.continue(); }
        if (u.searchParams.get("limit") === "24") {    // a first page of two, so the rest come as stubs
          const res = await (await fetch(`${BASE}/api/cards?type=fx_visual&limit=2`)).json();
          return r.respond({ status: 200, contentType: "application/json", body: JSON.stringify(res) });
        }
      }
      return r.continue();
    });
    await page.goto(BASE + "/?tab=fx_visual", { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".grid article.card:not(.compose)", { timeout: 30000 });
    await sleep(1500);
    assert(rest.length && rest.every((s) => /[?&]light=1/.test(s)), `the later pages asked for stubs: ${rest.join(" ")}`);
    const held = await page.evaluate(() => [...document.querySelectorAll(".grid .cardph.nodata")]
      .map((ph) => ({ id: ph.dataset.cid, name: ph.querySelector(".phname").textContent })));
    eq(held.length, all.length - 2, "slots waiting for their rows");
    eq(await page.evaluate(() => document.querySelectorAll(".grid article.card:not(.compose)").length), 2,
       "cards built before their rows came");
    assert(held.every((h) => asked.includes(h.id)), `rows asked for: ${asked.join(",")}`);
    released = true;
    await page.waitForFunction((n) => document.querySelectorAll(".grid article.card:not(.compose)").length === n
                                      && !document.querySelector(".grid .cardph.nodata"), { timeout: 8000 }, all.length);
    const names = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll(".grid article.card[data-cid]")]
      .map((a) => [a.dataset.cid, a.querySelector(".cref").textContent])));
    for (const h of held) eq(names[h.id], h.name, `${h.id}'s name as a stub and as a card`);
    const last = held.at(-1).id;
    await page.evaluate((id) => {
      const a = document.querySelector(`.grid article.card[data-cid="${id}"]`);
      a.scrollIntoView({ block: "center" });
      (a.querySelector(".media, .vblock") || a).click();
    }, last);
    await page.waitForSelector(".sheet.big:not([hidden])", { timeout: 5000 });
    assert(!errs.length, "page errors: " + errs.slice(0, 4).join(" | "));
    log(`${held.length} stubs waited for their rows, became cards under the same names, and the last one opens`);
  });
}
