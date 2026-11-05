import { withPage, assert, eq, sleep, showTab, scratchPicker, settle } from "./lib.mjs";
export const name = "a version with a lane taken out streams the server's mix of the lanes left — no lane decoded, on a card and on a bundle's face item";

const CARDS = ["fx0a1b2c3d4e", "fx7a8b9c0d1e"];        // a music card; a bundle, its face item comp1
export async function run(log) {
  const sp = await scratchPicker();
  const said = [];
  try {
    for (const ID of CARDS) {
      const v0 = (await sp.call(`/api/cards/${ID}`)).json.versions.at(-1);
      const lanes = (v0.parts || []).filter((p) => p.kind === "voice" && p.audio && !p.archived);
      assert(lanes.length >= 2, `${ID}: two lanes or more`);
      // as the open card's 🗑 sends it: scoped to the version and item on a bundle
      const sig = (value) => ({ kind: "archive", voice: lanes[0].id, value,
                                ...(v0.face_item ? { version: v0.n, item: v0.face_item } : {}) });
      eq((await sp.call(`/api/cards/${ID}/signal`, { method: "POST", body: sig(true) })).status, 200, "the cut is written");
      try {
        const v = (await sp.call(`/api/cards/${ID}`)).json.versions.at(-1);
        const named = new URL(v.media.audio || "/", "http://x").searchParams.get("lanes") || "";
        assert(/\/mix\?/.test(v.media.audio || "") && named && !named.split(",").includes(lanes[0].id), `${ID}: a mix of the lanes left: ${v.media.audio}`);
        await withPage(async (page, errs) => {
          await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
          await sp.route(page, () => false);
          const got = [];
          page.on("request", (r) => {
            const u = new URL(r.url());
            if (u.pathname.startsWith("/media/") || u.pathname.endsWith("/mix")) got.push(`${r.resourceType()} ${u.pathname}`);
          });
          await showTab(page, "fx_music");
          await page.evaluate((id) => { const a = document.querySelector(`.grid article.card[data-cid="${id}"]`);
            a.scrollIntoView({ block: "center" }); (a.querySelector(".media, .vblock") || a).click(); }, ID);
          await page.waitForSelector(".sheet.big:not([hidden]) .np-row", { timeout: 10000 });
          await sleep(800);
          got.length = 0;
          await page.$eval(".sheet.big .vplay", (b) => b.click());
          await sleep(1500);
          const lane = got.filter((g) => g.startsWith("fetch ") && lanes.some((p) => g.endsWith(new URL(p.audio, "http://x").pathname)));
          assert(got.some((g) => g === `media /api/cards/${ID}/mix`), `${ID}: ▶ streams the cut mix: ${got.join(", ")}`);
          eq(lane.length, 0, `${ID}: ▶ decodes no lane`);
          assert(!errs.length, "page errors: " + errs.slice(0, 4).join(" | "));
          said.push(`${ID} streamed ${new URL(v.media.audio, "http://x").search.split("&k=")[0]}`);
        });
      } finally {
        await sp.call(`/api/cards/${ID}/signal`, { method: "POST", body: sig(false) });
      }
    }
  } finally {
    sp.done();
    await settle();
  }
  log(said.join("; "));
}
