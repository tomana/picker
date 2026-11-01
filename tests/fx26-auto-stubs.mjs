import { withPage, api, assert, eq, sleep, BASE } from "./lib.mjs";
export const name = "AUTO rows of stubs — a made card whose row isn't fetched yet gets it, and its A/B strip draws";

export async function run(log) {
  // the fixture's AUTO tab is fx_music; its last card's version is given an A/B sound (and a still) from outside
  const { cards } = await api("/api/cards?type=fx_music");
  const last = cards.filter((c) => !c.archived).at(-1), v = (last.versions || []).at(-1);
  assert(cards.length >= 3 && v && v.media && v.media.audio, "fx_music's last card with a sound");
  const pic = (await api("/api/cards?type=fx_visual")).cards.find((c) => (c.media || {}).still);
  const still = pic.media.still;
  await withPage(async (page, errs) => {
    const asked = [];
    await page.setRequestInterception(true);
    page.on("request", async (r) => {
      const u = new URL(r.url());
      if (r.method() !== "GET" && r.method() !== "HEAD")
        return r.respond({ status: 200, contentType: "application/json", body: "{}" });
      if (u.pathname === "/api/auto/made")
        return r.respond({ status: 200, contentType: "application/json", body: JSON.stringify({
          made: [{ card: last.id, n: v.n, vid: v.id, label: last.label, ts: Date.now() / 1000 - 60, vote: 0,
                   audio: v.media.audio, still }], making: [], total: 1 }) });
      if (u.pathname === "/api/cards" && u.searchParams.get("type") === "fx_music") {
        if (u.searchParams.has("ids")) {
          asked.push(...u.searchParams.get("ids").split(","));
          const res = await (await fetch(BASE + u.pathname + u.search)).json();
          for (const c of res.cards) for (const x of c.versions || [])
            if (c.id === last.id && x.n === v.n) Object.assign(x, { ab_at: 1, ab_dur: 2, duration: 1,
                                                                    media: { ...x.media, ab: x.media.audio } });
          return r.respond({ status: 200, contentType: "application/json", body: JSON.stringify(res) });
        }
        if (u.searchParams.get("limit") === "24") {         // a first page of one, so the made card is a stub
          const res = await (await fetch(`${BASE}/api/cards?type=fx_music&limit=1`)).json();
          return r.respond({ status: 200, contentType: "application/json", body: JSON.stringify(res) });
        }
      }
      return r.continue();
    });
    await page.setViewport({ width: 412, height: 500, deviceScaleFactor: 2 });   // the made card's slot off screen
    await page.goto(BASE + "/?tab=fx_music", { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".card.compose.autop .phead-tog", { timeout: 30000 });
    if (!(await page.$(".card.compose.autop .phead.open"))) await page.click(".card.compose.autop .phead-tog");
    await page.waitForSelector(".card.compose.autop .aulog .auab", { timeout: 8000 })
      .catch((e) => { console.log("rows asked for:", asked.join(",")); throw e; });
    assert(asked.includes(last.id), `the made card's row was fetched: ${asked.join(",")}`);
    eq(await page.$$eval(".card.compose.autop .aulog .ausplit", (a) => a.length), 1, "the A/B split drawn");
    assert(!errs.length, "page errors: " + errs.slice(0, 4).join(" | "));
    log(`${last.id} came as a stub; the AUTO row fetched its row and drew its A/B strip`);
  });
}
