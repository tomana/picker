import { withPage, showTab, api, assert, eq, sleep, BASE } from "./lib.mjs";
export const name = "audit — a card's whole trail, by token";
export async function run(log) {
  eq((await fetch(BASE + "/api/cards/zz-no-such-card/audit")).status, 404,
     "a missing card answered with a trail");
  const { queue } = await api("/api/queue");
  let target = null;
  for (const j of queue.filter((j) => j.status === "done" && j.result).reverse()) {
    const c = await api(`/api/cards/${encodeURIComponent(j.result)}`).catch(() => null);
    if (c && !c.archived && c.type === j.type && j.type === "fx_visual") { target = c; break; }
  }
  assert(target, "no live card made by a job to audit");
  const trail = await api(`/api/cards/${encodeURIComponent(target.id)}/audit`);
  assert(trail.jobs.length >= 1, "the job that made it is missing");
  const srcs = new Set(trail.entries.map((x) => x.src));
  assert(srcs.has("card") && srcs.has("queue"), `sources: ${[...srcs]}`);
  const withTok = trail.entries.filter((x) => x.src === "queue");
  assert(withTok.every((x) => x.job), "a queue line lost its job token");
  log(`${target.id}: ${trail.entries.length} lines from ${[...srcs].join("/")}, ` +
      `${trail.logs.length} agent log(s)`);
  await withPage(async (page, errs) => {
    await showTab(page, "fx_visual");
    const opened = await page.evaluate((id) => {
      const w = [...document.querySelectorAll(".cardwrap")]
        .find((x) => x.querySelector("img.still, img")?.src.includes(`/media/${id}/`));
      if (!w) return false;
      w.querySelector(".cmedia, .media, article.card").click();
      return true;
    }, target.id);
    assert(opened, `${target.id} is not on the grid`);
    await page.waitForSelector('.sheet.big button[title^="the log"]', { timeout: 8000 });
    await page.click('.sheet.big button[title^="the log"]');
    await page.waitForSelector(".sheet.audit .aline", { timeout: 15000 });
    const lines = await page.$$eval(".sheet.audit .aline", (l) => l.length);
    eq(lines, trail.entries.length, "the sheet dropped lines");
    const text = await page.$eval(".sheet.audit", (s) => s.innerText);
    assert(!/\bnull\b/.test(text.split("\n").slice(0, 3).join(" ")), "a null was drawn");
    const jid = trail.jobs[trail.jobs.length - 1].id;
    await page.evaluate((j) => [...document.querySelectorAll(".sheet.audit .atok")]
      .find((b) => j.startsWith(b.textContent)).click(), jid);
    await sleep(150);
    const only = await page.$$eval(".sheet.audit .aline", (l) => l.length);
    const want = trail.entries.filter((x) => x.job === jid).length;
    eq(only, want, "the token did not narrow to its job");
    if (trail.logs.some((l) => l.job === jid)) {
      await page.click(".sheet.audit details.ajob summary");
      const shown = await page.$eval(".sheet.audit details.ajob pre", (p) => p.textContent.length);
      assert(shown > 50, "the agent log is empty");
      log(`job ${jid.slice(0, 6)}: ${only} lines, agent log ${shown} chars`);
    }
    await page.keyboard.press("Escape");
    await sleep(150);
    assert(await page.$eval(".sheet.audit", (s) => s.hidden), "Escape did not close the log");
    assert(!(await page.$eval(".sheet.big", (s) => s.hidden)),
           "Escape closed the card under the log too");
    eq(errs.length, 0, `page errors: ${errs.join(" | ")}`);
  });
}
