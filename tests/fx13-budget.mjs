import { withPage, api, assert, eq, sleep } from "./lib.mjs";

export const name = "fixture — agent mode and session cap save without resetting model or effort";

export async function run(log) {
  const data = await api("/api/agents?cached=1");
  await withPage(async (page, errs) => {
    await page.evaluate((data) => {
      const original = window.fetch.bind(window);
      window.capWrites = [];
      const json = (v) => Promise.resolve(new Response(JSON.stringify(v), { headers: {"Content-Type":"application/json"} }));
      window.fetch = (u, o) => {
        const path = new URL(String(u), location.origin).pathname;
        if (path === "/api/agents") return json({...data, execution_mode: "restricted"});
        if (path === "/api/agents/claude" && o?.method === "PUT") {
          const body = JSON.parse(o.body); window.capWrites.push(body);
          const a = data.agents.find((a) => a.name === "claude");
          return json({ok:true, agent:{...a, choice:{...a.choice, ...body}}});
        }
        return original(u, o);
      };
    }, data);
    await page.waitForSelector('button[title^="agents:"]');
    await sleep(800);
    await page.click('button[title^="agents:"]');
    await page.waitForSelector(".sheet.settings .session-cap");
    assert((await page.$eval(".sheet.settings", (e) => e.textContent)).includes("restricted agents"), "mode is shown below AGENTS");
    const first = await page.$(".sheet.settings .sagent");
    const control = await first.$(".session-cap");
    eq(await control.$$eval("option", (xs) => xs.map((e) => e.value).join()), "100,90,80,70,60,50", "cap options");
    const size = await control.boundingBox();
    assert(size.width > 40 && size.height >= 36, `cap select is usable: ${JSON.stringify(size)}`);
    const a = data.agents.find((a) => a.name === "claude");
    await control.select("80");
    await page.waitForFunction(() => document.querySelector(".sheet.settings .sagent")?.textContent.includes("saved"));
    let writes = await page.evaluate(() => window.capWrites);
    eq(writes[0].session_cap, 80, "cap sent as a percent");
    eq(writes[0].model, a.choice.model, "model kept");
    eq(writes[0].effort, a.choice.effort, "effort kept");
    await page.select(".sheet.settings .sagent .session-cap", "100");
    await page.waitForFunction(() => window.capWrites.length === 2);
    writes = await page.evaluate(() => window.capWrites);
    eq(writes[1].session_cap, 100, "off is 100 percent");
    const unknown = await page.evaluate(async () => {
      const {mapUsage} = await import("/static/app/data.js");
      return mapUsage({sources:{anthropic:{available:false,windows:[],session_cap:80,cap_window:"session",
        cap_note:"session cap: usage unknown; new jobs wait"}}}).usage[0];
    });
    assert(unknown.capUnknown && unknown.caption.includes("usage unknown"), "capped unknown usage has its reason");
    const [w, c] = await page.$eval(".sheet.settings .sbody", (e) => [e.scrollWidth,e.clientWidth]);
    assert(w <= c, "cap control does not widen phone settings");
    eq(errs.length, 0, `page errors: ${errs.join(" | ")}`);
    log("restricted mode visible; cap 80 then off saved with unchanged model/effort; unknown usage explained; no phone overflow");
  });
}
