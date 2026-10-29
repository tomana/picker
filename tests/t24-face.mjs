import { withPage, showTab, api, assert, eq, sleep, BASE } from "./lib.mjs";
export const name = "face — a card's chosen picture shows in the grid at once, also after a reload";
const json = (body) => ({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
async function faced(id, slug) {
  const c = await api(`/api/cards/${id}`);
  for (const v of c.versions || []) {
    const m = v.media || {};
    const pick = (m.views || []).find((x) => x.slug === slug);
    if (!pick) continue;
    if (pick.still) m.still = pick.still;
    if (pick.gif) m.gif = pick.gif;
    for (const x of m.views) x.face = x === pick;
  }
  const last = c.versions.at(-1).media;
  c.media = { ...c.media, still: last.still, gif: last.gif };
  c.face = slug;
  return c;
}
export async function run(log) {
  const cards = (await api("/api/cards?type=fx_visual")).cards;
  const shownOf = (x) => {
    const vs = x.versions || [];
    for (let i = vs.length - 1; i >= 0; i--) if ((vs[i].vote || 0) >= 0) return vs[i];
    return vs.at(-1);
  };
  const c = cards.find((x) => ((shownOf(x)?.media || {}).views || []).length >= 2);
  assert(c, "no card with two renders");
  const views = shownOf(c).media.views;
  const now = new URL(BASE + shownOf(c).media.still).pathname;
  const a = views.findIndex((v) => new URL(BASE + v.still).pathname !== now);
  assert(a >= 0, `every render of ${c.id} is its picture now`);
  await withPage(async (page, errs) => {
    let stamps = 0, reloads = 0;
    const sent = [];
    page.on("request", async (r) => {
      const m = r.method(), p = new URL(r.url()).pathname;
      if (p === "/api/cards/stamp") return r.respond(json({ stamp: `t24-${++stamps}` }));
      if (m === "GET" && p === "/api/cards") reloads++;
      if (m === "GET" || m === "HEAD") return r.continue();
      sent.push(`${m} ${p} ${r.postData() || ""}`);
      if (p === `/api/cards/${c.id}/signal`) {
        const body = JSON.parse(r.postData() || "{}");
        if (body.kind === "face") return r.respond(json(await faced(c.id, body.value)));
      }
      return r.respond(json({}));
    });
    await showTab(page, "fx_visual");
    const gridStill = () => page.evaluate((id) => {
      const i = [...document.querySelectorAll(".grid img.still")].find((x) => x.alt === id);
      return i ? new URL(i.src).pathname : null;
    }, c.id);
    const open = () => page.evaluate((id) => {
      const i = [...document.querySelectorAll(".grid img.still")].find((x) => x.alt === id);
      i.scrollIntoView({ block: "center" });
      i.closest(".media").click();
    }, c.id);
    const hold = async (i) => {
      const th = (await page.$$(".sheet.big .vthumb"))[i];
      assert(th, `the open card has no thumbnail ${i}`);
      const bb = await th.boundingBox();
      await page.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2);
      await page.mouse.down();
      await sleep(800);
      await page.mouse.up();
      await sleep(900);
    };
    eq(await gridStill(), now, "the grid's picture before");
    await open();
    await sleep(1200);
    await hold(a);
    const one = await gridStill();
    assert(one && one === new URL(BASE + views[a].still).pathname,
           `the grid kept ${one} after ${views[a].slug} became the picture`);
    log(`${c.id}: ${views[a].slug} chosen, the grid shows it at once`);
    await page.keyboard.press("Escape");
    await sleep(600);
    await open();
    const r0 = reloads, t0 = Date.now();
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange", { bubbles: true })));
    while (reloads === r0 && Date.now() - t0 < 10000) await sleep(300);
    assert(reloads > r0, "the store look did not reload the grid");
    await sleep(800);
    const shown = await gridStill();
    const b = views.findIndex((v) => new URL(BASE + v.still).pathname !== shown);
    assert(b >= 0, `every render is the grid's picture ${shown}`);
    await hold(b);
    const two = await gridStill();
    assert(two && two === new URL(BASE + views[b].still).pathname,
           `after a reload the grid kept ${two} when ${views[b].slug} became the picture`);
    log(`the grid reloaded while it was open; ${views[b].slug} chosen, the grid shows it at once`);
    eq(sent.filter((s) => s.includes("/signal")).length, 2, `two face signals: ${sent.join(" | ")}`);
    assert(!errs.length, "page errors: " + errs.slice(0, 3).join(" | "));
  });
}
