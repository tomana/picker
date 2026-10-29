import { withPage, showTab, api, assert, eq, sleep } from "./lib.mjs";
export const name = "fixture — the example's scored tab, a code loop: best first";
export async function run(log) {
  const { cards } = await api("/api/cards?type=fx_code");
  const ms = cards.map((c) => c.versions.at(-1).score.value);
  eq(JSON.stringify(ms), JSON.stringify([...ms].sort((a, b) => a - b)), "not best first");
  await withPage(async (page, errs) => {
    await showTab(page, "fx_code");
    await page.waitForSelector(".grid .gblock article.card", { timeout: 15000 });
    await sleep(500);
    const g = await page.evaluate(() => ({
      first: document.querySelector(".grid .gblock article.card[data-cid]")?.dataset.cid,
      label: document.querySelector(".cardsbar .chip.on")?.textContent }));
    eq(g.first, "fxcode07", "the grid's first try");
    eq((g.label || "").trim(), "scored", "the tab's name");
    eq(errs.length, 0, `page errors: ${errs.join(" | ")}`);
  });
  const job = await api("/api/queue", { method: "POST", body: { type: "fx_code", kind: "revise", card: "fxcode07", text: "again" } });
  let st = null;
  for (let i = 0; i < 90 && !["done", "failed"].includes(st); i++) {
    await sleep(1000);
    st = ((await api("/api/queue")).queue.find((j) => j.id === job.id) || {}).status;
  }
  eq(st, "done", "the revise through the fake loop");
  const after = (await api("/api/cards?type=fx_code")).cards;
  assert(after[0].versions.at(-1).score.value < ms[0], "the new try isn't first");
  log(`best first, ${ms.join(" ")} ms; a revise of fxcode07: ${after[0].versions.at(-1).score.value} ms, first now`);
}
