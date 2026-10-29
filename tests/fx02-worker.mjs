import { assert, eq, sleep, BASE, api } from "./lib.mjs";
export const name = "fixture — fake researchers: a seed and two revises, started by the scheduler, one in a lane";
async function job(id) {
  const q = await api("/api/queue");
  return (q.queue || q).find((j) => j.id === id);
}
export async function run(log) {
  const before = { grd: (await api("/api/cards/fxgrd1")).versions.length,
                   pulse: (await api("/api/cards/fx1b2c3d4e5f")).versions.length };
  const post = (body) => api("/api/queue", { method: "POST", body });
  const seed = await post({ type: "fx_music", kind: "seed", text: "a made-up idea for a drone" });
  const rev = await post({ type: "fx_visual", kind: "revise", card: "fxgrd1", text: "a tighter grid" });
  const lane = await post({ type: "fx_music", kind: "revise", card: "fx1b2c3d4e5f", text: "", backend: "codex" });
  const ids = [seed, rev, lane].map((j) => (j.job || j).id);
  assert(ids.every(Boolean), `three jobs queued: ${JSON.stringify([seed, rev, lane]).slice(0, 300)}`);
  const t0 = Date.now();
  let jobs = [];
  while (Date.now() - t0 < 90000) {
    jobs = await Promise.all(ids.map(job));
    if (jobs.every((j) => j && ["done", "failed"].includes(j.status))) break;
    await sleep(1000);
  }
  const brief = jobs.map((j) => `${j.id.slice(0, 6)} ${j.kind} ${j.status} ${j.result || j.why || ""}`).join("; ");
  assert(jobs.every((j) => j.status === "done"), `all three done in 90 s: ${brief}`);
  log(`three jobs done in ${((Date.now() - t0) / 1000).toFixed(0)} s, started by the scheduler`);
  const made = await api(`/api/cards/${jobs[0].result}`);
  eq(made.type, "fx_music", "the seed's card type");
  assert(made.id.startsWith("fk"), `the seed's result is the new card, not another: ${made.id}`);
  const voice = made.versions[0].parts[0].audio;
  const r = await fetch(BASE + voice);
  const bytes = (await r.arrayBuffer()).byteLength;
  assert(r.ok && bytes > 1000, `its first voice is served through its relative link: ${r.status} ${bytes} B`);
  log(`seed → ${made.id}: ${made.versions[0].parts.length} voices, the first served (${bytes} B)`);
  eq(jobs[1].result, "fxgrd1", "the visual revise's result");
  eq((await api("/api/cards/fxgrd1")).versions.length, before.grd + 1, "fxgrd1's versions after the revise");
  eq(jobs[2].result, "fx1b2c3d4e5f", "the codex-lane revise's result");
  eq((await api("/api/cards/fx1b2c3d4e5f")).versions.length, before.pulse + 1, "fx1b2c3d4e5f's versions");
  assert(/@codex$/.test(jobs[2].researcher || ""), `the codex job's runner: ${jobs[2].researcher}`);
  assert(!/@/.test(jobs[0].researcher || ""), `the claude seed's runner is the default lane: ${jobs[0].researcher}`);
  log(`revises: fxgrd1 v${before.grd + 1}, fx1b2c3d4e5f v${before.pulse + 1} (claimed by ${jobs[2].researcher})`);
}
