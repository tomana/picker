import { withPage, showTab, api, assert, eq, sleep } from "./lib.mjs";
export const name = "fixture — the examples: an idea and a revise on each, through their runners and the fake agent";
async function done(id) {
  let j = null;
  for (let i = 0; i < 120 && !(j && ["done", "failed"].includes(j.status)); i++) {
    await sleep(1000);
    j = (await api("/api/queue")).queue.find((x) => x.id === id) || j;
  }
  return j || {};
}
export async function run(log) {
  const said = [];
  for (const [type, words] of [["visual", "slow violet rings"], ["music", "a slow minor drone"]]) {
    const seed = await api("/api/queue", { method: "POST", body: { type, kind: "seed", text: words } });
    const a = await done(seed.id);
    eq(a.status, "done", `${type}: the idea (${a.why || ""})`);
    const made = await api(`/api/cards/${a.result}`);
    eq(made.label, words, `${type}: the new card's name`);
    const v = made.versions.at(-1);
    if (type === "visual") assert(v.media.still && v.media.gif, `visual: no picture ${JSON.stringify(v.media)}`);
    else assert(v.parts.length >= 2 && v.parts.every((p) => p.audio && p.peaks) && v.score.name === "clash",
                `music: lanes and a score ${JSON.stringify(v.score)}`);
    const rev = await api("/api/queue", { method: "POST", body: { type, kind: "revise", card: a.result, text: "" } });
    const b = await done(rev.id);
    eq(b.status, "done", `${type}: the revise (${b.why || ""})`);
    eq((await api(`/api/cards/${a.result}`)).versions.length, 2, `${type}: a second version`);
    said.push(`${type}: ${a.result} "${words}", then v2 (${(await api(`/api/cards/${a.result}`)).versions[1].rationale})`);
  }
  await withPage(async (page, errs) => {
    await showTab(page, "music");
    await page.waitForSelector(".grid .gblock article.card .lane", { timeout: 15000 });
    await showTab(page, "visual");
    await page.waitForSelector(".grid .gblock article.card img.still", { timeout: 15000 });
    eq(errs.length, 0, `page errors: ${errs.join(" | ")}`);
  });
  log(said.join("; "));
}
