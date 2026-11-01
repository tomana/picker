import { withPage, assert, eq, sleep, api, BASE } from "./lib.mjs";
export const name = "AUTO's kinds — revise, inspire and the tab's tuning, each on or off (never none), the ones on sent together (PUT intercepted)";

export async function run(log) {
  const real = await api("/api/auto");
  await withPage(async (page, errs) => {
    const settings = { ...real.settings, on: true, types: [...new Set([...(real.settings.types || []), "fx_music"])],
                       tabs: { ...(real.settings.tabs || {}), fx_music: { kinds: ["revise"], keep: false, comment: "",
                                                                         criterion: "", since: 0 } } };
    const puts = [];
    await page.setRequestInterception(true);
    page.on("request", async (r) => {
      const u = new URL(r.url());
      if (r.method() === "GET" && u.pathname === "/api/auto")
        return r.respond({ status: 200, contentType: "application/json", body: JSON.stringify({ ...real, settings }) });
      if (r.method() === "PUT" && u.pathname === "/api/auto") {
        puts.push(JSON.parse(r.postData() || "{}"));
        return r.respond({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, ...real, settings }) });
      }
      if (r.method() === "GET" && u.pathname === "/api/types") {     // from outside: fx_music has a tuning
        const body = await (await fetch(BASE + u.pathname + u.search)).json();
        for (const t of body.types || body) if (t.type === "fx_music")
          Object.assign(t, { methods: [{ id: "make", label: "make" }, { id: "tune", label: "tune up", tuning: true }],
                             default_method: "make" });
        return r.respond({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
      }
      if (r.method() === "GET" || r.method() === "HEAD") return r.continue();
      return r.respond({ status: 200, contentType: "application/json", body: "{}" });
    });
    await page.goto(BASE + "/?tab=fx_music", { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".card.compose.autop .phead-tog", { timeout: 30000 });
    await sleep(600);
    if (!(await page.$(".card.compose.autop .phead.open"))) await page.click(".card.compose.autop .phead-tog");
    await sleep(400);
    await page.click(".card.compose.autop .astrip .astext");
    await page.waitForSelector(".sheet.auto:not([hidden]) .akind", { timeout: 15000 });
    const kinds = () => page.$$eval(".sheet.auto .akind", (bs) => bs.map((b) => (b.classList.contains("on") ? "+" : "-") + b.textContent));
    const tap = (t) => page.evaluate((t) => [...document.querySelectorAll(".sheet.auto .akind")].find((b) => b.textContent === t).click(), t);
    eq((await kinds()).join(" "), "+revise -inspire -tune up", "three kinds, the tuning by its label; revise on");
    await tap("tune up");
    eq((await kinds()).join(" "), "+revise -inspire +tune up", "a second one on");
    await tap("revise");
    eq((await kinds()).join(" "), "-revise -inspire +tune up", "one off");
    await tap("tune up");
    eq((await kinds()).join(" "), "-revise -inspire +tune up", "the last one on stays on");
    await tap("inspire");
    await page.evaluate(() => [...document.querySelectorAll(".autofoot .sbtn")].find((b) => b.textContent === "update").click());
    for (let i = 0; i < 30 && !puts.some((p) => p.kinds); i++) await sleep(100);
    const p = puts.find((x) => x.kinds) || {};
    eq(JSON.stringify([p.for, p.kinds]), JSON.stringify(["fx_music", ["inspire", "tune"]]), "update sends the ones on, by id");
    assert(!errs.length, "page errors: " + errs.slice(0, 4).join(" | "));
    log(`kinds toggled; update sent ${JSON.stringify(p.kinds)}`);
  });
}
