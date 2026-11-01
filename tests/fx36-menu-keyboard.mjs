import { withPage, assert, eq, sleep, api, BASE } from "./lib.mjs";
export const name = "the agent menu with the keyboard up — it opens above revise, every model in sight between the band and the keyboard";

export async function run(log) {
  // the music tab runs the fixture's fake agent; its menu is given four models from outside, as tall as a real one
  const card = (await api("/api/cards?type=music")).cards.find((c) => !c.archived && (c.origin || {}).kind !== "recording");
  await withPage(async (page, errs) => {
    await page.setViewport({ width: 390, height: 700, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    // the phone's way (shell.html: interactive-widget=overlays-content): the keyboard resizes no viewport, and only
    // the VirtualKeyboard API says where it is. Headless has none: one of the check's own
    await page.evaluateOnNewDocument(() => {
      const vk = Object.assign(new EventTarget(), { overlaysContent: true, boundingRect: new DOMRect(0, 0, 0, 0) });
      Object.defineProperty(navigator, "virtualKeyboard", { value: vk, configurable: true });
      window.__keyboard = (h) => {
        vk.boundingRect = new DOMRect(0, innerHeight - h, innerWidth, h);
        vk.dispatchEvent(new Event("geometrychange"));
      };
    });
    await page.setRequestInterception(true);
    page.on("request", async (r) => {
      const u = new URL(r.url());
      if (r.method() === "GET" && u.pathname === "/api/agents") {
        const body = await (await fetch(BASE + u.pathname + u.search)).json();
        for (const a of body.agents || []) if (a.name === "fake")
          a.menu = ["one", "two", "three", "four"].map((x) => ({ id: `fake-${x}`, label: `model ${x}` }));
        return r.respond({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
      }
      return (r.method() === "GET" || r.method() === "HEAD") ? r.continue()
        : r.respond({ status: 200, contentType: "application/json", body: "{}" });
    });
    await page.goto(`${BASE}/?tab=music&card=${card.id}`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".sheet.big:not([hidden]) .acts", { timeout: 30000 });
    await sleep(800);
    await page.focus(".sheet.big .ideabox");
    // as on the phone: the send row under 320 px down (a short screen does it here), the keyboard just under it
    const k = await page.evaluate(() => {
      const b = document.querySelector(".sheet.big .acts").getBoundingClientRect(), h = Math.round(innerHeight - b.bottom - 30);
      window.__keyboard(h);
      return { h, top: Math.round(b.top) };
    });
    const revise = () => page.evaluate(() => [...document.querySelectorAll(".sheet.big .acts > button")]
      .find((b) => b.textContent.trim() === "revise").click());
    await revise();
    await page.waitForSelector(".whopop .whom", { timeout: 8000 });
    await sleep(300);
    const m = await page.evaluate(() => {
      const pop = document.querySelector(".whopop").getBoundingClientRect();
      const rev = [...document.querySelectorAll(".sheet.big .acts > button")].find((b) => b.textContent.trim() === "revise").getBoundingClientRect();
      const band = document.querySelector(".band"), kb = navigator.virtualKeyboard.boundingRect;
      const ceil = band ? band.getBoundingClientRect().bottom : 0, floor = kb.y;
      const models = [...document.querySelectorAll(".whopop .whom")].map((x) => {
        const r = x.getBoundingClientRect(); return { t: x.textContent.trim(), seen: r.top >= ceil - 1 && r.bottom <= floor + 1 };
      });
      return { above: pop.bottom <= rev.top + 1, top: Math.round(pop.top), ceil: Math.round(ceil), models };
    });
    assert(m.above, `the menu opens above revise: ${JSON.stringify(m)}`);
    assert(m.top >= m.ceil - 1, `and below the band: ${JSON.stringify(m)}`);
    assert(m.models.length >= 4 && m.models.every((x) => x.seen), `every model in sight: ${JSON.stringify(m.models)}`);
    eq(errs.length, 0, `page errors: ${errs.join(" | ")}`);
    log(`send row at ${k.top} px, keyboard ${k.h} px: the menu above revise, ${m.models.map((x) => x.t).join(", ")} in sight`);
  });
}
