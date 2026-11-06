import { withPage, assert, eq, sleep, showTab, api } from "./lib.mjs";
const SHOTS = process.env.SHOTS;
export const name = "the queue's agents in their colours — a row's run line and phase, the job's sheet; a model's name and an agent with no colour stay plain (the queue from outside)";

const now = Date.now() / 1000;
const JOBS = [
  { id: "zzhue1", status: "running", phase: "codex: writing its voice", run: { agent: "codex", model: "m-sol", effort: "xhigh" }, hue: "oai", word: "codex", line: "codex · Sol · xhigh effort" },
  { id: "zzhue2", status: "running", phase: "claude surveying 3 cards", run: { agent: "claude", model: "m-opus", effort: "high" }, hue: "ant", word: "claude", line: "claude · Claude Opus · high effort" },
  { id: "zzhue3", status: "running", phase: "antigravity: writing", run: { agent: "antigravity", model: "gemini-3-flash", effort: null }, hue: "goog", word: "agy", line: "agy · gemini-3-flash · default effort" },
  { id: "zzhue4", status: "running", phase: "making", run: { agent: "other", model: "m-x", effort: null }, hue: null, word: null, line: "other · m-x · default effort" },
].map((j, i) => ({ type: "fx_music", kind: "revise", text: j.id, created: now - 60 + i, started: now - 50 + i, ...j }));

export async function run(log) {
  const real = (await api("/api/agents?cached=1")).agents || [];
  const agents = [...real,
    { name: "codex", cli: "codex", menu: [{ id: "m-sol", label: "Sol" }] },
    { name: "claude", cli: "claude", menu: [{ id: "m-opus", label: "Claude Opus" }] },
    { name: "antigravity", cli: "agy", menu: [] },
    { name: "other", cli: "other", menu: [{ id: "m-x", label: "m-x" }] }];
  await withPage(async (page, errs) => {
    await page.setViewport({ width: 360, height: 800, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    await page.setRequestInterception(true);
    const json = (r, body) => r.respond({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
    page.on("request", (r) => {
      const u = new URL(r.url()), get = r.method() === "GET";
      if (u.pathname === "/api/queue" && get) return json(r, { queue: JOBS });
      const one = JOBS.find((j) => u.pathname === `/api/queue/${j.id}`);
      if (one && get) return json(r, one);
      if (/^\/api\/queue\/[^/]+\/log$/.test(u.pathname)) return json(r, { lines: [] });
      if (u.pathname === "/api/agents" && get) return json(r, { agents });
      return get || r.method() === "HEAD" ? r.continue() : json(r, {});
    });
    await showTab(page, "fx_music");
    await page.waitForFunction(() => document.querySelectorAll(".qrow .qrun").length >= 4, { timeout: 15000 });
    await page.waitForFunction(() => [...document.querySelectorAll(".qrun")].some((x) => x.textContent.startsWith("agy")), { timeout: 8000 });
    await sleep(300);

    // the coloured words in a box, each with what its colour is; the token's colour read the same way
    const words = (box, sel) => page.evaluate((box, sel) => {
      const n = document.querySelector(box).querySelector(sel);
      return { text: n.textContent, spans: [...n.querySelectorAll("span")].filter((s) => s.style.color)
        .map((s) => [s.textContent, getComputedStyle(s).color]) };
    }, box, sel);
    const token = (hue) => page.evaluate((hue) => {
      const p = document.createElement("i");
      p.style.color = `var(--${hue}-text)`;
      document.body.append(p);
      const c = getComputedStyle(p).color;
      p.remove();
      return c;
    }, hue);
    await page.evaluate((ids) => ids.forEach((id, i) => {
      const r = [...document.querySelectorAll(".qrow")].find((x) => x.textContent.includes(id));
      r.id = `zzrow${i}`;
    }), JOBS.map((j) => j.id));
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/queue-agents.png` });

    const said = [];
    for (const [i, j] of JOBS.entries()) {
      const r = await words(`#zzrow${i}`, ".qrun");
      eq(r.text, j.line, `${j.id}: the run line's words are as they were`);
      const want = j.hue ? [[j.word, await token(j.hue)]] : [];
      eq(JSON.stringify(r.spans), JSON.stringify(want), `${j.id}: only the agent's name is coloured on the run line`);
      const b = await words(`#zzrow${i}`, ".qbeat");
      const name = j.phase.split(/[: ]/)[0];
      eq(JSON.stringify(b.spans), JSON.stringify(j.hue ? [[name, await token(j.hue)]] : []), `${j.id}: and in the phase`);
      said.push(j.hue ? `${j.word} ${want[0][1]}` : "other plain");
    }

    // the job's sheet says it the same way
    await page.click("#zzrow2");
    await page.waitForSelector(".sheet.job:not([hidden]) .qjrun", { timeout: 8000 });
    const g = await token("goog");
    eq(JSON.stringify((await words(".sheet.job", ".qjrun")).spans), JSON.stringify([["agy", g]]), "the sheet's run line");
    eq(JSON.stringify((await words(".sheet.job", ".qjline")).spans), JSON.stringify([["antigravity", g]]), "the sheet's phase");
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/queue-agents-sheet.png` });
    assert(!errs.length, "page errors: " + errs.slice(0, 4).join(" | "));
    log(said.join("; "));
  });
}
