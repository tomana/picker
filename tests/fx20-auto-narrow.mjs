import { withPage, assert, eq, sleep, api, BASE } from "./lib.mjs";
export const name = "auto on a phone — the sheet never scrolls sideways, an order of long card names wraps (PUT intercepted)";

export async function run(log) {
  const real = await api("/api/auto");
  const long = "engineering__esr_gsfa1_broken_strings_120bpm_with_no_place_to_break_at_all";
  const survey = { type: "fx_visual", running: null, criterion: "the longest names first", ts: Date.now() / 1000 - 60,
    job: "svlong", stale: false, report: "",
    order: [{ card: long, why: "a name without a space in it, longer than the phone is wide", revised: false },
            { card: "flok01", why: "a short one", revised: true }] };
  await withPage(async (page, errs) => {
    await page.setViewport({ width: 384, height: 832, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    await page.setRequestInterception(true);
    page.on("request", (r) => {
      if (r.method() === "GET" && /\/api\/auto(\?.*)?$/.test(r.url()))
        return r.respond({ status: 200, contentType: "application/json",
                           body: JSON.stringify({ ...real, settings: { ...real.settings, on: false }, survey }) });
      if (r.method() === "GET" || r.method() === "HEAD") return r.continue();
      return r.respond({ status: 200, contentType: "application/json", body: "{}" });
    });
    await page.goto(BASE + "/?tab=fx_visual", { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".card.compose.autop .phead-tog", { timeout: 30000 });
    await sleep(600);
    if (!(await page.$(".card.compose.autop .phead.open"))) await page.click(".card.compose.autop .phead-tog");
    await sleep(400);
    await page.click(".card.compose.autop .astrip .astext");
    await page.waitForSelector(".sheet.auto:not([hidden]) .acrit", { timeout: 15000 });
    await page.evaluate(() => document.querySelector(".sheet.auto .asec.k-order .asumt").click());
    await sleep(500);
    const w = await page.evaluate(() => {
      const b = document.querySelector(".sheet.auto .sbody");
      const li = [...b.querySelectorAll(".aolist li")].map((x) => Math.round(x.getBoundingClientRect().height));
      return { sw: b.scrollWidth, cw: b.clientWidth, li };
    });
    assert(w.li.length === 2, `the order's two cards: ${w.li}`);
    eq(w.sw, w.cw, "no sideways scroll with the order open");
    assert(w.li[0] > w.li[1], `the long name wraps onto more lines (${w.li.join(" vs ")} px)`);
    assert(!errs.length, "page errors: " + errs.slice(0, 4).join(" | "));
    log(`384 px: the sheet ${w.cw} px wide, nothing past it; the long name wraps (${w.li[0]} px against ${w.li[1]})`);
  });
}
