import { withPage, assert, eq, sleep, showTab } from "./lib.mjs";
export const name = "download — a press shows a grey square; the browser's own download, the button spinning until the file is made";

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
}
