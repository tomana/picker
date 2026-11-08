import { withPage, assert, eq, sleep, showTab } from "./lib.mjs";
const SHOTS = process.env.SHOTS;
export const name = "the open card's picture, full screen and on a phone on its side — over the band, turned a quarter when held upright, its views swiped along it, back and Escape leave it before the card; on its side the picture is the screen under the band, the rest scrolls under it, the ✕ beside";

const VIEWS = "fxvws1";
// a band of the check's own (the fixture's config has none), as a config's band.js makes
const BAND = `(() => {
  const css = document.createElement("style");
  css.textContent = ":root { --band:44px } .band { position:sticky; top:0; z-index:95; height:44px; background:#1c1c1c }";
  document.head.append(css);
})();`;

export async function run(log) {
  await withPage(async (page, errs) => {
    const phone = (w, h) => page.setViewport({ width: w, height: h, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
                                               isLandscape: w > h });
    await phone(412, 900);
    await page.setRequestInterception(true);
    page.on("request", (r) => {
      if (new URL(r.url()).pathname === "/static/band.js") return r.respond({ status: 200, contentType: "text/javascript", body: BAND });
      if (r.method() === "GET" || r.method() === "HEAD") return r.continue();
      return r.respond({ status: 200, contentType: "application/json", body: "{}" });
    });
    await showTab(page, "fx_visual");
    const open = async () => {
      await page.evaluate((id) => { const a = document.querySelector(`.grid article.card[data-cid="${id}"]`);
        a.scrollIntoView({ block: "center" }); a.querySelector(".media").click(); }, VIEWS);
      await page.waitForSelector(".sheet.big:not([hidden]) .cmedia .pfull", { timeout: 10000 });
      await sleep(300);
    };
    const look = () => page.evaluate(() => {
      const sh = document.querySelector(".sheet.big"), b = sh.querySelector(".cmedia"), m = b && b.querySelector(".media");
      const r = (e) => { const g = e.getBoundingClientRect(); return [g.left, g.top, g.width, g.height].map(Math.round); };
      const x = document.querySelector('.scrim[data-kind="big"] .scrimx');
      return { open: !sh.hidden, full: !!b && b.classList.contains("full"), box: b ? r(b) : null, pic: m ? r(m) : null,
               sheet: r(sh), scroll: [sh.scrollHeight, sh.clientHeight, sh.scrollWidth, sh.clientWidth],
               over: !!b && b.contains(document.elementFromPoint(innerWidth / 2, 10)),
               view: [...sh.querySelectorAll(".vthumb")].findIndex((t) => t.classList.contains("on")),
               x: x && !x.hidden ? r(x) : null, size: [innerWidth, innerHeight] };
    });
    const until = async (what, fn) => {
      for (let i = 0; i < 40; i++) { const s = await look(); if (fn(s)) return s; await sleep(100); }
      throw new Error(`${what}: ${JSON.stringify(await look())}`);
    };
    const full = () => page.$eval(".sheet.big .pfull", (b) => b.click());
    const swipe = async (x0, y0, x1, y1) => {
      await page.touchscreen.touchStart(x0, y0);
      for (let i = 1; i <= 6; i++) await page.touchscreen.touchMove(x0 + (x1 - x0) * i / 6, y0 + (y1 - y0) * i / 6);
      await page.touchscreen.touchEnd();
    };

    // upright: over everything, the band too; the wide picture turned a quarter, the length of the screen
    await open();
    let s = await look();
    assert(!s.full && s.x, `the card as it was, its ✕ under it: ${JSON.stringify(s)}`);
    eq(s.scroll[0], s.scroll[1], "upright the card doesn't scroll");
    await full();
    s = await until("full screen", (s) => s.full);
    eq(JSON.stringify(s.box), "[0,0,412,900]", "the whole screen");
    eq(JSON.stringify(s.pic), "[0,0,412,900]", "the wide picture turned, the length of the screen");
    assert(s.over, "over the band");
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/full-upright.png` });

    // its views swiped along the turned picture (down the screen), still full; across the screen is nothing
    const v0 = s.view;
    await swipe(206, 300, 206, 650);
    s = await until("the view before", (s) => s.view === v0 - 1);
    assert(s.full, "still full");
    await swipe(80, 450, 330, 450);
    await sleep(300);
    eq((await look()).view, v0 - 1, "a swipe across the turned picture moves nothing");
    await swipe(206, 650, 206, 300);
    await until("and back", (s) => s.view === v0 && s.full);

    // back leaves the full screen and the card stays; back again closes the card; Escape as back
    await page.evaluate(() => history.back());
    s = await until("back: out of full screen", (s) => !s.full);
    assert(s.open, "the card stays open");
    await page.evaluate(() => history.back());
    await until("back again: the card closes", (s) => !s.open);
    await open();
    await full();
    await until("full", (s) => s.full);
    await page.keyboard.press("Escape");
    s = await until("Escape: out of full screen", (s) => !s.full);
    assert(s.open, "the card stays open");

    // on its side, full: not turned, the whole screen
    await full();
    await phone(900, 412);
    s = await until("on its side, full", (s) => s.size[0] === 900 && s.full);
    eq(JSON.stringify([s.box, s.pic]), "[[0,0,900,412],[0,0,900,412]]", "the picture, not turned, the whole screen");
    await full();

    // on its side: the picture is the screen under the band, a strip of the rest under it; the card scrolls to the rest;
    // the ✕ in the strip beside, which closes it
    s = await until("the card on its side", (s) => !s.full);
    eq(JSON.stringify(s.sheet.slice(0, 2)), "[0,44]", "under the band, from the left");
    eq(s.sheet[1] + s.sheet[3], 412, "down to the foot of the screen");
    eq(s.box[3], 412 - 44 - 40, "the picture: the screen under the band, but for a strip");
    assert(s.scroll[0] > s.scroll[1] + 100, `the card scrolls: ${s.scroll}`);
    assert(s.scroll[2] <= s.scroll[3], `never sideways: ${s.scroll}`);
    assert(s.x && s.x[0] >= s.sheet[0] + s.sheet[2], `its ✕ beside it: ${JSON.stringify(s)}`);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/side.png` });
    await page.$eval(".sheet.big", (sh) => { sh.scrollTop = sh.scrollHeight; });
    await sleep(200);
    const votes = await page.$eval(".sheet.big .cfoot", (f) => { const r = f.getBoundingClientRect();
      return [Math.round(r.top), Math.round(r.bottom), f.contains(document.elementFromPoint(r.left + r.width - 20, r.top + r.height / 2))]; });
    assert(votes[0] >= 44 && votes[1] <= 412 && votes[2], `scrolled down, the votes in reach: ${votes}`);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/side-scrolled.png` });
    await page.touchscreen.tap(s.x[0] + s.x[2] / 2, 206);
    await until("the ✕ beside closes it", (s) => !s.open);

    // and upright again, the card as it was
    await phone(412, 900);
    await sleep(300);
    await open();
    s = await look();
    assert(!s.full && s.x && s.scroll[0] === s.scroll[1] && s.sheet[2] < 412, `upright again, as it was: ${JSON.stringify(s)}`);
    assert(!errs.length, "page errors: " + errs.slice(0, 4).join(" | "));
    log(`${VIEWS}: full screen upright (turned, ${s.size.join("×")}) and on its side; views swiped along it; back and Escape left it first; on its side the picture ${412 - 84} px under the band, the card scrolled to its votes, the ✕ beside closed it`);
  });
}
