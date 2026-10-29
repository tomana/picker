import { withPage, api, assert, eq, sleep, BASE, scratchPicker } from "./lib.mjs";
export const name = "settings — agents, wiring check, insight";
let sp = null;
const post = (path, body, method = "POST") => sp.call(path, { method, body });
export async function run(log) {
  sp = await scratchPicker();
  try { await check(log); } finally { sp.done(); sp = null; }
}
async function check(log) {
  const bad = await post("/api/agents/codex", { model: "gpt-nope-1" }, "PUT");
  eq(bad.status, 400, "an unknown codex model was accepted");
  const eff = await post("/api/agents/claude", { model: "opus", effort: "ultra" }, "PUT");
  eq(eff.status, 400, "claude accepted an effort it does not have");
  const side = await post("/api/prefs", { agents: { codex: { model: "x" } } }, "PATCH");
  eq(side.status, 400, "PATCH /api/prefs wrote `agents` around its validation");
  const { types } = await api("/api/types");
  const ping = await post("/api/queue", { type: types[0].type, kind: "ping" });
  eq(ping.status, 400, "a ping was accepted into the real queue");
  const before = (await sp.call("/api/agents")).json.agents.find((a) => a.name === "claude").choice;
  await withPage(async (page, errs) => {
    await sp.route(page, (path) => path === "/api/prefs" || path.startsWith("/api/agents"));
    await page.evaluate(() => {
      const real = window.fetch;
      const rows = (st) => [
        { id: "p1", type: "fx_visual", agent: "claude", status: st[0], seconds: 4.2,
          phase: null, why: null, stages: ["fixture runner up", "brief builds · 2k chars",
                                           "asking claude · opus", "READY · claude · opus · 4s"] },
        { id: "p2", type: "fx_visual", agent: "codex", status: st[1], seconds: 3,
          state: st[1] === "failed" ? "limited" : st[1],
          issue: st[1] === "failed" ? { level: "limited", short: "until 14:01",
            detail: "You've hit your usage limit", fix: "resets 14:01" } : null,
          why: "AgentLimited: codex is out of usage until 14:01: You've hit your usage limit",
          stages: [] },
        { id: "p3", type: "fx_visual", agent: "antigravity", status: st[1], seconds: 3,
          state: st[1] === "failed" ? "failed" : st[1],
          issue: st[1] === "failed" ? { level: "failed", short: "model refused",
            detail: "antigravity exited 1: unknown model", fix: "choose another model above" } : null,
          type_issues: [{ level: "warn", short: "render runner running", detail: "pid 1",
                          fix: "close render runner" }],
          why: "AgentFailed: antigravity exited 1: unknown model", stages: [] },
      ];
      const issues = (st) => st[1] !== "failed" ? [] : [
        { level: "failed", title: "antigravity · model refused", short: "model refused",
          detail: "unknown model", fix: "choose another model above",
          where: ["fx_visual · antigravity"] },
        { level: "limited", title: "codex · until 14:01", short: "until 14:01",
          detail: "usage limit", fix: "resets 14:01", where: ["fx_visual · codex"] },
        { level: "warn", title: "render runner running", short: "render runner running",
          detail: "pid 1", fix: "close render runner", where: ["fx_visual"] }];
      let n = 0;
      window.fetch = (u, o) => {
        const s = String(u);
        const ok = (b) => Promise.resolve(new Response(JSON.stringify(b),
          { status: 200, headers: { "Content-Type": "application/json" } }));
        if (s.endsWith("/api/agents/check") && o && o.method === "POST")
          return ok({ group: "wiring-t", runners: { fx_visual: "started, pings only" },
                      rows: rows(["queued", "queued"]) });
        if (s.endsWith("/api/agents/check/wiring-t"))
          { const st = ++n > 1 ? ["done", "failed"] : ["running", "queued"];
            return ok({ group: "wiring-t", done: n > 1, rows: rows(st), issues: issues(st) }); }
        if (s.endsWith("/api/agents/check"))
          return ok({ group: null, rows: [], done: true, issues: [{level:"warn", title:"OPENAI_API_KEY is set",
            short:"OPENAI_API_KEY is set", detail:"This variable is removed from agent and check environments.",
            fix:"Remove OPENAI_API_KEY; use the CLI's subscription login.", where:["picker environment"]}] });
        return real(u, o);
      };
    });
    await page.waitForSelector('button[title^="agents:"]', { timeout: 20000 });
    await sleep(800);
    await page.click('button[title^="agents:"]');
    await page.waitForSelector(".sheet.settings .sagent", { timeout: 15000 });
    const names = await page.$$eval(".sheet.settings .sagname b", (b) => b.map((x) => x.textContent));
    assert(names.includes("claude") && names.includes("codex") && names.includes("antigravity"),
           `agents listed: ${names}`);
    assert(!(await page.$eval(".sheet.settings", (s) => s.innerText)).includes("null"),
           "a null child was drawn as the word null");
    log(`agents: ${names.join(", ")}`);
    const policy = await page.$eval(".sheet.settings", (s) => s.innerText);
    assert(policy.includes("Subscription logins only") && policy.includes("API keys/pay-per-use are unsupported"),
           "settings does not explain subscription-only usage");
    await page.waitForSelector(".swiss.warn");
    assert((await page.$eval(".swiss.warn", (e) => e.innerText)).includes("OPENAI_API_KEY is set"),
           "an environment warning is hidden before the first wiring check");
    log("subscription-only policy visible; the wiring warning names OPENAI_API_KEY before any check");
    const [sw, cw] = await page.$eval(".sheet.settings .sbody", (b) => [b.scrollWidth, b.clientWidth]);
    assert(sw <= cw, `⚙ is ${sw - cw}px wider than its frame`);
    const claude = await page.$$(".sheet.settings .sagent");
    const sel = await claude[0].$$("select");
    await sel[1].select("low");
    await page.waitForFunction(() => /saved/.test(
      document.querySelector(".sheet.settings .sagent").innerText), { timeout: 8000 });
    const after = (await sp.call("/api/agents")).json.agents.find((a) => a.name === "claude").choice;
    eq(after.effort, "low", "the effort did not reach the server");
    log(`claude effort ${before.effort || "default"} → low, saved (in the scratch picker)`);
    await page.evaluate(() => [...document.querySelectorAll(".sheet.settings .sbtn")]
      .find((b) => b.textContent === "check all").click());
    await page.waitForFunction(() => document.querySelectorAll(".swcell.ok").length === 1
      && document.querySelectorAll(".swcell.limited").length === 1
      && document.querySelectorAll(".swcell.failed").length === 1, { timeout: 8000 });
    const lim = await page.$eval(".swcell.limited", (c) => [c.innerText, getComputedStyle(c).color]);
    assert(/until 14:01/.test(lim[0]), `the limited cell does not say until when: ${lim[0]}`);
    const red = await page.$eval(".swcell.failed", (c) => getComputedStyle(c).color);
    assert(lim[1] !== red, "limited and failed are the same colour");
    const red_t = await page.$eval(".swcell.failed", (c) => c.innerText);
    assert(/model refused/.test(red_t), `the red cell does not name its cause: ${red_t}`);
    const list = await page.$$eval(".swiss", (x) => x.map((e) => e.innerText));
    eq(list.length, 3, "the issue list");
    assert(/→ choose another model above/.test(list[0]), `no fix line: ${list[0]}`);
    assert(/render runner running/.test(await page.$eval(".swtype.warned", (e) => e.innerText)),
           "the type-wide condition is not on the type");
    await page.click(".swcell.limited");
    const why = await page.$eval(".swdetail", (d) => d.innerText);
    assert(/usage limit/.test(why), `the limited cell does not say why: ${why}`);
    const btn = await page.evaluate(() => [...document.querySelectorAll(".sheet.settings .sbtn")]
      .map((b) => b.textContent));
    assert(btn.includes("check all"), `the button stayed ${btn}`);
    log("check: ✓ claude, ◔ codex until 14:01, ✕ antigravity model refused; 3-line issue list with fixes");
    await page.waitForFunction(() => /the brief/.test(
      document.querySelector(".sheet.settings .sins")?.innerText || ""), { timeout: 20000 });
    const ins = await page.$eval(".sheet.settings .sins", (s) => s.innerText);
    assert(/program\.md/.test(ins), "the brief's program.md is not listed");
    assert(/runs in/.test(ins), "no working directory shown");
    await page.evaluate(() => [...document.querySelectorAll(".sins .sfile")]
      .find((b) => /program\.md/.test(b.textContent)).click());
    await page.waitForFunction(() => {
      const v = [...document.querySelectorAll(".sins pre.sview")].find((p) => !p.hidden);
      return v && v.textContent.length > 500;
    }, { timeout: 8000 });
    log("insight: brief, program.md, opens in place");
    await page.keyboard.press("Escape");
    await sleep(200);
    assert(await page.$eval(".sheet.settings", (s) => s.hidden), "Escape did not close ⚙");
    const real = errs.filter((e) => !/api\/agents\/check/.test(e));
    eq(real.length, 0, `page errors: ${real.join(" | ")}`);
  });
}
