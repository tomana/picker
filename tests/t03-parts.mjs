import { withPage, showTab, ensurePanel, scratchArrangement, scratchPicker, openTab, api,
         assert, eq, sleep } from "./lib.mjs";
export const name = "parts — ＋ appends, ✕ names the part, the open card scrolls";
async function openBiggest(page) {
  const bundles = ((await api("/api/cards?type=fx_music")).cards || [])
    .filter((c) => (c.versions || []).some((v) => (v.items || []).length)).map((c) => c.id);
  const cid = await page.evaluate((skip) => {
    const cards = [...document.querySelectorAll("article.card:not(.compose)")]
      .filter((c) => !skip.includes(c.dataset.cid));
    let best = cards[0], n = -1;
    for (const c of cards) {
      const k = c.querySelectorAll(".lane").length;
      if (k > n) { n = k; best = c; }
    }
    best.scrollIntoView({ block: "center" });
    (best.querySelector(".cmedia, .vblock") || best).click();
    return best.dataset.cid || null;
  }, bundles);
  await sleep(1100);
  return cid;
}
async function voiceVotes(cid) {
  const m = new Map();
  for (const v of (await api(`/api/cards/${cid}`)).versions || [])
    for (const p of v.parts || []) if (!m.has(p.id)) m.set(p.id, p.vote || 0);
  return m;
}
export async function run(log) {
  const sp = await scratchPicker();
  const scratch = await scratchArrangement("fx_music", 2, sp).catch((e) => { sp.done(); throw e; });
  let opened = null, was = null;
  const signals = [];
  try {
    await withPage(async (page, errs) => {
      await page.setRequestInterception(true);
      page.on("request", (r) => {
        const path = new URL(r.url()).pathname;
        if (path.startsWith("/api/arrangements")) return sp.forward(r);
        if (r.method() === "GET") return r.continue();
        const m = /^\/api\/cards\/([^/]+)\/signal$/.exec(path);
        if (!m) return r.respond({ status: 200, contentType: "application/json", body: "{}" });
        const b = JSON.parse(r.postData() || "{}");
        signals.push({ card: decodeURIComponent(m[1]), ...b });
        api(`/api/cards/${m[1]}`).then((card) => {
          r.respond({ status: 200, contentType: "application/json", body: JSON.stringify(card) });
        }, (e) => r.respond({ status: 500, contentType: "text/plain", body: String(e) }));
      });
      await showTab(page, "fx_music");
      await ensurePanel(page, "timelines");
      assert(await openTab(page, "__test"), "the scratch tab is not in the tab bar");
      const before = await page.evaluate(() => document.querySelectorAll(".tl-clip").length);
      opened = await openBiggest(page);
      assert(opened, "the opened card has no id");
      was = await voiceVotes(opened);
      const rows = await page.evaluate(() => document.querySelectorAll(".sheet .vrowc").length);
      assert(rows > 0, "the open card drew no voice rows");
      const scroll = await page.evaluate(() => {
        const sc = document.querySelector(".sheet .vscroll");
        const pb = document.querySelector(".sheet .vplay").getBoundingClientRect();
        sc.scrollTop = sc.scrollHeight;
        const after = document.querySelector(".sheet .vplay").getBoundingClientRect();
        const last = [...document.querySelectorAll(".sheet .vrowc")].pop()
          .getBoundingClientRect();
        return { scrollable: sc.scrollHeight > sc.clientHeight + 1,
                 buttonHeld: Math.abs(after.bottom - pb.bottom) < 1,
                 lastRowClear: last.bottom < after.top || last.right < after.left };
      });
      assert(scroll.buttonHeld, "the play button scrolled away with the lanes");
      assert(scroll.lastRowClear, "the last row is still under the play button");
      log(`${rows} rows, scrollable=${scroll.scrollable}, button held its corner`);
      const row0 = await page.evaluate(() =>
        [...document.querySelectorAll(".sheet .vrowc")][0].querySelectorAll(".vc").length);
      eq(row0, 6, "a voice row should have six controls");
      await page.evaluate(() => {
        document.querySelectorAll(".sheet .vrowc")[0].querySelector('.vc[title="take this band out of the mix"]').click();
      });
      await sleep(900);
      const sent = signals.find((x) => x.kind === "archive");
      assert(sent && sent.card === opened && sent.voice && sent.value === true,
             `the ✕ sent: ${JSON.stringify(signals)}`);
      assert(was.has(sent.voice), `the ✕ names ${sent.voice}, not one of the card's parts`);
      log(`✕ named ${sent.voice} (answered in the page)`);
      await page.evaluate(() => {
        document.querySelectorAll(".sheet .vrowc")[0]
          .querySelector('.vc[title="add this band to the timeline"]').click();
      });
      await sleep(1600);
      const after = (await sp.call(`/api/arrangements/${scratch.id}`)).json.clips.length;
      log(`＋ took the clips from ${before} to ${after}`);
      eq(after, before + 1, "＋ did not append a clip");
      assert(!errs.length, "page errors: " + errs.slice(0, 3).join(" | "));
    }, { width: 1200, height: 1000, dpr: 1 });
  } finally {
    sp.done();
  }
}
