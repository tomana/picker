import { withPage, api, assert, eq, sleep, BASE } from "./lib.mjs";
export const name = "a type's other method — its own send beside revise on a version with items, a revise by it with the words and ×N; an item's diff above the text; the brief as configured names it";

const BUNDLE = "fx7a8b9c0d1e";                       // the fixture's bundle: items trans and comp1, comp1 the face
const DIFF = 'comp1 from trans\n"warmer"\n\nMOVED\n  band 0 +2.0 dB          a long line, so the block scrolls sideways';
const METHODS = [{ id: "make", label: "make", about: "the default" },
                 { id: "tune", label: "tune", about: "small moves on the item on screen", send: "items" }];

export async function run(log) {
  const types = (await api("/api/types")).types;
  const agent = (types.find((x) => x.type === "fx_music").agents || [])[0];
  const ins = await api(`/api/agents/insight/fx_music?agent=${agent}&kind=revise&card=${BUNDLE}&version=1&item=comp1&method=tune`);
  assert(/a revise by tune of fx_music/.test(ins.brief.text), `the brief as configured names the method: ${ins.brief.text.slice(0, 120)}`);
  const plain = (await api("/api/cards?type=fx_music")).cards.find((c) => !c.archived && !(c.versions || []).some((v) => (v.items || []).length));
  assert(plain, "an fx_music card without items");

  await withPage(async (page, errs) => {
    const sent = [];
    await page.setRequestInterception(true);
    page.on("request", async (r) => {
      const u = new URL(r.url());
      if (r.method() === "POST" && u.pathname === "/api/queue") {
        sent.push(JSON.parse(r.postData() || "{}"));
        return r.respond({ status: 200, contentType: "application/json", body: JSON.stringify({ id: "fx33job", status: "queued" }) });
      }
      if (r.method() !== "GET" && r.method() !== "HEAD")
        return r.respond({ status: 200, contentType: "application/json", body: "{}" });
      // from outside: fx_music declares a default and a second method, and the bundle's comp1 has a diff
      if (u.pathname === "/api/types" || u.pathname.startsWith("/api/cards")) {
        const res = await fetch(BASE + u.pathname + u.search);
        const body = await res.json();
        if (u.pathname === "/api/types") {
          for (const t of body.types || body) if (t.type === "fx_music") Object.assign(t, { methods: METHODS, default_method: "make" });
        } else {
          const walk = (o) => {
            if (Array.isArray(o)) return o.forEach(walk);
            if (!o || typeof o !== "object") return;
            if (o.id === "comp1" && Array.isArray(o.parts)) o.diff = DIFF;
            Object.values(o).forEach(walk);
          };
          walk(body);
        }
        return r.respond({ status: res.status, contentType: "application/json", body: JSON.stringify(body) });
      }
      return r.continue();
    });
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    const open = async (cid) => {
      await page.goto(`${BASE}/?tab=fx_music&card=${cid}`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector(".sheet.big:not([hidden]) .acts", { timeout: 30000 });
    };
    const row = () => page.$$eval(".sheet.big:not([hidden]) .acts > button", (bs) =>
      bs.filter((b) => !b.hidden).map((b) => b.textContent.trim() || b.className));
    const pick = async () => {                       // the agent menu, when there is one: its first model
      await sleep(400);
      if (await page.$(".whopop .whom")) await page.click(".whopop .whom");
      for (let i = 0; i < 40 && sent.length === n0; i++) await sleep(100);
    };
    let n0 = 0;

    await open(BUNDLE);
    const acts = await row();
    eq(JSON.stringify(acts.slice(-4)), JSON.stringify(["inspire", "revise", "tune", "1"]), "tune beside revise, before ×N");
    eq(await page.$eval(".sheet.big .cdesc pre.cddiff", (p) => p.textContent), DIFF, "comp1's diff, above the text");
    const fits = await page.$eval(".sheet.big .cdesc pre.cddiff", (p) => p.scrollWidth > p.clientWidth
      && p.getBoundingClientRect().right <= document.querySelector(".sheet.big .cdesc").getBoundingClientRect().right + 1);
    assert(fits, "the diff scrolls sideways inside the text box, not past it");

    await page.click(".sheet.big .ideabox");
    await page.keyboard.type("warmer");
    await page.click(".sheet.big .acts > button.revn");
    await page.evaluate(() => [...document.querySelectorAll(".revpop .revpi")].find((b) => b.textContent === "3").click());
    n0 = sent.length;
    await page.evaluate(() => [...document.querySelectorAll(".sheet.big .acts > button.way")].find((b) => !b.hidden).click());
    await pick();
    const j = sent.at(-1) || {};
    eq(JSON.stringify([j.type, j.kind, j.card, j.version, j.item, j.method, j.count, j.text]),
       JSON.stringify(["fx_music", "revise", BUNDLE, 1, "comp1", "tune", 3, "warmer"]), "tune sends a revise by tune");

    await open(BUNDLE);
    n0 = sent.length;
    await page.evaluate(() => [...document.querySelectorAll(".sheet.big .acts > button")].find((b) => b.textContent.trim() === "revise").click());
    await pick();
    eq((sent.at(-1) || {}).method, "make", "revise still sends the default");
    await page.evaluate(() => [...document.querySelectorAll(".sheet.big .ithumb")].find((b) => b.textContent.includes("trans")).click());
    await sleep(300);
    eq(await page.$(".sheet.big .cdesc pre.cddiff"), null, "trans has no diff");

    await open(plain.id);
    assert(!(await row()).includes("tune"), `no items, no tune: ${(await row()).join(" ")}`);
    assert(!errs.length, "page errors: " + errs.slice(0, 4).join(" | "));
    log(`tune sent ${JSON.stringify({ method: j.method, count: j.count, item: j.item })}; revise sent the default; the diff showed on comp1 only; ${plain.id} has no tune`);
  });
}
