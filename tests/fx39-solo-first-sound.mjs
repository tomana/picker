import { withPage, assert, sleep, showTab, api } from "./lib.mjs";
export const name = "a band's ▶ with nothing playing — a second before the lane's own sound, not at the top of a stem silent until it comes in";

const ID = "fx0a1b2c3d4e";
const secs = (t) => { const m = /^(\d+):(\d+(?:\.\d+)?)$/.exec(t || ""); return m ? +m[1] * 60 + +m[2] : null; };
export async function run(log) {
  const c = await api(`/api/cards/${ID}`);
  const v = c.versions.at(-1), lanes = (v.parts || []).filter((p) => p.kind === "voice" && p.audio && !p.archived);
  assert(lanes.length >= 3 && v.duration > 8, `${ID}: three lanes, long enough`);
  // from outside: the third lane silent for its first 60 %
  const late = btoa(String.fromCharCode(...Array.from({ length: 200 }, (_, i) => (i < 120 ? 0 : 200))));
  const late3 = (x) => ({ ...x, versions: (x.versions || []).map((y, k, all) => k < all.length - 1 ? y : ({
    ...y, parts: (y.parts || []).map((p) => (p.id === lanes[2].id ? { ...p, peaks: late } : p)) })) });
  await withPage(async (page, errs) => {
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    const got = [];
    await page.setRequestInterception(true);
    page.on("request", async (r) => {
      const u = new URL(r.url());
      if (u.pathname.startsWith("/media/")) got.push(u.pathname);
      if (r.method() === "GET" && u.pathname === `/api/cards/${ID}`)
        return r.respond({ status: 200, contentType: "application/json", body: JSON.stringify(late3(await api(u.pathname))) });
      if (r.method() === "GET" && u.pathname === "/api/cards" && u.searchParams.get("type") === "fx_music") {
        const res = await api(u.pathname + u.search);
        res.cards = res.cards.map((x) => (x.id === ID ? late3(x) : x));
        return r.respond({ status: 200, contentType: "application/json", body: JSON.stringify(res) });
      }
      if (r.method() === "GET" || r.method() === "HEAD") return r.continue();
      return r.respond({ status: 200, contentType: "application/json", body: "{}" });
    });
    await showTab(page, "fx_music");
    await page.evaluate((id) => { const a = document.querySelector(`.grid article.card[data-cid="${id}"]`);
      a.scrollIntoView({ block: "center" }); (a.querySelector(".media, .vblock") || a).click(); }, ID);
    await page.waitForSelector(".sheet.big:not([hidden]) .np-row", { timeout: 10000 });
    await sleep(600);
    // ▶ on the late lane, nothing playing: a second before its sound
    const solo = (i) => page.evaluate((i) => document.querySelectorAll(".sheet.big .np-row")[i]
      .querySelector(".np-solo").click(), i);
    const head = () => page.$eval(".sheet.big .np-t", (e) => e.textContent);
    await solo(2);
    await sleep(900);
    const at = secs(await head());
    const want = 0.6 * v.duration - 1;
    assert(got.some((g) => g.endsWith(new URL(lanes[2].audio, "http://x").pathname)), `it streams the lane: ${got.join(", ")}`);
    assert(at != null && at >= want - 0.3 && at <= want + 1.5, `it starts a second before the lane's sound (${want.toFixed(1)} s): at ${at}`);
    // stopped and back at the top (the ruler's left end), then the first lane, which sounds from the top: from the top
    await solo(2);
    await sleep(300);
    const r = await page.$eval(".sheet.big .np-rcell", (e) => { const b = e.getBoundingClientRect(); return { x: b.left, y: b.top + b.height / 2 }; });
    await page.touchscreen.tap(r.x + 0.5, r.y);
    await sleep(300);
    await solo(0);
    await sleep(900);
    const at0 = secs(await head());
    assert(at0 != null && at0 < 1.5, `a lane that sounds from the top starts there: ${at0}`);
    assert(!errs.length, "page errors: " + errs.slice(0, 4).join(" | "));
    log(`the late lane's ▶ at ${at} s (its sound at ${(0.6 * v.duration).toFixed(1)} s), the first lane's at ${at0} s`);
  });
}
