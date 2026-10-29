import { withPage, showTab, api, assert, eq, sleep } from "./lib.mjs";
export const name = "fixture — the example's hybrid tab, a fit loop: by need, and a revise through its loop";
export async function run(log) {
  const { cards } = await api("/api/cards?type=fx_fit");
  const needs = cards.map((c) => (c.need || {}).value);
  eq(JSON.stringify(needs), JSON.stringify([...needs].sort((a, b) => b - a)), "not in need order");
  eq(cards[0].id, "fxfit02", "the loss voted worse than the kicks' bar, with its judges disagreeing, isn't first");
  await withPage(async (page, errs) => {
    await showTab(page, "fx_fit");
    await page.waitForSelector(".grid .abblock", { timeout: 15000 });
    const g = await page.evaluate(() => ({
      first: (document.querySelector(".grid [data-cid]") || {}).dataset?.cid,
      ab: document.querySelectorAll(".grid article.card .abblock").length,
      label: (document.querySelector(".cardsbar .chip.on") || {}).textContent }));
    eq(g.first, "fxfit02", "the grid's first card");
    assert(g.ab > 0, "no A/B on the grid");
    eq((g.label || "").trim(), "hybrid", "the tab's name");
    eq(errs.length, 0, `page errors: ${errs.join(" | ")}`);
  });
  const before = await api("/api/cards/fxfit03");
  const was = before.versions.at(-1).score.value;
  const job = await api("/api/queue", { method: "POST", body: { type: "fx_fit", kind: "revise", card: "fxfit03", text: "closer" } });
  let st = null;
  for (let i = 0; i < 90 && !["done", "failed"].includes(st); i++) {
    await sleep(1000);
    st = ((await api("/api/queue")).queue.find((j) => j.id === job.id) || {}).status;
  }
  eq(st, "done", "the revise through the fake loop");
  const after = await api("/api/cards/fxfit03");
  eq(after.versions.length, before.versions.length + 1, "a try more");
  const now = after.versions.at(-1);
  assert(now.score.value < was && now.media.ab && now.ab_at, `the new try: ${JSON.stringify(now.score)}`);
  log(`by need, ${cards.map((c) => c.id).join(" ")}; a revise of fxfit03: v${now.n}, loss ${was} → ${now.score.value}`);
}
