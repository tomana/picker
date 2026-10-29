import { withPage, showTab, ensurePanel, api, assert, eq, scratchPicker } from "./lib.mjs";
export const name = "cup — a type judged, and the position replayed";
let sp = null;
const cup = async (path) => {
  const r = await sp.call(path);
  if (r.status >= 400) throw new Error(`${path} → ${r.status} ${r.text.trim()}`);
  return r.json;
};
const post = async (path, body) => {
  const r = await sp.call(path, { method: "POST", body });
  if (r.status >= 400) throw new Error(`${path} → ${r.status} ${r.text.trim()}`);
  return r.json;
};
export async function run(log) {
  sp = await scratchPicker();
  try { await check(log); } finally { sp.done(); sp = null; }
}
async function check(log) {
  // Candidates come from the visible grid; archived cards cannot re-enter a draw.
  const { types } = await api("/api/types");
  const seen = [];
  for (const t of types) {
    const s0 = await cup(`/api/cup?type=${encodeURIComponent(t.type)}`);
    seen.push(`${t.type}:${s0.candidates}`);
    assert(s0.candidates <= t.cards,
           `${t.type}: ${s0.candidates} candidates against ${t.cards} in the grid`);
  }
  log(`candidates per type: ${seen.join("  ")}`);
  {
    let t0 = null, shown = null, culled = [];
    for (const t of types) {
      shown = new Set((await api(`/api/cards?type=${encodeURIComponent(t.type)}`)).cards.map((c) => c.id));
      const all = (await api(`/api/cards?type=${encodeURIComponent(t.type)}&archived=1`)).cards;
      culled = all.filter((c) => !shown.has(c.id));
      if (culled.length) { t0 = t.type; break; }
    }
    assert(t0, "no type has archived cards to test against");
    const st0 = await post("/api/cup", { type: t0 });
    try {
      const drawn = new Set(st0.groups.flat());
      const smuggled = [...drawn].filter((id) => !shown.has(id));
      eq(smuggled.length, 0,
         `the draw reached into the archive: ${smuggled.slice(0, 3)}`);
      log(`${t0}: ${drawn.size} drawn, all from the grid; ${culled.length} ` +
          `archived cards left where they are`);
    } finally {}
  }
  const stats = await Promise.all(types.map(async (t) =>
    ({ t: t.type, n: (await cup(`/api/cup?type=${encodeURIComponent(t.type)}`)).candidates })));
  const pick = stats.filter((x) => x.n >= 2).sort((a, b) => a.n - b.n)[0];
  assert(pick, "no type has two cards to judge");
  const votesBefore = new Map((await api(
    `/api/cards?type=${encodeURIComponent(pick.t)}`)).cards.map((c) => [c.id, c.vote]));
  const gridBefore = [...votesBefore.keys()];
  let st = await post("/api/cup", { type: pick.t });
  const cupId = st.id;
  log(`${pick.t}: ${pick.n} cards → ${st.groups.length} group(s) ` +
      `[${st.groups.map((g) => g.length)}]`);
  try {
    const ids = new Set(st.groups.flat());
    eq([...ids].filter((i) => !st.cards[i]).length, 0, "cards not inlined");
    const stray = st.groups.length > 1 ? st.groups[1][0] : null;
    if (stray) {
      const r = await sp.call(`/api/cup/${cupId}/pick`, {
        method: "POST", body: { group: 0, picks: [stray] } });
      eq(r.status, 400, "a pick outside its own group was accepted");
      log("a pick from the wrong group is refused (400)");
    }
    let picks = 0, duels = 0, guard = 0;
    let firstDuel = null;
    while (st.stage !== "done" && guard++ < 80) {
      if (st.stage === "group") {
        const g = st.next;
        st = await post(`/api/cup/${cupId}/pick`,
                        { group: g.group, picks: g.cards.slice(0, g.advance) });
        picks++;
      } else {
        const d = st.next.duel;
        if (!firstDuel) {
          // A fresh read must reconstruct the same position from the decision log.
          firstDuel = d;
          const again = await cup(`/api/cup/${cupId}`);
          eq(JSON.stringify(again.next.duel), JSON.stringify(d),
             "a re-read landed on a different duel");
          log("a fresh read lands on the same duel — the log is the position");
        }
        st = await post(`/api/cup/${cupId}/duel`,
                        { a: d.a, b: d.b, winner: d.a });
        duels++;
      }
    }
    eq(st.stage, "done", `cup never finished (${guard} steps)`);
    assert(st.winner, "finished with no winner");
    log(`${picks} group pick(s) + ${duels} duel(s) → ${st.winner}`);
    const after = (await api(`/api/cards?type=${encodeURIComponent(pick.t)}`)).cards;
    eq(after.length, gridBefore.length,
       `the cup changed the grid: ${gridBefore.length} → ${after.length}`);
    const gone = gridBefore.filter((id) => !after.some((c) => c.id === id));
    eq(gone.length, 0, `the cup archived: ${gone.slice(0, 3)}`);
    const w = after.find((c) => c.id === st.winner);
    eq(w ? w.vote : null, votesBefore.get(st.winner),
       "the cup wrote a vote onto its winner");
    log(`after: ${after.length} cards, none moved, winner's vote still ${w && w.vote}`);
    if (firstDuel) {
      const r = await sp.call(`/api/cup/${cupId}/duel`, {
        method: "POST", body: { ...firstDuel, winner: firstDuel.a } });
      eq(r.status, 409, "a stale duel was accepted");
      log("a duel that has already been decided is refused (409)");
    }
    await withPage(async (page, errs) => {
      await sp.route(page, (path) => path.startsWith("/api/cup"));
      for (const t of types) {
        await showTab(page, t.type);
        await ensurePanel(page, "cup");
        const entry = await page.evaluate(() => {
          const c = document.querySelector(".card.compose.cup");
          return c && { go: c.querySelector(".cupgo")?.textContent,
                        note: c.querySelector(".cnote")?.textContent };
        });
        assert(entry, `no cup entry on the ${t.type} grid`);
        assert(/cards|under way|won by/.test(entry.note),
               `${t.type} entry says nothing: ${entry.note}`);
        if (t.type === pick.t) {
          assert(/won by/.test(entry.note),
                 `the finished cup is not on the entry: ${entry.note}`);
        }
        log(`${t.type} entry: ${entry.note}`);
      }
      await showTab(page, pick.t);
      await ensurePanel(page, "cup");
      await page.click(".card.compose.cup .cupgo");
      await new Promise((r) => setTimeout(r, 1200));
      const open = await page.evaluate(() => ({
        shown: !document.querySelector(".sheet.cup")?.hidden,
        ask: document.querySelector(".cuphost .cupask")?.textContent,
        btn: document.querySelector(".cuphost .cupgo")?.textContent,
      }));
      assert(open.shown, "the cup sheet did not open");
      assert(/\d/.test(open.ask || ""), `start screen has no count: ${open.ask}`);
      assert(/again/.test(open.btn || ""),
             `a played type should offer a rerun, got: ${open.btn}`);
      log(`sheet: "${open.ask}" · [${open.btn}]`);
      assert(!errs.length, "page errors: " + errs.slice(0, 3).join(" | "));
    });
  } finally {}
}
