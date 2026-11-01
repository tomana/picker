import { withPage, assert, eq, sleep, showTab, api } from "./lib.mjs";
export const name = "a long piece — its open card streams the mix (no lane decoded), a solo lane streams its file, a mute loads the lanes";

const ID = "fx0a1b2c3d4e";
export async function run(log) {
  const c = await api(`/api/cards/${ID}`);
  const v = c.versions.at(-1), lanes = (v.parts || []).filter((p) => p.kind === "voice" && p.audio && !p.archived);
  assert(lanes.length >= 2 && (v.media || {}).audio, `${ID}: lanes and a mix`);
  const longer = (x) => ({ ...x, versions: (x.versions || []).map((y) => ({ ...y, duration: 400 })) });   // seven minutes, as far as the page knows
  await withPage(async (page, errs) => {
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    const got = [];
    await page.setRequestInterception(true);
    page.on("request", async (r) => {
      const u = new URL(r.url());
      if (u.pathname.startsWith("/media/")) got.push(`${r.resourceType()} ${u.pathname}`);
      if (r.method() === "GET" && u.pathname === `/api/cards/${ID}`)
        return r.respond({ status: 200, contentType: "application/json", body: JSON.stringify(longer(await api(u.pathname))) });
      if (r.method() === "GET" && u.pathname === "/api/cards" && u.searchParams.get("type") === "fx_music") {
        const res = await api(u.pathname + u.search);
        res.cards = res.cards.map((x) => (x.id === ID ? longer(x) : x));
        return r.respond({ status: 200, contentType: "application/json", body: JSON.stringify(res) });
      }
      if (r.method() === "GET" || r.method() === "HEAD") return r.continue();
      return r.respond({ status: 200, contentType: "application/json", body: "{}" });
    });
    await showTab(page, "fx_music");
    await page.evaluate((id) => { const a = document.querySelector(`.grid article.card[data-cid="${id}"]`);
      a.scrollIntoView({ block: "center" }); (a.querySelector(".media, .vblock") || a).click(); }, ID);
    await page.waitForSelector(".sheet.big:not([hidden]) .vblock", { timeout: 10000 });
    await sleep(800);
    const laneFetched = () => got.filter((g) => g.startsWith("fetch ") && lanes.some((p) => g.endsWith(new URL(p.audio, "http://x").pathname)));
    eq(laneFetched().length, 0, "opening a long piece decodes no lane");
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
    await sleep(600);
    // a mute while the mix plays: the lanes, loaded then
    await page.$eval(".sheet.big .vblock button.vc.big.mute", (b) => b.click());
    await sleep(1200);
    assert(laneFetched().length >= lanes.length - 1, `a mute loads the lanes: ${got.join(", ")}`);
    assert(await page.evaluate(() => /long: its lanes take a moment/.test((document.querySelector(".ptoast") || {}).textContent || "")), "and says it takes a moment");
    assert(!errs.length, "page errors: " + errs.slice(0, 4).join(" | "));
    log(`open: no lane decoded; ▶ streamed the mix; solo streamed its lane; a mute loaded ${laneFetched().length} lanes`);
  });
}
