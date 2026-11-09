import { withPage, assert, eq, sleep, showTab, api, BASE } from "./lib.mjs";
export const name = "download — a press shows a grey square; the browser's own download, the button spinning until the file is made; a card with loops and no sound downloads the loop, the view on screen's own";

export async function run(log) {
  await withPage(async (page, errs) => {
    const asked = [];
    await page.setRequestInterception(true);
    page.on("request", async (r) => {
      const u = new URL(r.url());
      if (r.method() === "GET" && /^\/api\/cards\/[^/]+\/download$/.test(u.pathname)) {
        asked.push(u.searchParams.get("token"));
        await sleep(1500);                                   // the server making the file
        return r.respond({ status: 200, contentType: "audio/mp4", body: "m4a",
                           headers: { "Content-Disposition": "attachment; filename=made.m4a",
                                      "Set-Cookie": `dl_${u.searchParams.get("token")}=1; Max-Age=120; Path=/` } });
      }
      if (r.method() === "GET" || r.method() === "HEAD") return r.continue();
      return r.respond({ status: 200, contentType: "application/json", body: "{}" });
    });
    await showTab(page, "fx_music");
    const opened = await page.evaluate(() => {
      const a = document.querySelector('.grid article.card[data-cid="fx2c3d4e5f60"]');
      if (!a) return false;
      a.scrollIntoView({ block: "center" });
      (a.querySelector(".media, .vblock") || a).click();
      return true;
    });
    assert(opened, "fx2c3d4e5f60 is on the grid");
    await page.waitForSelector(".sheet.big .cutil button[title^='download as .m4a']", { timeout: 10000 });
    const sel = ".sheet.big .cutil button[title^='download as .m4a']";
    const box = await (await page.$(sel)).boundingBox();
    const bg = () => page.$eval(sel, (b) => getComputedStyle(b).backgroundColor);
    const rest = await bg();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    const pressed = await bg();
    eq(pressed, "rgb(58, 58, 58)", `pressed, a grey square (at rest ${rest})`);
    await page.mouse.up();
    await sleep(300);
    const busy = await page.$eval(sel, (b) => ({ busy: b.classList.contains("busy"),
      spin: getComputedStyle(b, "::after").animationName, icon: getComputedStyle(b.firstElementChild).visibility }));
    eq(JSON.stringify(busy), JSON.stringify({ busy: true, spin: "uspin", icon: "hidden" }), "while it's made: the spinner");
    await page.waitForFunction((s) => !document.querySelector(s).classList.contains("busy"), { timeout: 8000 }, sel);
    eq(asked.length, 1, "one request: the link's");
    assert(/^[a-z0-9]{1,16}$/.test(asked[0] || ""), `it names a token: ${asked[0]}`);
    eq(await page.evaluate(() => document.cookie.includes("dl_")), false, "the page clears the cookie");
    assert(!errs.length, "page errors: " + errs.slice(0, 4).join(" | "));
    log(`press ${pressed} (rest ${rest}); the link's download; the spinner until its cookie says the file is made`);
  });

  // a card with loops and no sound: the same button, for the shown version's loop (loops given from outside, as fx45)
  const cards = (await api("/api/cards?type=fx_visual")).cards;
  assert(cards.some((c) => c.id === "fxlat1"), "fxlat1 is on the visual tab");
  const slugs = (((cards.find((c) => c.id === "fxvws1") || {}).versions || [])[0]?.media?.views || []).map((w) => w.slug);
  eq(slugs.length, 2, "fxvws1 has two renders");
  const withLoop = (x) => Array.isArray(x) ? x.map(withLoop) : !x || typeof x !== "object" ? x
    : Object.fromEntries(Object.entries(x).map(([k, v]) => [k, k === "media" && v && v.still ? { ...v, loop: "/zz/l.mp4",
        ...(v.views ? { views: v.views.map((w) => ({ ...w, loop: "/zz/l.mp4" })) } : {}) } : withLoop(v)]));
  await withPage(async (page, errs) => {
    const asked = [];
    await page.setRequestInterception(true);
    page.on("request", async (r) => {
      const u = new URL(r.url()), get = r.method() === "GET";
      if (get && /^\/api\/cards\/[^/]+\/download$/.test(u.pathname)) {
        asked.push({ card: u.pathname.split("/")[3], version: u.searchParams.get("version"), view: u.searchParams.get("view"),
                     token: u.searchParams.get("token") });
        return r.respond({ status: 200, contentType: "video/mp4", body: "mp4",
                           headers: { "Content-Disposition": "attachment; filename=made.mp4",
                                      "Set-Cookie": `dl_${u.searchParams.get("token")}=1; Max-Age=120; Path=/` } });
      }
      if (u.pathname === "/zz/l.mp4") return r.respond({ status: 404, body: "" });
      if (get && u.pathname.startsWith("/api/cards")) {
        const res = await fetch(BASE + u.pathname + u.search);
        return r.respond({ status: res.status, contentType: "application/json", body: JSON.stringify(withLoop(await res.json())) });
      }
      return get || r.method() === "HEAD" ? r.continue() : r.respond({ status: 200, contentType: "application/json", body: "{}" });
    });
    await showTab(page, "fx_visual");
    const opened = await page.evaluate(() => {
      const a = document.querySelector('.grid article.card[data-cid="fxlat1"]');
      if (!a) return false;
      a.scrollIntoView({ block: "center" });
      (a.querySelector(".media") || a).click();
      return true;
    });
    assert(opened, "fxlat1 is on the grid");
    const sel = ".sheet.big .cutil button[title^='download as .mp4']";
    await page.waitForSelector(sel, { timeout: 10000 });
    await page.$eval(sel, (b) => b.click());
    await page.waitForFunction((s) => !document.querySelector(s).classList.contains("busy"), { timeout: 8000 }, sel);
    eq(asked.length, 1, "one request: the link's");
    eq(asked[0].card, "fxlat1", "for the open card");
    assert(/^\d+$/.test(asked[0].version || ""), `the shown version: ${asked[0].version}`);
    eq(asked[0].view, null, "one render: no view named");

    // a card of two renders: the one picked on screen, not its face
    await page.evaluate(() => document.querySelector('.scrim[data-kind="big"]').click());
    await page.waitForSelector(".sheet.big", { hidden: true });
    await page.evaluate(() => { const a = document.querySelector('.grid article.card[data-cid="fxvws1"]');
      a.scrollIntoView({ block: "center" }); a.querySelector(".media").click(); });
    await page.waitForSelector(".sheet.big .vthumb.on", { timeout: 10000 });
    const other = await page.$$eval(".sheet.big .vthumb", (bs) => bs.findIndex((b) => !b.classList.contains("on")));
    await page.$$eval(".sheet.big .vthumb", (bs, i) => bs[i].click(), other);
    await page.waitForFunction((i) => document.querySelectorAll(".sheet.big .vthumb")[i].classList.contains("on"), {}, other);
    await page.click(sel);                               // a tap: Chrome lets only a tapped second download through
    await page.waitForFunction((s) => !document.querySelector(s).classList.contains("busy"), { timeout: 8000 }, sel);
    eq(asked.length, 2, "and its request");
    eq(JSON.stringify([asked[1].card, asked[1].view]), JSON.stringify(["fxvws1", slugs[other]]), "the render on screen");
    assert(!errs.filter((e) => !/404|l\.mp4/.test(e)).length, "page errors: " + errs.slice(0, 4).join(" | "));
    log(`a loop card's button downloads its version's loop (v${asked[0].version}); fxvws1's the picked render's (${asked[1].view})`);
  });
}
