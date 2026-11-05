import { withPage, assert, eq, sleep, showTab } from "./lib.mjs";
export const name = "the band under a sheet — dimmed, its links resting; a tap on it closes the top sheet";

// a band of the check's own (the fixture's config has none): a sticky strip with a link, as a config's band.js makes
const BAND = `(() => {
  const css = document.createElement("style");
  css.textContent = ":root { --band:44px } .band { position:sticky; top:0; z-index:95; height:44px; display:flex; " +
    "justify-content:flex-end; align-items:center; background:#1c1c1c } .band a { width:28px; height:30px; display:block }";
  document.head.append(css);
  const b = document.querySelector(".band");
  b.innerHTML = '<a href="/elsewhere" class="away">x</a>';
})();`;

export async function run(log) {
  await withPage(async (page, errs) => {
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    await page.setRequestInterception(true);
    page.on("request", (r) => {
      const u = new URL(r.url());
      if (u.pathname === "/static/band.js") return r.respond({ status: 200, contentType: "text/javascript", body: BAND });
      if (/\.scd(\?|$)/.test(u.pathname)) return r.respond({ status: 200, contentType: "text/plain", body: "SinOsc.ar(440);\n" });
      if (r.method() === "GET" || r.method() === "HEAD") return r.continue();
      return r.respond({ status: 200, contentType: "application/json", body: "{}" });
    });
    await showTab(page, "fx_music");
    const open = () => page.evaluate(() => { const a = document.querySelector('.grid article.card[data-cid="fx0a1b2c3d4e"]');
      a.scrollIntoView({ block: "center" }); (a.querySelector(".media, .vblock") || a).click(); });
    const btn = ".sheet.big .np-strip";
    await open();
    await page.waitForSelector(btn, { timeout: 10000 });
    await page.$eval(btn, (s) => s.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })));
    await page.$eval(".np-mi[data-act='code']", (b) => b.click());
    await page.waitForSelector(".sheet.code:not([hidden]) .codebody", { timeout: 8000 });
    const link = await page.$eval(".band a.away", (a) => { const r = a.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
    const state = () => page.evaluate(() => ({ code: document.querySelector(".sheet.code").hidden, card: document.querySelector(".sheet.big").hidden,
      dim: document.querySelector(".band").classList.contains("undersheet"), at: location.pathname }));
    eq((await state()).dim, true, "the band is dimmed under the code sheet");
    await page.touchscreen.tap(link.x, link.y);
    await sleep(300);
    let st = await state();
    assert(st.code && !st.card && st.at === "/", `a tap on the band's link shut the code only, nowhere else: ${JSON.stringify(st)}`);
    await page.touchscreen.tap(60, 20);
    await sleep(300);
    st = await state();
    assert(st.card && !st.dim && st.at === "/", `a second tap on the band shut the card, and the band woke: ${JSON.stringify(st)}`);
    assert(!errs.length, "page errors: " + errs.slice(0, 4).join(" | "));
    log("under the code sheet the band dims; a tap on its link shuts the code (no navigation), the next the card; then it wakes");
  });
}
