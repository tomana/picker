import { withPage, assert, eq, sleep, showTab, api } from "./lib.mjs";
export const name = "vote now — an AUTO list's − + shows at once, quick taps count on, a failed save puts it back";

export async function run(log) {
  const { cards } = await api("/api/cards?type=fx_music");
  const one = cards.find((c) => (c.versions || []).length === 1 && !c.archived);
  assert(one, "an fx_music card with one version");
  await withPage(async (page, errs) => {
    const posts = [];
    let fail = false;
    await page.setRequestInterception(true);
    page.on("request", async (r) => {
      const u = new URL(r.url());
      if (r.method() === "GET" && u.pathname === "/api/auto/made")
        return r.respond({ status: 200, contentType: "application/json", body: JSON.stringify({
          made: [{ card: one.id, n: 1, vid: "v1", label: one.label || one.id, ts: Date.now() / 1000 - 60, vote: 0,
                   audio: ((one.versions[0] || {}).media || {}).audio || null }], making: [], total: 1 }) });
      if (r.method() === "POST" && /\/api\/cards\/[^/]+\/signal$/.test(u.pathname)) {
        posts.push(JSON.parse(r.postData() || "{}"));
        await sleep(2000);                                   // a slow phone link
        return fail ? r.respond({ status: 500, contentType: "application/json", body: '{"description":"down"}' })
                    : r.respond({ status: 200, contentType: "application/json", body: "{}" });
      }
      if (r.method() === "GET" || r.method() === "HEAD") return r.continue();
      return r.respond({ status: 200, contentType: "application/json", body: "{}" });
    });
    await showTab(page, "fx_music");
    await page.waitForSelector(".card.compose.autop .phead-tog", { timeout: 30000 });
    if (!(await page.$(".card.compose.autop .phead.open"))) await page.click(".card.compose.autop .phead-tog");
    await page.waitForSelector(".card.compose.autop .aulog .auvote", { timeout: 10000 });
    const val = () => page.$eval(".card.compose.autop .aulog .auval", (x) => x.textContent);
    const tap = (k) => page.$$eval(".card.compose.autop .aulog .auv", (bs, k) => bs[k].click(), k);
    eq(await val(), "0", "the row starts at 0");
    await tap(1);
    await sleep(150);
    eq(await val(), "+1", "+ shows at once, before the save answers");
    await tap(1);
    await sleep(150);
    eq(await val(), "+2", "a quick second + counts on");
    eq(JSON.stringify(posts.map((p) => p.value)), "[1,2]", "and each tap saves what it shows");
    await sleep(2600);
    fail = true;
    const shown = await val();
    await tap(0);
    await sleep(150);
    eq(await val(), shown === "+2" ? "+1" : String(Number(shown) - 1), "− shows at once too");
    await sleep(2600);
    eq(await val(), "0", "a failed save puts the list's own value back");
    assert(await page.evaluate(() => /not saved/.test((document.querySelector(".ptoast") || {}).textContent || "")),
           "and says it wasn't saved");
    const other = errs.filter((e) => !/500|signal/.test(e));          // the forced failure's own lines aside
    assert(!other.length, "page errors: " + other.slice(0, 4).join(" | "));
    log(`${one.id}: + and + show at once (posts ${posts.map((p) => p.value).join(", ")}); a failed − goes back to the list's value`);
  });
}
