import { withPage, assert, eq, sleep, showTab, api } from "./lib.mjs";
const SHOTS = process.env.SHOTS;
export const name = "the open card's lanes — a heading where their section changes and a smaller one where their role does; a lane's ▶ with nothing playing starts a second before its own sound";

const ID = "fx0a1b2c3d4e";
const secs = (t) => { const m = /^(\d+):(\d+(?:\.\d+)?)$/.exec(t || ""); return m ? +m[1] * 60 + +m[2] : null; };
export async function run(log) {
  const c = await api(`/api/cards/${ID}`);
  const v = c.versions.at(-1), lanes = (v.parts || []).filter((p) => p.kind === "voice" && p.audio && !p.archived);
  assert(lanes.length >= 3 && v.duration > 8, `${ID}: three lanes, long enough`);
  // from outside: the lanes in two sections, the second with two roles; the last lane silent for its first 60 %
  const late = btoa(String.fromCharCode(...Array.from({ length: 200 }, (_, i) => (i < 120 ? 0 : 200))));
  const marks = [{ section: "intro" }, { section: "beat", role: "low" }, { section: "beat", role: "high", peaks: late }];
  const sectioned = (x) => ({ ...x, versions: (x.versions || []).map((y, k, all) => k < all.length - 1 ? y : ({
    ...y, parts: (y.parts || []).map((p) => { const i = lanes.findIndex((q) => q.id === p.id); return i >= 0 && marks[i] ? { ...p, ...marks[i] } : p; }) })) });
  await withPage(async (page, errs) => {
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    const got = [];
    await page.setRequestInterception(true);
    page.on("request", async (r) => {
      const u = new URL(r.url());
      if (u.pathname.startsWith("/media/")) got.push(u.pathname);
      if (r.method() === "GET" && u.pathname === `/api/cards/${ID}`)
        return r.respond({ status: 200, contentType: "application/json", body: JSON.stringify(sectioned(await api(u.pathname))) });
      if (r.method() === "GET" && u.pathname === "/api/cards" && u.searchParams.get("type") === "fx_music") {
        const res = await api(u.pathname + u.search);
        res.cards = res.cards.map((x) => (x.id === ID ? sectioned(x) : x));
        return r.respond({ status: 200, contentType: "application/json", body: JSON.stringify(res) });
      }
      if (r.method() === "GET" || r.method() === "HEAD") return r.continue();
      return r.respond({ status: 200, contentType: "application/json", body: "{}" });
    });
    await showTab(page, "fx_music");
    await page.evaluate((id) => { const a = document.querySelector(`.grid article.card[data-cid="${id}"]`);
      a.scrollIntoView({ block: "center" }); (a.querySelector(".media, .vblock") || a).click(); }, ID);
    await page.waitForSelector(".sheet.big:not([hidden]) .vblock .vrowc", { timeout: 10000 });
    await sleep(600);
    const heads = await page.$$eval(".sheet.big .vblock > .vrowc", (rs) => rs.slice(0, 3).map((r) => {
      const h = r.querySelector(":scope > .vhead");
      return h ? [...h.children].map((x) => `${x.tagName === "B" ? "#" : ""}${x.textContent}`).join(" ") : "";
    }));
    eq(JSON.stringify(heads), JSON.stringify(["#intro", "#beat low", "high"]), "a section heading where the section changes, a role's where the role does");
    // the headed rows still line their lanes up: one left edge for every lane
    const lefts = await page.$$eval(".sheet.big .vblock .lane", (ls) => [...new Set(ls.map((l) => Math.round(l.getBoundingClientRect().left)))]);
    eq(lefts.length, 1, `the lanes share one left edge: ${lefts}`);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/lane-sections.png` });
    // ▶ on the late lane, nothing playing: a second before its sound
    const solo = (i) => page.evaluate((i) => document.querySelectorAll(".sheet.big .vblock > .vrowc")[i]
      .querySelector("button.vc.big:not(.mute)").click(), i);
    await solo(2);
    await sleep(900);
    const at = secs(await page.$eval(".sheet.big .vblock .vline", (l) => l.dataset.t));
    const want = 0.6 * v.duration - 1;
    assert(got.some((g) => g.endsWith(new URL(lanes[2].audio, "http://x").pathname)), `it streams the lane: ${got.join(", ")}`);
    assert(at != null && at >= want - 0.3 && at <= want + 1.5, `it starts a second before the lane's sound (${want.toFixed(1)} s): at ${at}`);
    // stopped, then the first lane, which sounds from the top: from the top
    await solo(2);
    await sleep(300);
    await solo(0);
    await sleep(900);
    const at0 = secs(await page.$eval(".sheet.big .vblock .vline", (l) => l.dataset.t));
    assert(at0 != null && at0 < 1.5, `a lane that sounds from the top starts there: ${at0}`);
    assert(!errs.length, "page errors: " + errs.slice(0, 4).join(" | "));
    log(`headings ${JSON.stringify(heads)}, one lane edge; the late lane's ▶ at ${at} s (its sound at ${(0.6 * v.duration).toFixed(1)} s), the first lane's at ${at0} s`);
  });
}
