import { withPage, showTab, api, assert, eq } from "./lib.mjs";
export const name = "grid — three types, three shapes";
export async function run(log) {
  const { types } = await api("/api/types");
  assert(types.length >= 1, "no types registered");
  await withPage(async (page, errs) => {
    for (const t of types) {
      await showTab(page, t.type);
      const g = await page.evaluate(() => ({
        cards: document.querySelectorAll("article.card:not(.compose)").length,
        pics: document.querySelectorAll(
          "article.card .media img.still, article.card .media.video img, article.card .abslice img").length,
        lanes: document.querySelectorAll("article.card .lane").length,
        play: document.querySelectorAll("article.card .vplay").length,
      }));
      log(`${t.type}: ${g.cards} cards, ${g.pics} pictures, ${g.lanes} lanes`);
      eq(g.cards, t.cards, `${t.type} card count`);
      const { cards } = await api(`/api/cards?type=${encodeURIComponent(t.type)}`);
      const anyAudio = cards.some((c) => (c.versions || []).some(
        (v) => (v.parts || []).some((p) => p.audio)));
      const anyPic = cards.some((c) => {
        const m = c.media || {};
        return m.gif || m.poster || m.still || m.video;
      });
      if (anyPic) assert(g.pics > 0, `${t.type} has pictures in the store but drew none`);
      if (anyAudio && !anyPic) assert(g.lanes > 0, `${t.type} has audio parts but drew no lanes`);
      if (g.lanes) {
        const hs = await page.evaluate(() => [...new Set(
          [...document.querySelectorAll("article.card:not(.compose) .vblock")]
            .map((b) => Math.round(b.getBoundingClientRect().height)))]);
        eq(hs.length, 1, `${t.type} grid blocks are not one height (${hs})`);
      }
      const fans = await page.evaluate(() => {
        const m = {};
        for (const w of document.querySelectorAll(".cardwrap")) {
          const a = w.querySelector("article.card[data-cid]");
          if (a) m[a.dataset.cid] = {
            fan: w.querySelectorAll("i.fan").length,
            based: w.querySelectorAll(".vin.based").length,
          };
        }
        return m;
      });
      const wantFan = (c) => Math.min(5, Math.max(1, (c.versions || []).length)) - 1;
      const badFan = cards.filter((c) => fans[c.id] &&
                                         fans[c.id].fan !== wantFan(c));
      eq(badFan.length, 0, `${t.type} fans disagree with the store: ` +
         badFan.slice(0, 3).map((c) =>
           `${c.id} drew ${fans[c.id].fan} want ${wantFan(c)}`).join(", "));
      const marked = cards.filter((c) => fans[c.id] && fans[c.id].based);
      eq(marked.length, 0, `${t.type} small cards carry a lineage mark again: ` +
         marked.slice(0, 3).map((c) => c.id).join(", "));
      log(`${cards.filter((c) => (c.versions || []).length > 1).length} stack(s)`);
      for (const c of cards) {
        for (const v of c.versions || []) {
          assert(/^v\d+$/.test(String(v.id)),
                 `${t.type} ${c.id}: version id ${v.id} is not vN`);
          for (const k of ["n", "created", "media", "parts"]) {
            assert(k in v, `${t.type} ${c.id} ${v.id}: no ${k}`);
          }
        }
      }
    }
    assert(!errs.length, "page errors: " + errs.slice(0, 3).join(" | "));
  });
}
