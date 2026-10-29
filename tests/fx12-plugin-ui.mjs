import { withPage, assert, eq, sleep, BASE } from "./lib.mjs";

export const name = "fixture — plugin app metadata, missing builds and generic audit colors";

export async function run(log) {
  await withPage(async (page, errs) => {
    const open = async () => {
      await page.click('button[title^="agents:"]');
      await page.waitForSelector(".sheet.settings .sagent", { timeout: 15000 });
    };
    await page.waitForSelector('button[title^="agents:"]', { timeout: 20000 });
    await sleep(800);
    await open();
    assert(!(await page.$eval(".sheet.settings", (e) => e.textContent)).includes("the phone app"),
           "no app row without a serving plugin");
    await page.keyboard.press("Escape");
    await page.evaluate(() => {
      const fetch = window.fetch.bind(window);
      window.fixtureBuild = true;
      const json = (x) => Promise.resolve(new Response(JSON.stringify(x), { headers: { "Content-Type": "application/json" } }));
      window.fetch = (u, o) => {
        const path = new URL(String(u), location.origin).pathname;
        if (path === "/api/plugins") return json({ serves: ["/api/downloads/app"] });
        if (path === "/api/downloads/app") return json({
          app: { id: "demo", name: "Pocket picker", description: "A companion supplied by a plugin.", publish: "apps/publish.sh" },
          apk: window.fixtureBuild ? { name: "demo.apk", url: "/download/demo.apk", version: "1.2", sha: "abc1234",
            size: 1048576, mtime: 1000000, behind: 2, uncommitted: false, dirty_build: false } : null,
        });
        if (path === "/api/cards/fixture/audit") return json({ card: { type: "fx_visual", id: "fixture", label: "a card" },
          jobs: [], logs: [], entries: ["operator", "queue", "card", "worker", "fixture_engine", "constructor"].map((src, i) =>
            ({ ts: i + 1, src, ev: "test", text: "an event" })) });
        return fetch(u, o);
      };
    });
    await open();
    await page.waitForSelector(".sheet.settings a.sdl");
    const text = await page.$eval(".sheet.settings", (e) => e.textContent);
    assert(text.includes("Pocket picker 1.2") && text.includes("apps/publish.sh"), "plugin name and publish instruction shown");
    eq(await page.$eval(".sheet.settings a.sdl", (e) => e.getAttribute("href")), "/download/demo.apk", "plugin download URL");
    assert(await page.$('.sheet.settings [title="A companion supplied by a plugin."]'), "plugin description shown");
    await page.keyboard.press("Escape");
    await page.evaluate(() => { window.fixtureBuild = false; });
    await open();
    await page.waitForFunction(() => document.querySelector(".sheet.settings")?.textContent.includes("no Pocket picker APK published"));
    assert(!(await page.$(".sheet.settings a.sdl")), "missing build has no download");
    assert((await page.$eval(".sheet.settings", (e) => e.textContent)).includes("apps/publish.sh"), "missing build keeps publish instruction");
    await page.keyboard.press("Escape");
    const roles = await page.evaluate(async () => {
      const { mountAudit } = await import("/static/app/parts/audit.js");
      const host = document.createElement("div"); document.body.append(host);
      await mountAudit(host, "fixture");
      const rows = [...host.querySelectorAll(".aline")].map((e) => ({ role: e.className, color: getComputedStyle(e.querySelector(".as")).color }));
      host.remove(); return rows;
    });
    eq(roles.map((r) => r.role).join(), "aline input,aline queue,aline card,aline worker,aline system,aline system", "semantic audit roles");
    eq(roles[3].color, roles[4].color, "unknown project source uses the system color");
    eq(errs.length, 0, `page errors: ${errs.join(" | ")}`);
    log("no plugin: hidden; plugin: name/description/publish/download; no build: publish instruction; audit roles independent of source id");
  });
}
