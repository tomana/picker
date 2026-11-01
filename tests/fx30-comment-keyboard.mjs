import { withPage, assert, sleep, BASE } from "./lib.mjs";
export const name = "AUTO's comment with the keyboard up — it grows only to what the keyboard leaves, then scrolls inside: the line typed stays in sight";

export async function run(log) {
  await withPage(async (page, errs) => {
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    // headless has no keyboard: a visual viewport of the check's own, that a keyboard shortens
    await page.evaluateOnNewDocument(() => {
      const vv = new EventTarget();
      Object.assign(vv, { offsetTop: 0, offsetLeft: 0, scale: 1, width: 390 });
      vv.height = innerHeight;
      Object.defineProperty(window, "visualViewport", { value: vv, configurable: true });
      window.__keyboard = (h) => { vv.height = innerHeight - h; vv.dispatchEvent(new Event("resize")); };
    });
    await page.setRequestInterception(true);
    page.on("request", (r) => (r.method() === "GET" || r.method() === "HEAD") ? r.continue()
      : r.respond({ status: 200, contentType: "application/json", body: "{}" }));
    await page.goto(BASE + "/?tab=fx_visual", { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".card.compose.autop .phead-tog", { timeout: 30000 });
    await sleep(600);
    if (!(await page.$(".card.compose.autop .phead.open"))) await page.click(".card.compose.autop .phead-tog");
    await sleep(400);
    await page.click(".card.compose.autop .astrip .astext");
    await page.waitForSelector(".sheet.auto:not([hidden]) .ainstr", { timeout: 15000 });
    await page.focus(".sheet.auto .ainstr");
    await page.evaluate(() => window.__keyboard(420));
    const long = "a long direction for the agent, line after line, so the box would grow past the keyboard. ".repeat(8);
    await page.type(".sheet.auto .ainstr", long, { delay: 0 });
    await sleep(300);
    const st = await page.evaluate(() => {
      const t = document.querySelector(".sheet.auto .ainstr"), r = t.getBoundingClientRect(), vv = window.visualViewport;
      return { bottom: Math.round(r.bottom), seen: Math.round(vv.offsetTop + vv.height), h: Math.round(r.height),
               scrolls: t.scrollHeight > t.clientHeight + 1, atEnd: t.scrollHeight - t.scrollTop - t.clientHeight < 4 };
    });
    assert(st.bottom <= st.seen, `the box reaches under the keyboard: ${JSON.stringify(st)}`);
    assert(st.scrolls && st.atEnd, `the box scrolls inside, at the line typed: ${JSON.stringify(st)}`);
    await page.evaluate(() => window.__keyboard(0));
    await sleep(200);
    const open = await page.$eval(".sheet.auto .ainstr", (t) => Math.round(t.getBoundingClientRect().height));
    assert(open > st.h, `with the keyboard down it grows again: ${open} vs ${st.h}`);
    assert(!errs.length, "page errors: " + errs.slice(0, 4).join(" | "));
    log(`keyboard up: the box ${st.h} px, ending at ${st.bottom} of ${st.seen} visible, scrolled to the line typed; keyboard down: ${open} px`);
  });
}
