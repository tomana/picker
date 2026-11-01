import { withPage, assert, eq, sleep, showTab, api } from "./lib.mjs";
const SHOTS = process.env.SHOTS;
export const name = "stopping AUTO with a job open — its job's sheet and AUTO's sheet: stop after this card turns AUTO off and leaves the job, stop now cancels it too (PUT intercepted)";

export async function run(log) {
  const real = await api("/api/auto");
  const card = (await api("/api/cards?type=fx_music")).cards.find((c) => !c.archived);
  const now = Date.now() / 1000;
  const jobs = [
    { id: "zzlast1", type: "fx_music", kind: "revise", group: "auto", status: "running", card: card.id, phase: "making",
      created: now - 60, started: now - 50 },
    { id: "zzlast2", type: "fx_music", kind: "revise", status: "running", card: card.id, text: "by hand",
      created: now - 40, started: now - 30 },
  ];
  let settings = { ...real.settings, on: true, types: ["fx_music", "fx_visual"] };
  await withPage(async (page, errs) => {
    const puts = [], other = [];
    await page.setViewport({ width: 360, height: 800, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    await page.setRequestInterception(true);
    page.on("request", (r) => {
      const u = new URL(r.url());
      if (u.pathname === "/api/queue" && r.method() === "GET")
        return r.respond({ status: 200, contentType: "application/json", body: JSON.stringify({ queue: jobs }) });
      const one = jobs.find((j) => u.pathname === `/api/queue/${j.id}`);
      if (one && r.method() === "GET")
        return r.respond({ status: 200, contentType: "application/json", body: JSON.stringify(one) });
      if (/^\/api\/queue\/[^/]+\/log$/.test(u.pathname))
        return r.respond({ status: 200, contentType: "application/json", body: JSON.stringify({ lines: ["working"] }) });
      if (u.pathname === "/api/auto" && r.method() === "GET")
        return r.respond({ status: 200, contentType: "application/json", body: JSON.stringify({ ...real, settings }) });
      if (u.pathname === "/api/auto" && r.method() === "PUT") {
        const b = JSON.parse(r.postData() || "{}");
        puts.push(b);
        settings = { ...settings, on: b.on, types: b.types };
        return r.respond({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, ...real, settings }) });
      }
      if (r.method() === "GET" || r.method() === "HEAD") return r.continue();
      other.push(`${r.method()} ${u.pathname}`);
      return r.respond({ status: 200, contentType: "application/json", body: "{}" });
    });
    await showTab(page, "fx_code");                   // a tab with no AUTO panel: AUTO's state comes with the page
    await page.waitForFunction(() => document.querySelectorAll(".qrow").length >= 2, { timeout: 15000 });
    await sleep(800);
    eq(await page.$$eval(".qrow button", (bs) => bs.length), 0, "the rows have no buttons: they are in what a row opens");
    // a row opens its job's sheet; its buttons
    const open = async (re) => {
      await page.evaluate(() => document.querySelectorAll(".sheet.job .shead button").forEach((b) => /close|✕/.test(b.title + b.textContent) && b.click()));
      await page.evaluate((re) => [...document.querySelectorAll(".qrow")].find((r) => new RegExp(re).test(r.textContent)).click(), re);
      await page.waitForSelector(".sheet.job:not([hidden]) .qjacts .sbtn", { timeout: 8000 });
      await sleep(300);
      return page.$$eval(".sheet.job .qjacts .sbtn", (bs) => bs.map((b) => b.textContent.trim()));
    };
    eq(JSON.stringify(await open("by hand")), JSON.stringify(["pause", "cancel"]), "a job sent by hand: pause and cancel");
    eq(JSON.stringify(await open("AUTO")), JSON.stringify(["pause", "cancel", "stop AUTO after this"]),
       "AUTO's job: and stop AUTO after this");
    const fits = await page.$$eval(".sheet.job .qjacts .sbtn", (bs) => bs.every((b) => b.scrollWidth <= b.clientWidth + 1));
    assert(fits, "the buttons fit at 360 px");
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/job-sheet.png` });
    await page.evaluate(() => [...document.querySelectorAll(".sheet.job .qjacts .sbtn")].find((b) => b.textContent.trim() === "stop AUTO after this").click());
    for (let i = 0; i < 30 && !puts.length; i++) await sleep(100);
    eq(JSON.stringify([puts[0]?.on, puts[0]?.types]), JSON.stringify([true, ["fx_visual"]]), "fx_music's AUTO off, the other tab's left on");
    await sleep(800);
    assert(!other.some((x) => /cancel|pause|DELETE/.test(x)), `the job wasn't cancelled or paused: ${other.join(", ")}`);
    eq(JSON.stringify(await page.$$eval(".sheet.job .qjacts .sbtn", (bs) => bs.map((b) => b.textContent.trim()))),
       JSON.stringify(["pause", "cancel"]), "AUTO off: stop AUTO after this is gone, the job still there");

    // the AUTO sheet, from the AUTO job's sheet (AUTO ›): stop now, or stop after this card
    const sheet = async () => {
      settings = { ...settings, on: true, types: ["fx_music", "fx_visual"] };
      await showTab(page, "fx_music");
      await page.waitForFunction(() => document.querySelectorAll(".qrow").length >= 2, { timeout: 15000 });
      await sleep(600);
      await page.evaluate(() => [...document.querySelectorAll(".qrow")].find((r) => /AUTO/.test(r.textContent)).click());
      await page.waitForSelector(".sheet.job:not([hidden]) .qjauto", { timeout: 8000 });
      await page.click(".sheet.job .qjauto");
      await page.waitForFunction(() => document.querySelectorAll(".sheet.auto:not([hidden]) .autofoot .sbtn").length >= 3,
                                 { timeout: 15000 });
      return page.$$eval(".sheet.auto .autofoot .sbtn", (bs) => bs.map((b) => b.textContent.trim()));
    };
    const press = (t) => page.evaluate((t) => [...document.querySelectorAll(".sheet.auto .autofoot .sbtn")]
      .find((b) => b.textContent.trim() === t).click(), t);
    eq(JSON.stringify(await sheet()), JSON.stringify(["stop now", "after this card", "update"]), "two stops while a job is open");
    const tall = await page.$$eval(".sheet.auto .autofoot .sbtn", (bs) => bs.every((b) => b.scrollWidth <= b.clientWidth + 1));
    assert(tall, "the three fit at 360 px");
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/auto-stops.png` });
    eq(JSON.stringify(await page.evaluate(() => [!!document.querySelector(".sheet.auto .akindrow > .seesb:first-child"),
                                                 !!document.querySelector(".sheet.auto .autofoot .seesb")])),
       JSON.stringify([true, false]), "the ⓘ leads the kinds' row, not the foot");
    other.length = 0;
    await press("after this card");
    for (let i = 0; i < 30 && puts.length < 2; i++) await sleep(100);
    await sleep(500);
    eq(JSON.stringify([puts[1]?.on, puts[1]?.types]), JSON.stringify([true, ["fx_visual"]]), "after this card: AUTO off");
    assert(!other.some((x) => /DELETE|cancel|pause/.test(x)), `after this card cancels nothing: ${other.join(", ")}`);
    await sheet();
    await press("stop now");
    for (let i = 0; i < 30 && !other.some((x) => x.startsWith("DELETE")); i++) await sleep(100);
    eq(JSON.stringify([puts[2]?.on, puts[2]?.types]), JSON.stringify([true, ["fx_visual"]]), "now: AUTO off");
    eq(other.filter((x) => x.startsWith("DELETE")).join(), "DELETE /api/queue/zzlast1", "now: the AUTO job cancelled, the other left");
    assert(!errs.length, "page errors: " + errs.slice(0, 4).join(" | "));
    log(`■ sent ${JSON.stringify(puts[0])}; nothing cancelled; the ■ went with AUTO; the sheet's stop after this card cancelled nothing, stop now cancelled zzlast1`);
  });
}
