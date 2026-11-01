import { withPage, assert, eq, sleep, showTab, api } from "./lib.mjs";
export const name = "AUTO's queue row — says the card and tab it works in, and its agent, model and effort in the menus' short words, never cut off";

export async function run(log) {
  const ag = (await api("/api/agents?cached=1")).agents || [];
  const a = ag.find((x) => (x.menu || []).length);
  assert(a, "an agent with a model menu");
  const model = a.menu[0];
  const card = (await api("/api/cards?type=fx_music")).cards.find((c) => !c.archived);
  const types = await api("/api/types"), ty = (Array.isArray(types) ? types : types.types).find((t) => t.type === "fx_music");
  const tab = ty.short || ty.label || ty.type, pre = ty.name_prefix;
  const now = Date.now() / 1000;
  const jobs = [
    { id: "zzauto1", type: "fx_music", kind: "revise", group: "auto", status: "running", card: card.id, phase: "making",
      created: now - 60, started: now - 50, run: { agent: a.name, model: model.id, effort: "xhigh", planned: false } },
    { id: "zzauto2", type: "fx_music", kind: "revise", group: "auto", status: "failed", created: now - 30,
      issue: { level: "error", short: "failed" }, run: { agent: a.name, model: model.id, effort: null, planned: true } },
  ];
  await withPage(async (page, errs) => {
    await page.setViewport({ width: 360, height: 800, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    await page.setRequestInterception(true);
    page.on("request", (r) => {
      const u = new URL(r.url());
      if (u.pathname === "/api/queue" && r.method() === "GET")
        return r.respond({ status: 200, contentType: "application/json", body: JSON.stringify({ queue: jobs }) });
      if (r.method() === "GET" || r.method() === "HEAD") return r.continue();
      return r.respond({ status: 200, contentType: "application/json", body: "{}" });
    });
    await showTab(page, "fx_music");
    await page.waitForFunction(() => document.querySelectorAll(".qrow").length >= 2, { timeout: 15000 });
    await sleep(800);
    const rows = await page.$$eval(".qrow", (rs) => rs.map((r) => {
      const run = r.querySelector(".qrun");
      return { title: r.querySelector(".qtitle").textContent.trim(), run: run && run.textContent,
               cut: run ? run.scrollHeight > run.clientHeight + 1 || run.scrollWidth > run.clientWidth + 1 : null };
    }));
    const ref = await page.evaluate((id) => document.querySelector(`.grid article.card[data-cid="${id}"] .cref`)?.textContent, card.id);
    const want = pre && ref && ref.startsWith(`${pre}:`) ? `AUTO · ${ref}` : `AUTO · ${tab} · ${ref || card.id}`;
    assert(rows[0].title.endsWith(want), `the running row names its card (with the tab's prefix) or the tab and card: ${rows[0].title}, want ${want}`);
    assert(rows[1].title.endsWith(`AUTO · ${tab}`), `a row with no card yet names the tab: ${rows[1].title}`);
    eq(rows[0].run, `${a.cli} · ${model.label} · xhigh effort`, "the run line in the menus' words, with the effort");
    eq(rows[1].run, `${a.cli} · ${model.label} · default effort`, "no effort set: the default");
    assert(rows.every((r) => !r.cut), `a run line was cut off at 360 px: ${JSON.stringify(rows)}`);
    assert(!errs.length, "page errors: " + errs.slice(0, 4).join(" | "));
    log(rows.map((r) => `${r.title} — ${r.run}`).join("; "));
  });
}
