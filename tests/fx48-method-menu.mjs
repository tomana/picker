import { withPage, api, assert, eq, sleep, BASE } from "./lib.mjs";
export const name = "a type's methods — a row under the agent menu's head and in Add idea, one choice for both, kept on the device; the type's default first; revise, inspire and ×N send it; its tuning keeps its own button; a type of one way shows no row and sends its default (methods given from outside)";

const METHODS = [{ id: "plain", label: "plain", about: "the default way" },
                 { id: "quick", label: "quick", about: "a faster way" },
                 { id: "tune", label: "tune", about: "small moves on the card", tuning: true }];
const ONE = [{ id: "make", label: "make", about: "the only way" }, { id: "tune", label: "tune", about: "small moves", tuning: true }];
const CARD = "fxvws1";
const SHOTS = process.env.SHOTS;

export async function run(log) {
  const music = (await api("/api/cards?type=fx_music")).cards.find((c) => !c.archived);
  assert(music, "an fx_music card");
  await withPage(async (page, errs) => {
    const sent = [];
    await page.setRequestInterception(true);
    page.on("request", async (r) => {
      const u = new URL(r.url());
      if (r.method() === "POST" && u.pathname === "/api/queue") {
        sent.push(JSON.parse(r.postData() || "{}"));
        return r.respond({ status: 201, contentType: "application/json",
                           body: JSON.stringify({ id: `fx48job${sent.length}`, status: "queued" }) });
      }
      if (r.method() !== "GET" && r.method() !== "HEAD")
        return r.respond({ status: 200, contentType: "application/json", body: "{}" });
      // from outside: the agents installed (the scratch picker's aren't), so a send asks with the agent menu
      if (u.pathname === "/api/agents") {
        const body = await (await fetch(BASE + u.pathname + u.search)).json();
        for (const a of body.agents || []) a.installed = true;
        return r.respond({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
      }
      // from outside: fx_visual has two ways and a tuning, fx_music one way and a tuning
      if (u.pathname === "/api/types") {
        const res = await fetch(BASE + u.pathname + u.search);
        const body = await res.json();
        for (const t of body.types || body) {
          if (t.type === "fx_visual") Object.assign(t, { methods: METHODS, default_method: "plain" });
          if (t.type === "fx_music") Object.assign(t, { methods: ONE, default_method: "make" });
        }
        return r.respond({ status: res.status, contentType: "application/json", body: JSON.stringify(body) });
      }
      return r.continue();
    });
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    const open = async (tab, cid) => {
      await page.goto(`${BASE}/?tab=${tab}&card=${cid}`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector(".sheet.big:not([hidden]) .acts", { timeout: 30000 });
      await sleep(800);                              // settled: a late scroll shuts the agent menu
    };
    const press = (w) => page.evaluate((w) => [...document.querySelectorAll(".sheet.big .acts > button")]
      .find((b) => !b.hidden && (b.textContent.trim() === w || b.classList.contains(w))).click(), w);
    // the row in the agent menu: each way, * on the chosen one; every button whole, inside the menu
    const row = async (sel = ".whopop") => {
      await page.waitForSelector(sel, { timeout: 8000 });
      await sleep(150);
      return page.$eval(sel, (box) => {
        const r = box.getBoundingClientRect();
        return [...box.querySelectorAll(".howrow .howm")].map((b) => {
          const g = b.getBoundingClientRect();
          const whole = g.width > 30 && g.left >= r.left && g.right <= r.right + 0.5 && b.scrollWidth <= b.clientWidth;
          return b.dataset.method + (b.classList.contains("on") ? "*" : "") + (whole ? "" : "(cut)");
        });
      });
    };
    const pick = async () => {
      const n = sent.length;
      await page.click(".whopop .whom");
      for (let i = 0; i < 40 && sent.length === n; i++) await sleep(100);
      eq(sent.length, n + 1, "one send");
      return sent.at(-1);
    };
    const fields = (j) => JSON.stringify([j.kind, j.method ?? null, j.count ?? 1]);

    // revise: the row under the head, the default first; a tap chooses (the menu stays), a model sends it
    await open("fx_visual", CARD);
    await press("revise");
    eq(JSON.stringify(await row()), JSON.stringify(["plain*", "quick"]), "the type's ways, its default on; no tuning");
    await page.click('.whopop .howm[data-method="quick"]');
    eq(JSON.stringify(await row()), JSON.stringify(["plain", "quick*"]), "chosen; the menu stays");
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/method-menu.png` });
    let j = await pick();
    eq(JSON.stringify([j.card, j.kind, j.method]), JSON.stringify([CARD, "revise", "quick"]), "a revise by quick");

    // kept on the device: after a reload, inspire and ×N send it too
    await open("fx_visual", CARD);
    await press("inspire");
    eq(JSON.stringify(await row()), JSON.stringify(["plain", "quick*"]), "after a reload, still quick");
    eq(fields(await pick()), JSON.stringify(["inspire", "quick", 1]), "an inspire by quick");
    await open("fx_visual", CARD);
    await page.$eval(".sheet.big .acts > button.revn", (b) => b.click());   // a click that scrolls would shut the menu
    await page.evaluate(() => [...document.querySelectorAll(".revpop .revpi")].find((b) => b.textContent === "3").click());
    await press("revise");
    await row();
    eq(fields(await pick()), JSON.stringify(["revise", "quick", 3]), "×3 by quick");

    // the tuning: its own button, no row, its own method
    await open("fx_visual", CARD);
    await press("tune");
    eq(JSON.stringify(await row()), "[]", "no row on the tuning's menu");
    eq(fields(await pick()), JSON.stringify(["revise", "tune", 1]), "the tuning sends its method");

    // Add idea: the same choice, changed there, then on the card's next send
    await page.goto(`${BASE}/?tab=fx_visual`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".grid .addidea .phead-tog", { timeout: 30000 });
    await page.$eval(".grid .addidea .phead-tog", (b) => b.click());
    eq(JSON.stringify(await row(".sbody.idea")), JSON.stringify(["plain", "quick*"]), "Add idea: the same choice");
    await page.click('.sbody.idea .howm[data-method="plain"]');
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/method-idea.png` });
    await page.type(".sbody.idea textarea", "a new idea");
    let n = sent.length;
    await page.evaluate(() => [...document.querySelectorAll(".ifoot button")].find((b) => b.textContent.trim() === "make").click());
    for (let i = 0; i < 40 && sent.length === n; i++) await sleep(100);
    j = sent.at(-1);
    eq(JSON.stringify([j.type, j.kind, j.method, j.text]), JSON.stringify(["fx_visual", "seed", "plain", "a new idea"]),
       "a seed by plain");
    await open("fx_visual", CARD);
    await press("revise");
    eq(JSON.stringify(await row()), JSON.stringify(["plain*", "quick"]), "the card's send: Add idea's choice");
    eq(fields(await pick()), JSON.stringify(["revise", "plain", 1]), "a revise by plain");

    // a type of one way (and a tuning): no row; its default sent, by the card and by Add idea
    await open("fx_music", music.id);
    await press("revise");
    eq(JSON.stringify(await row()), "[]", "one way: no row");
    eq(fields(await pick()), JSON.stringify(["revise", "make", 1]), "its default sent");
    await page.goto(`${BASE}/?tab=fx_music`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".grid .addidea .phead-tog", { timeout: 30000 });
    await page.$eval(".grid .addidea .phead-tog", (b) => b.click());
    await page.waitForSelector(".sbody.idea textarea");
    eq(await page.$(".sbody.idea .howrow"), null, "one way: no row in Add idea");
    await page.type(".sbody.idea textarea", "another");
    n = sent.length;
    await page.evaluate(() => [...document.querySelectorAll(".ifoot button")].find((b) => b.textContent.trim() === "make").click());
    for (let i = 0; i < 40 && sent.length === n; i++) await sleep(100);
    eq(fields(sent.at(-1)), JSON.stringify(["seed", "make", 1]), "a seed by its default");
    assert(!errs.length, "page errors: " + errs.slice(0, 4).join(" | "));
    log(`fx_visual: plain/quick under the agent menu and in Add idea, one choice kept over reloads; revise, inspire, ×3, seed sent it; tune its own; fx_music (one way): no row, make sent`);
  });
}
