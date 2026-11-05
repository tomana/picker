import { withPage, assert, eq, sleep, showTab, api } from "./lib.mjs";
export const name = "the open card plays as a tile does — ▶ streams the mix, a lane's ▶ streams its file from where the mix was, a mute streams the lanes left; no lane decoded, and the playhead keeps going";

const ID = "fx0a1b2c3d4e";
const secs = (t) => { const m = /^(\d+):(\d+(?:\.\d+)?)$/.exec(t || ""); return m ? +m[1] * 60 + +m[2] : null; };
export async function run(log) {
  const c = await api(`/api/cards/${ID}`);
  const v = c.versions.at(-1), lanes = (v.parts || []).filter((p) => p.kind === "voice" && p.audio && !p.archived);
  assert(lanes.length >= 2 && (v.media || {}).audio, `${ID}: lanes and a mix`);
  await withPage(async (page, errs) => {
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    const got = [];
    await page.setRequestInterception(true);
    page.on("request", (r) => {
      const u = new URL(r.url());
      if (u.pathname.startsWith("/media/") || u.pathname.endsWith("/mix")) got.push(`${r.resourceType()} ${u.pathname}${u.search}`);
      if (r.method() === "GET" || r.method() === "HEAD") return r.continue();
      return r.respond({ status: 200, contentType: "application/json", body: "{}" });
    });
    await showTab(page, "fx_music");
    await page.evaluate((id) => { const a = document.querySelector(`.grid article.card[data-cid="${id}"]`);
      a.scrollIntoView({ block: "center" }); (a.querySelector(".media, .vblock") || a).click(); }, ID);
    await page.waitForSelector(".sheet.big:not([hidden]) .np-row", { timeout: 10000 });
    await sleep(800);
    const laneFetched = () => got.filter((g) => g.startsWith("fetch ") && lanes.some((p) => g.includes(new URL(p.audio, "http://x").pathname)));
    eq(laneFetched().length, 0, "opening the card decodes no lane");
    got.length = 0;
    await page.$eval(".sheet.big .np-play", (b) => b.click());
    await sleep(800);
    assert(got.some((g) => g.startsWith("media ") && g.includes(new URL(v.media.audio, "http://x").pathname)), `▶ streams the mix: ${got.join(", ")}`);
    const head = () => page.$eval(".sheet.big .np-t", (e) => e.textContent);
    await sleep(900);
    const tm = secs(await head());
    assert(tm >= 1, `the mix plays: ${tm}`);
    // a lane's ▶ streams its own file, from where the mix is
    got.length = 0;
    await page.$eval(".sheet.big .np-row .np-solo", (b) => b.click());
    await sleep(800);
    assert(got.some((g) => g.startsWith("media ") && g.includes(new URL(lanes[0].audio, "http://x").pathname)), `solo streams the lane: ${got.join(", ")}`);
    const ts = secs(await head());
    assert(ts >= tm, `the solo starts where the mix was (${tm} s), not at the top: ${ts} s`);
    // its ▶ again stops it where it is, and the main ▶ goes on with the mix from there
    await page.$eval(".sheet.big .np-row .np-solo", (b) => b.click());
    await sleep(300);
    assert(!(await page.$eval(".sheet.big .np", (e) => e.classList.contains("playing"))), "a lane's second ▶ stops it");
    const stopped = secs(await head());
    await page.$eval(".sheet.big .np-play", (b) => b.click());
    await sleep(900);
    const t0 = secs(await head());
    assert(t0 >= stopped, `the mix goes on from there (${stopped} s): ${t0}`);
    // a mute while the mix plays: a stream of the lanes left, the playhead going on
    got.length = 0;
    await page.$eval(".sheet.big .np-row .np-mute", (b) => b.click());
    const seen = [];
    for (let i = 0; i < 6; i++) { await sleep(250); seen.push(secs(await head())); }
    const named = got.filter((g) => g.startsWith("media ") && g.includes("/mix?")).map((g) => new URL(g.split(" ")[1], "http://x").searchParams.get("lanes"));
    assert(named.length && named.every((n) => !n.split(",").includes(lanes[0].id)), `a mute streams the lanes left: ${got.join(", ")}`);
    eq(laneFetched().length, 0, "a mute decodes no lane");
    assert(seen.every((t, i) => t != null && t >= (i ? seen[i - 1] : t0) - 0.5) && seen.at(-1) > t0, `the playhead keeps advancing across the mute: ${t0} → ${seen.join(" ")}`);
    assert(!errs.length, "page errors: " + errs.slice(0, 4).join(" | "));
    log(`▶ streamed the mix; a lane's ▶ at ${tm} s streamed its file from ${ts} s; a mute at ${t0} s streamed ${named.at(-1)}, the playhead ${seen.at(-1)} s`);
  });
}
