import { withPage, showTab, api, assert, eq, sleep, BASE } from "./lib.mjs";
export const name = "+ add idea — a seed from your words, on the visual tabs; ✦ gone from the pad";
export async function run(log) {
  await withPage(async (page) => {
    const sent = [];
    await page.setRequestInterception(true);
    page.on("request", (r) => {
      const m = r.method(), path = new URL(r.url()).pathname;
      if (m === "GET" || m === "HEAD") return r.continue();
      if (m === "POST" && path === "/api/queue") {
        sent.push(JSON.parse(r.postData() || "{}"));
        return r.respond({ status: 201, contentType: "application/json",
                           body: JSON.stringify({ id: "zzidea", status: "queued", kind: "seed" }) });
      }
      return r.respond({ status: 200, contentType: "application/json", body: "{}" });
    });
    await showTab(page, "fx_visual");
    await page.waitForSelector(".card.compose.addidea", { timeout: 20000 });
    assert(!(await page.$('.pads button[title^="✦"]')), "no ✦ on the pad any more");
    eq(await page.$eval(".card.compose.addidea .phead-lbl", (x) => x.textContent), "Add idea", "the row says Add idea");
    await page.click(".card.compose.addidea .phead-tog");
    await page.waitForSelector(".sheet.idea:not([hidden]) textarea", { timeout: 8000 });
    eq(await page.$eval(".sheet.idea .shead .t", (x) => x.textContent), "Add idea · visual", "the sheet names the tab");
    await page.click(".sheet.idea .autofoot .sbtn");
    await sleep(300);
    eq(sent.length, 0, "an empty idea isn't sent");
    await page.type(".sheet.idea textarea", "zz a slow tide line rising up the body");
    await page.click(".sheet.idea .autofoot .sbtn");
    await sleep(800);
    eq(JSON.stringify(sent.map((b) => [b.type, b.kind, b.text, (b.card ?? null)])),
       JSON.stringify([["fx_visual", "seed", "zz a slow tide line rising up the body", null]]),
       "make sends a seed of the words, for the tab's type, from no card");
    assert(await page.$eval(".sheet.idea", (x) => x.hidden), "and the sheet shuts");
    log(`visual tab: + Add idea → ${JSON.stringify(sent[0])}`);
    const ideas = ((await api("/api/types")).types || []).filter((x) => (x.capabilities || {}).add === "idea"
                                                                  && x.type !== "fx_visual").map((x) => x.type);
    for (const t of ideas) {
      await showTab(page, t);
      await page.waitForSelector(".card.compose.addidea", { timeout: 20000 });
    }
    log(`and on ${ideas.join(", ")}`);
  }, { writes: false });
}
