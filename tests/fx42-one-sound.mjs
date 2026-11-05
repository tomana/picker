import { withPage, assert, eq, sleep, api, showTab, scratchPicker } from "./lib.mjs";

export const name = "one sound at a time — the open card's player and the trim editor stop for each other and with the sheet";

const CARD = "fx0a1b2c3d4e";                 // a music card with lanes

// every media element the page gives a source or plays; a sound is one playing with its volume up
const SPY = () => {
  const P = HTMLMediaElement.prototype, play = P.play, src = Object.getOwnPropertyDescriptor(P, "src");
  const all = window.__all = new Set();
  P.play = function (...a) { all.add(this); return play.apply(this, a); };
  Object.defineProperty(P, "src", { ...src, set(v) { all.add(this); src.set.call(this, v); } });
  window.__sounds = () => [...all].filter((e) => !e.paused && !e.ended && e.volume > 0).map((e) => e.currentSrc);
  // the sheet's ✕ in the same tick as whatever came before it
  window.__shut = () => document.querySelector('.scrim[data-kind="big"]').click();
};

export async function run(log) {
  const { cards } = await api("/api/cards?type=music");
  const rec = cards.find((c) => c.origin?.kind === "recording" && (c.versions || []).length);
  assert(rec, "a recording card");
  const sp = await scratchPicker();
  try {
    await withPage(async (page, errs) => {
      await page.evaluateOnNewDocument(SPY);
      await sp.route(page, () => false);
      const sounds = () => page.evaluate(() => window.__sounds());
      const until = (what, fn, arg) => page.waitForFunction(fn, { timeout: 8000 }, arg)
        .catch(async () => { throw new Error(`${what}: ${JSON.stringify(await sounds())}`); });
      const open = async (id) => {
        await page.evaluate((i) => { const a = document.querySelector(`.grid article.card[data-cid="${i}"]`);
          a.scrollIntoView({ block: "center" }); (a.querySelector(".media, .vblock") || a).click(); }, id);
      };
      const shut = () => page.evaluate(() => window.__shut());
      // silent from a fade's length on, the whole time: a stray stream can end by itself when its file is made
      const quiet = async (what) => {
        const heard = await page.evaluate(() => new Promise((ok) => {
          const t0 = performance.now(), got = new Set();
          const iv = setInterval(() => {
            const t = performance.now() - t0;
            if (t > 120) for (const s of window.__sounds()) got.add(s);
            if (t > 1600) { clearInterval(iv); ok([...got]); }
          }, 20);
        }));
        eq(JSON.stringify(heard), "[]", what);
      };

      // the trim editor: it stops what plays when it starts, and it stops with the sheet
      await showTab(page, "music");
      await page.evaluate((id) => { const a = [...document.querySelectorAll(".grid article.card")].find((x) => x.dataset.cid !== id && x.querySelector(".vplay"));
        a.scrollIntoView({ block: "center" }); a.querySelector(".vplay").click(); }, rec.id);
      await until("a tile sounds", () => window.__sounds().length === 1);
      await open(rec.id);
      await page.waitForSelector(".sheet.big:not([hidden]) .tplaybtn", { timeout: 10000 });
      await page.$eval(".sheet.big .tplaybtn", (b) => b.click());
      await until("the trim editor sounds", (id) => window.__sounds().some((s) => s.includes(id)), rec.id);
      await sleep(300);
      eq((await sounds()).length, 1, "the tile stopped for the trim editor");
      await shut();
      await quiet("the trim editor stopped with the sheet");
      log("trim: the tile stops for it; it stops with the sheet");

      // the player: ▶ and ✕ at once: the start that is still loading is called off
      await showTab(page, "fx_music");
      await open(CARD);
      await page.waitForSelector(".sheet.big:not([hidden]) .np .np-row", { timeout: 10000 });
      await sleep(300);
      await page.evaluate(() => { document.querySelector(".sheet.big .np-play").click(); window.__shut(); });
      await quiet("▶ then ✕: nothing plays behind the closed sheet");
      log("player: ▶ then ✕ calls the start off");

      // the player: a pause while the next stream waits its turn: no sound is left that nothing can stop
      await open(CARD);
      await page.waitForSelector(".sheet.big:not([hidden]) .np .np-row", { timeout: 10000 });
      await sleep(200);
      await page.$eval(".sheet.big .np-play", (b) => b.click());
      await until("▶ sounds", () => window.__sounds().length >= 1);
      await sleep(500);
      const shutAt = await page.evaluate(() => new Promise((ok) => {
        document.querySelector(".sheet.big .np-mute").click();
        const t0 = performance.now();
        const iv = setInterval(() => {
          const ready = [...window.__all].find((e) => e.paused && e.volume === 0 && e.readyState >= 3 && e.src.includes("lanes="));
          // ready, and a little later: past its canplay, inside the wait for the live one to reach it
          if (ready) { clearInterval(iv); setTimeout(() => { window.__shut(); ok(Math.round(performance.now() - t0)); }, 60); }
          else if (performance.now() - t0 > 6000) { clearInterval(iv); ok(null); }
        }, 2);
      }));
      assert(shutAt != null, "the next stream was never ready and waiting");
      await quiet("a pause during the swap: no sound left over");
      log(`player: ✕ ${shutAt} ms after 🔊, while the next stream waited: silence`);

      // a sound after all that plays alone, and the sheet's player can take over a tile's card
      await page.evaluate((id) => { const a = document.querySelector(`.grid article.card[data-cid="${id}"]`);
        a.scrollIntoView({ block: "center" }); a.querySelector(".vplay").click(); }, CARD);
      await until("the tile sounds", () => window.__sounds().length === 1);
      await open(CARD);
      await page.waitForSelector(".sheet.big:not([hidden]) .np.playing", { timeout: 10000 });
      await sleep(500);
      eq((await sounds()).length, 1, "a tile's card goes on in the open card's player, one sound");
      await shut();
      await quiet("and stops with the sheet");
      log("handover: one sound, and it stops with the sheet");
      assert(!errs.length, `page errors: ${errs.join(" | ").slice(0, 300)}`);
    });
  } finally { sp.done(); }
}
