import { assert, eq, sleep, api } from "./lib.mjs";
export const name = "fixture — the maintenance gate: running work finishes, nothing new starts, open runs it once";
async function job(id) {
  const q = await api("/api/queue");
  return (q.queue || q).find((j) => j.id === id);
}
const until = async (what, ok, ms = 60000) => {
  const t0 = Date.now();
  for (;;) {
    const v = await what();
    if (ok(v)) return v;
    if (Date.now() - t0 > ms) return v;
    await sleep(500);
  }
};
export async function run(log) {
  const gate = (body) => api("/api/gate", body ? { method: "POST", body } : {});
  await gate({ closed: false });
  const post = (body) => api("/api/queue", { method: "POST", body });
  const a = await post({ type: "fx_visual", kind: "revise", card: "fxgrd1", text: "[slow 8] a gate check" });
  const A = (a.job || a).id;
  const running = await until(() => job(A), (j) => j && j.status === "running", 30000);
  eq(running.status, "running", "the slow job is running");
  await gate({ closed: true, why: "fx06" });
  const b = await post({ type: "fx_visual", kind: "revise", card: "fxgrd1", text: "sent while the gate was closed" });
  const B = (b.job || b).id;
  const st = await gate();
  assert(st.closed && !st.idle.idle && st.idle.running.includes(A), `closed, busy with A: ${JSON.stringify(st)}`);
  const vn = (await api("/api/cards/fxgrd1")).versions.at(-1).n;
  await api("/api/cards/fxgrd1/signal", { method: "POST", body: { kind: "vote", value: 2, version: vn } });
  const doneA = await until(() => job(A), (j) => j && j.status === "done", 40000);
  eq(doneA.status, "done", "the running job finished");
  await sleep(5000);
  eq((await job(B)).status, "queued", "the job sent while closed is still queued");
  const idle = await until(gate, (g) => g.idle.idle, 20000);
  assert(idle.idle.idle, `idle once A is done and its runner gone: ${JSON.stringify(idle.idle)}`);
  log(`closed with ${A.slice(0, 6)} running: it finished; ${B.slice(0, 6)} waited, queued; idle`);
  await gate({ closed: false });
  const doneB = await until(() => job(B), (j) => j && j.status === "done", 60000);
  eq(doneB.status, "done", "opened, the waiting job ran");
  eq((doneB.attempts ?? 1), 1, "claimed once");
  const card = await api("/api/cards/fxgrd1");
  eq((card.versions.find((v) => v.n === vn) || {}).vote, 2, "the vote cast while closed is there");
  log(`opened: ${B.slice(0, 6)} claimed once and done; the vote kept`);
}
