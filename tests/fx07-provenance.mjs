import { withPage, assert, eq, sleep, BASE } from "./lib.mjs";
export const name = "fixture — provenance: a send as configured, a job's receipts";
export async function run(log) {
  const types = (await (await fetch(`${BASE}/api/types`)).json()).types;
  const t = types.find((x) => x.type === "fx_visual");
  const agent = (t.agents || []).find((a) => a !== "sweep");
  const d = await (await fetch(`${BASE}/api/agents/insight/fx_visual?agent=${agent}&kind=revise&card=fxgrd1&version=2`)).json();
  assert(!d.error, `the brief does not build: ${d.error}`);
  eq(JSON.stringify([d.kind, d.card]), JSON.stringify(["revise", "fxgrd1"]), "the insight answers for the send's own kind and card");
  assert((d.command || []).includes("<the brief>"), `the command names the brief: ${JSON.stringify(d.command)}`);
  eq(d.manifest && d.manifest.type, "fx_visual", "the type's manifest comes with it");
  log(`as configured: ${(d.command || []).slice(-3).join(" ")} · the brief ${d.brief.chars} chars · manifest ${d.manifest.type}`);
  const none = await (await fetch(`${BASE}/api/queue/fxjob000001/receipts`)).json();
  eq(none.receipts.length, 0, "a job from before receipts has none");
  await withPage(async (page) => {
    await page.goto(`${BASE}/?tab=fx_visual`, { waitUntil: "domcontentloaded" });
    await sleep(800);
    const drawn = await page.evaluate(async (agent) => {
      const m = await import("/static/app/parts/settings.js");
      const a = await m.configured({ type: "fx_visual", agent, kind: "revise", card: "fxgrd1", version: 2 });
      const r = await m.receipts("fxjob000001");
      return [a.textContent, r.textContent];
    }, agent);
    assert(/as configured/.test(drawn[0]) && /command/.test(drawn[0]) && /the tab's manifest/.test(drawn[0]),
           `the configured view: ${drawn[0].slice(0, 200)}`);
    assert(/revise of fxgrd1/.test(drawn[0]), "it names the send it describes");
    assert(/no receipts/.test(drawn[1]), `the receipts view of a job from before them: ${drawn[1].slice(0, 120)}`);
    log("drawn: as configured (command, brief, files, manifest); a job from before receipts says it has none");
  });
}
