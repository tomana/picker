import { withPage, showTab, ensurePanel, assert, sleep, scratchPicker } from "./lib.mjs";
export const name = "music cup — on its tab, by ear, every card ranked with − + pool and archive";
export async function run(log) {
  const sp = await scratchPicker();
  try { await check(sp, log); } finally { sp.done(); }
}
async function check(sp, log) {
  const ok = async (path, body) => {
    const r = await sp.call(path, body ? { method: "POST", body } : {});
    if (r.status >= 400) throw new Error(`${path} → ${r.status} ${r.text.trim()}`);
    return r.json;
  };
  let st = await ok("/api/cup", { type: "fx_music" });
  const ids = (st.groups || []).flat();
  assert(ids.length >= 4, `a fx_music cup over ${ids.length} cards`);
  const recs = ids.filter((id) => /recording/.test(JSON.stringify((st.cards[id] || {}).origin || "")));
  assert(!recs.length, `recordings in the draw: ${recs.join(", ")}`);
  const mute = ids.filter((id) => !(st.cards[id] || {}).audio);
  assert(!mute.length, `cards with nothing to listen to: ${mute.slice(0, 4).join(", ")}`);
  log(`drawn: ${ids.length} pieces in ${st.groups.length} groups, each with its mix`);
  let guard = 0;
  while (st.stage !== "done" && guard++ < 400) {
    if (st.stage === "group") st = await ok(`/api/cup/${st.id}/pick`,
      { group: st.next.group, picks: st.next.cards.slice(0, st.next.advance) });
    else st = await ok(`/api/cup/${st.id}/duel`, { a: st.next.duel.a, b: st.next.duel.b, winner: st.next.duel.a });
  }
  assert(st.stage === "done", "the cup didn't finish");
  const status = await ok("/api/cup?type=fx_music");
  const rank = (status.last || {}).ranking || [];
  eq(rank.length, ids.length, "the ranking holds every card the cup judged");
  assert(rank[0].place === 1 && rank[0].card.id === st.winner && rank[1].place === 2,
         `the top: ${JSON.stringify(rank.slice(0, 3).map((p) => [p.place, p.card.id]))}`);
  assert(rank.every((r, i) => !i || r.place >= rank[i - 1].place), "the ranking isn't in order");
  log(`ranking: ${rank.length} cards, ${rank.slice(0, 4).map((p) => `${p.place} ${p.card.id}`).join(" · ")} … ${rank.at(-1).place}`);
  await withPage(async (page, errs) => {
    await sp.route(page, (p) => p.startsWith("/api/cup"));
    await showTab(page, "fx_music");
    await sleep(1500);
    await ensurePanel(page, "cup", true);
    await sleep(500);
    const panel = await page.evaluate(() => {
      const grid = document.querySelector(".grid");
      const kids = [...grid.children];
      const cup = grid.querySelector("article.cup");
      const list = cup && cup.querySelector(".cuprank");
      const rows = [...(list ? list.querySelectorAll(".rkrow") : [])].map((r) => ({
        place: r.querySelector(".rkplace").textContent, name: r.querySelector(".rkname").textContent,
        votes: r.querySelectorAll(".auvote .auv").length, pool: !!r.querySelector(".rkpool"),
        arch: !!r.querySelector(".rkarch svg") }));
      return { at: kids.indexOf(cup), playlistAt: kids.findIndex((k) => /autop|playlist/i.test(k.className)),
               scrolls: !!list && list.scrollHeight > list.clientHeight, rows };
    });
    assert(panel.at >= 0, "no cup panel on the fx_music tab");
    assert(panel.playlistAt >= 0 && panel.playlistAt < panel.at, "under AUTO's panel");
    eq(panel.rows.length, rank.length, "rows in the list");
    const whole = panel.rows.filter((r) => r.votes === 2 && r.pool && r.arch).length;
    assert(whole >= rank.length - 2, `rows missing − + pool or the archive tray: ${JSON.stringify(panel.rows.slice(0, 3))}`);
    assert(panel.scrolls, "the list doesn't scroll");
    log(`panel at ${panel.at} (playlist at ${panel.playlistAt}): ${panel.rows.length} rows, ${whole} with − + pool ▤; ` +
        panel.rows.slice(0, 3).map((r) => `${r.place} ${r.name}`).join(" · "));
    for (const [sel, kind] of [[".auvote .auv", "vote"], [".rkpool", "pool"], [".rkarch", "archive"]]) {
      const before = page.blocked.length;
      await page.evaluate((q) => [...document.querySelector("article.cup .rkrow").querySelectorAll(q)].at(-1).click(), sel);
      await sleep(500);
      const sent = page.blocked.slice(before);
      assert(sent.some((x) => /POST \/api\/cards\/[^/]+\/signal/.test(x)), `${kind} sent nothing: ${sent.join(" | ")}`);
    }
    log("− + pool and the archive tray each send their signal");
    await page.evaluate(() => document.querySelector("article.cup .rkrow .rkplay").click());
    await sleep(1800);
    const row = await page.evaluate(() => {
      const r = document.querySelector("article.cup .rkrow");
      const l = r.querySelector(".rkname .vline");
      return { on: !!r.querySelector(".rkplay.on"), left: l ? parseFloat(l.style.left) : null, t: l ? l.dataset.t : null };
    });
    assert(row.on && row.left > 0 && row.t, `a row's ▶: ${JSON.stringify(row)}`);
    await page.evaluate(() => document.querySelector("article.cup .rkrow .rkplay").click());
    await sleep(300);
    eq(await page.evaluate(() => !!document.querySelector("article.cup .rkplay.on, article.cup .rkname .vline")), false,
       "⏸ left the row playing");
    log(`a row's ▶ ran the hairpin to ${row.left.toFixed(1)}% (${row.t}); ⏸ stopped it`);
    if (process.env.LIST_SHOT) {
      await page.evaluate(() => document.querySelector("article.cup").scrollIntoView({ block: "start" }));
      await sleep(400);
      await page.screenshot({ path: process.env.LIST_SHOT });
    }
    await page.evaluate(() => document.querySelector("article.cup .cuprow").click());
    await sleep(1200);
    const won = await page.evaluate(() => {
      const s = document.querySelector(".sheet.cup:not([hidden])");
      return { play: !!s.querySelector(".cupshot .vplay svg"), lanes: s.querySelectorAll(".cupshot.bands .lane").length,
               box: !!s.querySelector(".cupcheck") };
    });
    assert(won.play && won.lanes > 0 && !won.box, `the winner's tile: ${JSON.stringify(won)}`);
    await page.evaluate(() => [...document.querySelectorAll(".sheet.cup .cupgo")]
      .find((b) => /again|start/.test(b.textContent)).click());
    await sleep(1500);
    const g0 = await page.evaluate(() => ({ boxes: document.querySelectorAll(".sheet.cup .cupgrid .cupcheck").length,
                                            plays: document.querySelectorAll(".sheet.cup .cupgrid .vplay").length,
                                            bands: document.querySelectorAll(".sheet.cup .cupgrid .cupshot.bands").length }));
    assert(g0.boxes >= 2 && g0.boxes === g0.plays && g0.bands > 0, `group tiles: ${JSON.stringify(g0)}`);
    const names = await page.evaluate(() => [...document.querySelectorAll(".sheet.cup .cupgrid .cupref")].map((e) => e.textContent));
    assert(names.length && names.every((n) => /^h:|^[0-9a-f]{12}$|^tr|^[a-z]/.test(n) && !/\s/.test(n)),
           `tile names aren't ids: ${names.join(" | ")}`);
    await page.evaluate(() => { window.__live = []; const A = window.Audio;
      window.Audio = function (u) { const a = new A(u); window.__live.push(a); return a; }; });
    await page.evaluate(() => document.querySelector(".sheet.cup .cupgrid .cupshot.bands .vplay").click());
    await sleep(1800);
    const hear = await page.evaluate(() => {
      const t = document.querySelector(".sheet.cup .cupgrid .cupshot.bands");
      return { lit: !!t.querySelector(".vplay.on"), head: (t.querySelector(".vline") || { style: {} }).style.left || "",
               picked: document.querySelectorAll(".sheet.cup .cupcheck.on").length };
    });
    assert(hear.lit && hear.head, `the bands' ▶ in the cup: ${JSON.stringify(hear)}`);
    eq(hear.picked, 0, "playing picked it");
    await page.evaluate(() => { const b = document.querySelectorAll(".sheet.cup .cupgrid .cupcheck"); b[0].click(); });
    await page.evaluate(() => { const b = document.querySelectorAll(".sheet.cup .cupgrid .cupcheck"); b[1].click(); });
    await sleep(300);
    const g1 = await page.evaluate(() => ({ on: document.querySelectorAll(".sheet.cup .cupcheck.on").length,
      next: !([...document.querySelectorAll(".sheet.cup .cupgo")].find((b) => /next/.test(b.textContent)) || {}).disabled }));
    assert(g1.on === 2 && g1.next, `two boxes ticked: ${JSON.stringify(g1)}`);
    if (process.env.CUP_SHOT) await page.screenshot({ path: process.env.CUP_SHOT });
    log(`pool sends the pool signal; the winner's tile has ${won.lanes} lanes; a group's ${g0.boxes} tiles: ${g0.bands} with bands, each ▶ and a box; ▶ ran the hairpin to ${hear.head}; two ticked unlock ▸ next`);
    assert(!errs.length, "page errors: " + errs.slice(0, 3).join(" | "));
  });
}
function eq(got, want, msg) {
  if (got !== want) throw new Error(`${msg}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
}
