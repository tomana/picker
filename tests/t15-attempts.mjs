import { withPage, showTab, assert, eq, sleep, scratchPicker } from "./lib.mjs";
export const name = "attempts — waiting and failed jobs stay, say why, can be handed on";
const now = Date.now() / 1000;
const W = "zzwait" + Math.random().toString(16).slice(2, 8);
const F = "zzfail" + Math.random().toString(16).slice(2, 8);
export async function run(log) {
  const sp = await scratchPicker();
  try { await check(sp, log); } finally { sp.done(); }
}
async function check(sp, log) {
  const base = { type: "fx_visual", kind: "seed", card: null, backend: null,
                 group: "zz-selftest", attachments: [] };
  const write = (lines) => sp.append({ queue: lines.map((l) => ({ ts: now, ...l })) });
  await write([
    { event: "enqueue", id: W, created: now, text: "zz waiting selftest", ...base },
    { event: "claim", id: W, researcher: "fx_visual:codex" },
    { event: "wait", id: W, agent: "codex", until: now + 3600,
      why: "codex is out of usage until later: You've hit your usage limit" },
    { event: "enqueue", id: F, created: now + 1, text: "zz failed selftest", ...base },
    { event: "claim", id: F, researcher: "fx_visual:claude" },
    { event: "failed", id: F, why: "RuntimeError: sync failed (fixture runner): x" },
  ]);
  const { queue } = (await sp.call("/api/queue?open=1")).json;
  const w = queue.find((j) => j.id === W), f = queue.find((j) => j.id === F);
  assert(w && f, "a waiting or failed job is missing from the open queue");
  eq(w.status, "waiting", "waiting job status");
  assert(/^waiting for codex · \d\d:\d\d$/.test(w.issue.short), `waiting says: ${w.issue.short}`);
  eq(f.issue.short, "sync failed", "failed job cause");
  assert(/sync\.py/.test(f.issue.fix), `failed job fix: ${f.issue.fix}`);
  await withPage(async (page, errs) => {
    const sent = [];
    await sp.route(page, (path) => path.startsWith("/api/queue") || path.startsWith("/media/queue/"),
                   { seen: sent });
    await showTab(page, "fx_visual");
    await page.waitForFunction((ids) => ids.every((id) =>
      [...document.querySelectorAll(".qrow")].some((r) => r.innerText.includes("zz "))),
      { timeout: 15000 }, [W, F]);
    const rows = await page.$$eval(".qrow", (rs) => rs.map((r) => ({
      text: r.innerText, cls: r.className })));
    const wr = rows.find((r) => r.text.includes("zz waiting"));
    const fr = rows.find((r) => r.text.includes("zz failed"));
    assert(wr && /waiting for codex/.test(wr.text) && /q-waiting/.test(wr.cls),
           `the waiting row: ${JSON.stringify(wr)}`);
    assert(fr && /sync failed/.test(fr.text) && /q-failed/.test(fr.cls),
           `the failed row: ${JSON.stringify(fr)}`);
    log(`rows: "${wr.text.replace(/\n/g, " · ")}"  /  "${fr.text.replace(/\n/g, " · ")}"`);
    const acts = await page.evaluate(() => [...[...document.querySelectorAll(".qrow")].find((r) => r.innerText.includes("zz failed"))
      .querySelectorAll("button[title]")].map((b) => b.title));
    for (const t of ["try again", "hand it to another agent", "dismiss"])
      assert(acts.includes(t), `the failed row offers ${t}: ${acts.join(" | ")}`);
    await page.evaluate(() => [...document.querySelectorAll(".qrow")]
      .find((r) => r.innerText.includes("zz waiting")).querySelector("button[title^='hand']").click());
    // one button opens the agent menu (the open card's revise menu), the job's agent first; a model tap retries
    await page.waitForSelector(".sheet.job .qhand .qmenu", { timeout: 5000 });
    eq(await page.$eval(".sheet.job .qhand .qmenu", (b) => b.textContent), "↻ retry…", "one button for the hand-off");
    // the sandbox has no agent CLI: the page is told every agent is installed, as on a working machine
    await page.evaluate(() => {
      const real = window.fetch;
      window.fetch = async (u, o) => {
        const r = await real(u, o);
        if (!String(u).startsWith("/api/agents?cached=1")) return r;
        const b = await r.json();
        for (const a of b.agents || []) a.installed = true;
        return new Response(JSON.stringify(b), { headers: { "Content-Type": "application/json" } });
      };
    });
    await page.click(".sheet.job .qhand .qmenu");
    await page.waitForSelector(".whopop .whotab", { timeout: 5000 });
    const tabs = await page.$$eval(".whopop .whotab", (t) => t.map((x) => [x.textContent, x.classList.contains("on")]));
    assert(tabs.some(([t, on]) => t === "codex" && on) && tabs.some(([t]) => t === "claude"),
           `the menu, the job's agent first: ${JSON.stringify(tabs)}`);
    await page.evaluate(() => [...document.querySelectorAll(".whopop .whotab")].find((t) => t.textContent === "claude").click());
    await sleep(150);
    const agent = "claude";
    const picked = await page.$eval(".whopop .whom", (m) => m.title);
    await page.click(".whopop .whom");
    await sleep(300);
    const retried = sent.filter((x) => x.method === "POST" && /\/retry$/.test(x.path));
    assert(retried.length === 1 && retried[0].path.includes(W) && retried[0].body.includes(`"agent":"${agent}"`)
           && /"model":/.test(retried[0].body), `handing on sent: ${JSON.stringify(retried)}`);
    assert(!(await page.$(".whopop")), "the menu shut with the pick");
    log(`handed on: ${tabs.map(([t]) => t).join(" | ")} → ${picked} → ${retried[0].body}`);
    eq(errs.length, 0, `page errors: ${errs.join(" | ")}`);
    if (page.blocked.length) log(`answered in the page, not stored: ${[...new Set(page.blocked)].join(", ")}`);
  });
  const r = await sp.call(`/api/queue/${F}/dismiss`, { method: "POST" });
  eq(r.status, 200, "dismiss");
  const after = (await sp.call("/api/queue?open=1")).json.queue.map((j) => j.id);
  assert(!after.includes(F) && after.includes(W), "dismiss removed the wrong job");
  log("dismissed the failed one; the waiting one stays");
}
