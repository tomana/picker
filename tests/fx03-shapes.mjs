import { withPage, assert, eq, sleep, BASE, api, showTab } from "./lib.mjs";
export const name = "fixture — the hard shapes: a bundle's scoped cut, a hidden version, sparse ids, no parts, links";
const served = async (url, min = 200) => {
  const r = await fetch(BASE + url);
  const n = (await r.arrayBuffer()).byteLength;
  assert(r.ok && n >= min, `${url}: ${r.status}, ${n} B`);
  return { type: r.headers.get("content-type"), n };
};
export async function run(log) {
  const b = await api("/api/cards/fx7a8b9c0d1e");
  const v = b.versions[0];
  const item = (id) => v.items.find((i) => i.id === id);
  const kick = (parts) => parts.find((p) => p.id === "kick");
  eq(v.items.map((i) => i.id).join(" "), "trans comp1", "the bundle's items");
  eq(kick(item("comp1").parts).archived, true, "comp1's kick, cut");
  assert(!kick(item("trans").parts).archived, "trans's kick is another instrument: not cut");
  eq(kick(v.parts).archived, true, "the version's parts are its face item's (comp1): its kick cut too");
  const cut = await served(v.media.audio, 1000);
  log(`bundle: comp1's kick cut, trans's not; the version's cut mix served (${cut.n} B)`);
  const c = await api("/api/cards/fx2c3d4e5f60");
  eq(c.versions[1].parts.find((p) => p.id === "v2_click").archived, true, "v2_click cut across the card");
  const h = await api("/api/cards/fx0a1b2c3d4e");
  eq(h.versions.map((x) => x.id).join(" "), "v1 v2", "the stack without the held v3");
  eq((h.held || []).map((x) => x.id).join(" "), "v3", "v3 kept out, beside it");
  const rows = (await api("/api/cards?type=fx_music")).cards;
  const hr = rows.find((x) => x.id === "fx0a1b2c3d4e"), br = rows.find((x) => x.id === "fx7a8b9c0d1e");
  assert(hr && br, "the held stack and the bundle are on fx_music's list");
  assert(hr.small && br.small, "a list row says it is small");
  assert(!("held" in hr), "a list row has no held versions");
  assert(rows.every((x) => !(x.versions || []).some((v) => "rationale" in v || "params_doc" in v)
                          && !("rationale" in (x.narrative || {}))), "a list row has no rationale, no params_doc");
  eq(br.versions[0].items.map((i) => i.id).join(" "), "trans comp1", "a list row's bundle keeps its items");
  assert(br.versions[0].items.every((i) => !("parts" in i)), "a list row's items are without their voices");
  assert(!("small" in b), "the whole card isn't small");
  const p1 = await api("/api/cards?type=fx_music&limit=2"), p2 = await api("/api/cards?type=fx_music&skip=2");
  eq(p1.cards.length, 2, "the first page's size");
  eq(p1.more, rows.length - 2, "the first page says how many are left");
  eq([...p1.cards, ...p2.cards].map((x) => x.id).join(" "), rows.map((x) => x.id).join(" "), "the two pages, the list");
  eq(p2.more, 0, "nothing after the rest");
  log(`the list's rows small; paged ${p1.cards.length} + ${p2.cards.length}`);
  const s = await api("/api/cards/fxspr1");
  eq(s.versions.map((x) => `${x.n}:${x.id}`).join(" "), "2:v2 5:v5", "the sparse stack's versions");
  await served(s.versions[1].media.still, 500);
  const t = await api("/api/cards/fxshw1");
  eq(t.versions[0].parts.length, 0, "the timeline card's parts");
  const vid = await served(t.versions[0].media.video, 1000);
  assert(/video\/mp4/.test(vid.type || ""), `the video's type: ${vid.type}`);
  await served(t.media.poster, 500);
  const l = await api("/api/cards/fxlnk1");
  await served(l.versions[0].media.still, 500);
  log("a cut across a card; v3 hidden; v2/v5 sparse; the timeline's video; fxlnk1 served through its links");
  await withPage(async (page, errs) => {
    for (const [type, cid] of [["fx_music", "fx7a8b9c0d1e"], ["fx_music", "fx0a1b2c3d4e"], ["fx_visual", "fxspr1"],
                               ["fx_show", "fxshw1"], ["fx_visual", "fxlnk1"]]) {
      await showTab(page, type);
      const opened = await page.evaluate((cid) => {
        const a = document.querySelector(`.grid article.card[data-cid="${cid}"]`);
        if (!a) return false;
        a.scrollIntoView({ block: "center" });
        (a.querySelector(".media, .vblock") || a).click();
        return true;
      }, cid);
      assert(opened, `${cid} is on the ${type} grid`);
      await page.waitForSelector(".sheet.big", { timeout: 10000 });
      await sleep(500);
      await page.keyboard.press("Escape");
      await sleep(300);
    }
    assert(!errs.length, "page errors: " + errs.slice(0, 4).join(" | "));
    log("the page: all five opened with no error");
  }, { writes: true });
}
