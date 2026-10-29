import { withPage, assert, eq, sleep, api, BASE } from "./lib.mjs";
export const name = "auto on — a comment saves itself once typing pauses, alone (PUT intercepted)";

export async function run(log) {
  const real = await api("/api/auto");
  await withPage(async (page, errs) => {
    let settings = { ...real.settings, on: true, types: [...new Set([...(real.settings.types || []), "fx_visual"])] };
    const puts = [];
    await page.setRequestInterception(true);
    page.on("request", (r) => {
      if (r.method() === "GET" && /\/api\/auto(\?.*)?$/.test(r.url()))
        return r.respond({ status: 200, contentType: "application/json", body: JSON.stringify({ ...real, settings }) });
      if (r.method() === "PUT" && /\/api\/auto$/.test(r.url())) {
        const b = JSON.parse(r.postData() || "{}");
        puts.push(b);
        return r.respond({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, ...real, settings }) });
      }
      if (r.method() === "GET" || r.method() === "HEAD") return r.continue();
      return r.respond({ status: 200, contentType: "application/json", body: "{}" });
    });
    await page.goto(BASE + "/?tab=fx_visual", { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".card.compose.autop .phead-tog", { timeout: 30000 });
    await sleep(600);
    if (!(await page.$(".card.compose.autop .phead.open"))) await page.click(".card.compose.autop .phead-tog");
    await sleep(400);
    await page.click(".card.compose.autop .astrip .astext");
    await page.waitForSelector(".sheet.auto:not([hidden]) .ainstr", { timeout: 15000 });
    await page.type(".sheet.auto .ainstr", "calmer, with more space");
    await sleep(300);
    eq(puts.length, 0, "nothing saved while typing");
    await sleep(1300);
    eq(puts.length, 1, "one save once typing paused");
    eq(JSON.stringify(Object.keys(puts[0]).sort()), JSON.stringify(["comment", "for"]), "the comment alone");
    eq(puts[0].comment, "calmer, with more space", "as typed");
    eq(await page.$eval(".sheet.auto .asaved", (x) => x.textContent), "saved", "the sheet says so");
    assert(await page.$$eval(".autofoot .sbtn", (bs) => bs.some((b) => b.textContent === "update")), "update is still there");
    assert(!errs.length, "page errors: " + errs.slice(0, 4).join(" | "));
    log(`typed, paused: one PUT ${JSON.stringify(puts[0])}; "saved"; update still offered`);
  });
}
