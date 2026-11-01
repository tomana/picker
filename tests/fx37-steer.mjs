import { withPage, assert, eq, sleep, showTab, api } from "./lib.mjs";
export const name = "steer — a running job's row opens its sheet at the steer box; the words go to POST /api/queue/<id>/steer and show in its list (intercepted)";

export async function run(log) {
  const card = (await api("/api/cards?type=fx_music")).cards.find((c) => !c.archived);
  const now = Date.now() / 1000;
  const job = { id: "zzsteer1", type: "fx_music", kind: "revise", status: "running", card: card.id, phase: "making",
                created: now - 60, started: now - 50, text: "make it warmer", steers: [{ ts: now - 30, text: "less reverb" }] };
  await withPage(async (page, errs) => {
    const sent = [];
    await page.setViewport({ width: 360, height: 800, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    await page.setRequestInterception(true);
    page.on("request", (r) => {
      const u = new URL(r.url());
      const json = (o) => r.respond({ status: 200, contentType: "application/json", body: JSON.stringify(o) });
      if (u.pathname === "/api/queue" && r.method() === "GET") return json({ queue: [job] });
      if (u.pathname === `/api/queue/${job.id}` && r.method() === "GET") return json(job);
      if (u.pathname === `/api/queue/${job.id}/log`) return json({ lines: ["working"] });
      if (u.pathname === `/api/queue/${job.id}/steer` && r.method() === "POST") {
        const b = JSON.parse(r.postData() || "{}");
        sent.push(b);
        job.steers = [...job.steers, { ts: Date.now() / 1000, text: b.text }];
        return json({ ok: true, job });
      }
      if (r.method() === "GET" || r.method() === "HEAD") return r.continue();
      return r.respond({ status: 200, contentType: "application/json", body: "{}" });
    });
    await showTab(page, "fx_music");
    await page.waitForFunction(() => document.querySelectorAll(".qrow").length >= 1, { timeout: 15000 });
    await sleep(500);
    assert(await page.$$eval(".qrow", (rs) => rs.every((r) => r.scrollWidth <= r.clientWidth + 1)), "the row fits at 360 px");
    await page.evaluate(() => [...document.querySelectorAll(".qrow button.qx")].find((b) => b.title.startsWith("steer")).click());
    await page.waitForSelector(".sheet.job:not([hidden]) .qsteerbox:not([hidden]) textarea", { timeout: 8000 });
    eq(await page.evaluate(() => document.activeElement && document.activeElement.classList.contains("qsteerin")), true,
       "the box has the focus");
    eq(await page.$$eval(".sheet.job .qsteer", (xs) => xs.map((x) => x.lastChild.textContent).join("|")), "less reverb",
       "the steers so far");
    await page.type(".sheet.job .qsteerin", "softer attack on the pads");
    await page.evaluate(() => [...document.querySelectorAll(".sheet.job .qsteerrow .sbtn")][0].click());
    for (let i = 0; i < 30 && !sent.length; i++) await sleep(100);
    eq(JSON.stringify(sent), JSON.stringify([{ text: "softer attack on the pads" }]), "the words sent");
    await sleep(300);
    eq(await page.$$eval(".sheet.job .qsteer", (xs) => xs.map((x) => x.lastChild.textContent).join("|")),
       "less reverb|softer attack on the pads", "and listed");
    eq(await page.$eval(".sheet.job .qsteerin", (t) => t.value), "", "the box emptied");
    assert(!errs.length, "page errors: " + errs.slice(0, 4).join(" | "));
    log(`steered ${JSON.stringify(sent[0])} from the row's button; the sheet lists both steers`);
  });
}
