import { withPage, assert, eq, sleep, showTab, api } from "./lib.mjs";
export const name = "the open card plays as a tile does — ▶ streams the mix (no lane decoded), a solo lane streams its file, a mute loads the lanes while the mix plays on, and they take over from where it was";

const ID = "fx0a1b2c3d4e";
const secs = (t) => { const m = /^(\d+):(\d+(?:\.\d+)?)$/.exec(t || ""); return m ? +m[1] * 60 + +m[2] : null; };
export async function run(log) {
  const c = await api(`/api/cards/${ID}`);
  const v = c.versions.at(-1), lanes = (v.parts || []).filter((p) => p.kind === "voice" && p.audio && !p.archived);
  assert(lanes.length >= 2 && (v.media || {}).audio, `${ID}: lanes and a mix`);
  await withPage(async (page, errs) => {
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    // where each decoded lane starts: the page's own AudioBufferSourceNode.start, seen from outside
    await page.evaluateOnNewDocument(() => {
      window.__starts = [];
      const start = AudioBufferSourceNode.prototype.start;
      AudioBufferSourceNode.prototype.start = function (when, offset, ...rest) {
        window.__starts.push(offset || 0);
        return start.call(this, when, offset, ...rest);
      };
    });
    const got = [];
    await page.setRequestInterception(true);
    page.on("request", (r) => {
      const u = new URL(r.url());
      if (u.pathname.startsWith("/media/")) got.push(`${r.resourceType()} ${u.pathname}`);
      if (r.method() === "GET" || r.method() === "HEAD") return r.continue();
      return r.respond({ status: 200, contentType: "application/json", body: "{}" });
    });
    await showTab(page, "fx_music");
    await page.evaluate((id) => { const a = document.querySelector(`.grid article.card[data-cid="${id}"]`);
      a.scrollIntoView({ block: "center" }); (a.querySelector(".media, .vblock") || a).click(); }, ID);
    await page.waitForSelector(".sheet.big:not([hidden]) .vblock", { timeout: 10000 });
    await sleep(800);
    const laneFetched = () => got.filter((g) => g.startsWith("fetch ") && lanes.some((p) => g.endsWith(new URL(p.audio, "http://x").pathname)));
    eq(laneFetched().length, 0, "opening the card decodes no lane");
    got.length = 0;
    await page.$eval(".sheet.big .vplay", (b) => b.click());
    await sleep(800);
    assert(got.some((g) => g.startsWith("media ") && g.endsWith(new URL(v.media.audio, "http://x").pathname)), `▶ streams the mix: ${got.join(", ")}`);
    eq(laneFetched().length, 0, "▶ decodes no lane");
    // a solo lane streams its own file
    got.length = 0;
    await page.$eval(".sheet.big .vblock button.vc.big[title='play this band alone']", (b) => b.click());
    await sleep(800);
    assert(got.some((g) => g.startsWith("media ") && g.endsWith(new URL(lanes[0].audio, "http://x").pathname)), `solo streams the lane: ${got.join(", ")}`);
    eq(laneFetched().length, 0, "solo decodes no lane");
    await page.$eval(".sheet.big .vplay", (b) => b.click());           // the whole mix again
    await sleep(1500);
    // a mute while the mix plays: the lanes load, then take over from where the mix is
    const head = () => page.evaluate(() => (document.querySelector(".sheet.big .vblock .vline") || { dataset: {} }).dataset.t);
    const t0 = secs(await head());
    assert(t0 >= 1, `the mix plays: ${t0}`);
    await page.$eval(".sheet.big .vblock button.vc.big.mute", (b) => b.click());
    assert(await page.evaluate(() => /loading the lanes/.test((document.querySelector(".ptoast") || {}).textContent || "")), "a mute says the lanes are loading");
    const seen = [];
    for (let i = 0; i < 8; i++) { await sleep(250); seen.push(secs(await head())); }
    assert(laneFetched().length >= lanes.length - 1, `a mute loads the lanes: ${got.join(", ")}`);
    const starts = await page.evaluate(() => window.__starts);
    assert(starts.length >= lanes.length - 1, `the lanes took over: ${JSON.stringify(starts)}`);
    assert(starts.every((s) => s >= t0 - 0.2 && s <= t0 + 1.5), `from where the mix was (${t0} s), not the start: ${JSON.stringify(starts)}`);
    assert(seen.every((t, i) => t != null && t >= (i ? seen[i - 1] : t0)) && seen.at(-1) > t0 + 1.2,
           `the playhead keeps advancing across the mute: ${t0} → ${seen.join(" ")}`);
    assert(!errs.length, "page errors: " + errs.slice(0, 4).join(" | "));
    log(`open: no lane decoded; ▶ streamed the mix; solo streamed its lane; a mute at ${t0} s loaded ${laneFetched().length} lanes, they started at ${starts.map((s) => s.toFixed(2)).join("/")} s; the playhead ${seen.join(" ")}`);
  });
}
