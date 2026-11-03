import { withPage, assert, eq, sleep, api, BASE } from "./lib.mjs";
export const name = "the version row on a desktop — with many versions a mouse drags it and a wheel turns it, the drag selects nothing, a click still does";

const ID = "fxlat1";
export async function run(log) {
  const real = await api(`/api/cards/${ID}`);
  // forty versions, as far as the page knows: the card's own, again and again
  const many = (x) => {
    const vs = x.versions || [];
    return { ...x, versions: Array.from({ length: 40 }, (_, i) => ({ ...vs[i % vs.length], id: `${vs[i % vs.length].id}-${i}`, n: i + 1 })) };
  };
  await withPage(async (page, errs) => {
    await page.setViewport({ width: 1280, height: 800 });
    await page.setRequestInterception(true);
    page.on("request", async (r) => {
      const u = new URL(r.url());
      if (r.method() === "GET" && u.pathname === `/api/cards/${ID}`)
        return r.respond({ status: 200, contentType: "application/json", body: JSON.stringify(many(await api(u.pathname))) });
      if (r.method() === "GET" && u.pathname === "/api/cards" && u.searchParams.get("type") === real.type) {
        const res = await api(u.pathname + u.search);
        res.cards = res.cards.map((x) => (x.id === ID ? many(x) : x));
        return r.respond({ status: 200, contentType: "application/json", body: JSON.stringify(res) });
      }
      if (r.method() === "GET" || r.method() === "HEAD") return r.continue();
      return r.respond({ status: 200, contentType: "application/json", body: "{}" });
    });
    await page.goto(`${BASE}/?tab=${real.type}&card=${ID}`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".sheet.big:not([hidden]) .vrow .vpip", { timeout: 30000 });
    await sleep(800);
    const row = () => page.$eval(".sheet.big .vrow", (r) => {
      const b = r.getBoundingClientRect();
      return { left: Math.round(r.scrollLeft), over: r.scrollWidth - r.clientWidth, on: (r.querySelector(".vpip.on") || {}).textContent,
               x: b.left + b.width / 2, y: b.top + b.height / 2 };
    });
    const a = await row();
    assert(a.over > 300, `the row overflows: ${JSON.stringify(a)}`);
    // a drag to the right: the row follows, nothing is selected
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    await page.mouse.move(a.x + 120, a.y, { steps: 6 });
    await page.mouse.move(a.x + 240, a.y, { steps: 6 });
    await page.mouse.up();
    await sleep(300);
    const b = await row();
    assert(Math.abs((a.left - b.left) - 240) <= 12, `the drag moved the row 240 px: ${a.left} → ${b.left}`);
    eq(b.on, a.on, "the drag selected no version");
    // a wheel over it turns it
    await page.mouse.wheel({ deltaY: -200 });
    await sleep(300);
    const w = await row();
    assert(w.left < b.left - 100, `the wheel turned the row: ${b.left} → ${w.left}`);
    // a click still picks a version
    const pip = await page.$$eval(".sheet.big .vrow .vpip", (ps) => {
      const r = ps[0].parentElement.getBoundingClientRect();
      const p = ps.find((x) => !x.classList.contains("on") && x.getBoundingClientRect().left > r.left + 40
                               && x.getBoundingClientRect().right < r.right - 40);
      const q = p.getBoundingClientRect();
      return { t: p.textContent, x: q.left + q.width / 2, y: q.top + q.height / 2 };
    });
    await page.mouse.click(pip.x, pip.y);
    await sleep(500);
    eq((await row()).on, pip.t, "a click picks its version");
    assert(!errs.length, "page errors: " + errs.slice(0, 4).join(" | "));
    log(`40 versions, ${a.over} px over: a drag moved it ${a.left} → ${b.left} (${a.on} still on), the wheel → ${w.left}, a click picked ${pip.t}`);
  });
}
