import { withPage, showTab, api, assert, eq, sleep } from "./lib.mjs";
const SHOTS = process.env.SHOTS;
export const name = "small card — its foot says which version is on show, the copy icon copies its id; a version voted down steps aside";
const json = (body) => ({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
export async function run(log) {
  const cards = (await api("/api/cards?type=fx_visual")).cards;
  const c = cards.find((x) => {
    const vs = x.versions || [];
    return vs.length >= 2 && (vs.at(-1).vote || 0) === 0 && vs.slice(0, -1).some((v) => (v.vote || 0) >= 0);
  });
  assert(c, "no visual card stack with an unvoted newest version");
  const vs = c.versions;
  let back = vs.length - 2;
  while ((vs[back].vote || 0) < 0) back--;
  const num = (i) => `v${vs[i].n ?? i + 1}`;
  await withPage(async (page, errs) => {
    const sent = [];
    page.on("request", async (r) => {
      const m = r.method(), p = new URL(r.url()).pathname;
      if (m === "GET" || m === "HEAD") return r.continue();
      sent.push(`${m} ${p} ${r.postData() || ""}`);
      if (p === `/api/cards/${c.id}/signal`) {
        const body = JSON.parse(r.postData() || "{}");
        const fresh = await api(`/api/cards/${c.id}`);
        const v = fresh.versions.find((x) => x.n === body.version);
        if (body.kind === "vote" && v) v.vote = body.value;
        return r.respond(json(fresh));
      }
      return r.respond(json({}));
    });
    await showTab(page, "fx_visual");
    const foot = () => page.evaluate((id) => {
      const a = document.querySelector(`.grid article.card[data-cid="${id}"]`);
      return a && { ref: a.querySelector(".cref").textContent, copy: !!a.querySelector(".cfoot .ccopy"),
                    ver: a.querySelector(".cfoot .cver")?.textContent };
    }, c.id);
    const before = await foot();
    assert(before && before.copy, `the small card has no copy icon: ${JSON.stringify(before)}`);
    eq(before.ver, num(vs.length - 1), "the number on the foot: the newest version");
    const step = async (dir) => {
      await page.evaluate((id, dir) => document.querySelector(`.grid article.card[data-cid="${id}"] .vnav.${dir}`).click(), c.id, dir);
      return (await foot()).ver;
    };
    eq(await step("prev"), num(vs.length - 2), "‹ steps the number with the picture");
    eq(await step("next"), num(vs.length - 1), "› steps it back");
    log(`the foot says ${before.ver}, ‹ ${num(vs.length - 2)}, › ${before.ver}`);
    await page.evaluate(() => { navigator.clipboard.writeText = async (t) => { window.__copied = t; }; });
    await page.evaluate((id) => {
      const a = document.querySelector(`.grid article.card[data-cid="${id}"]`);
      a.scrollIntoView({ block: "center" });
      a.querySelector(".ccopy").click();
    }, c.id);
    await sleep(400);
    eq(await page.evaluate(() => window.__copied), before.ref, "what the icon copied");
    eq(await page.evaluate(() => !!document.querySelector(".sheet.big:not([hidden])")), false,
       "the copy icon opened the card");
    log(`copy: ${before.ref} on the clipboard, the card stayed shut`);
    await page.evaluate((id) => {
      const a = document.querySelector(`.grid article.card[data-cid="${id}"]`);
      [...a.querySelectorAll(".cfoot .vcell, .cfoot button, .cfoot [role=button]")]
        .find((b) => b.textContent.trim().startsWith("−")).click();
    }, c.id);
    await sleep(900);
    const after = await foot();
    assert(sent.some((s) => s.includes('"kind":"vote"') && s.includes('"value":-1')),
           `no −1 vote was sent: ${sent.join(" | ")}`);
    assert(after.ref !== before.ref, `the voted-down version stayed on show: ${after.ref}`);
    eq(after.ver, num(back), "the number follows the version that stepped in");
    log(`− on ${before.ref}: the card now shows ${after.ref} (${after.ver}), without a reload`);
    // two columns on a phone: every number whole, between the id and the − +
    await page.setViewport({ width: 360, height: 800, deviceScaleFactor: 2 });
    await sleep(500);
    const bad = await page.$$eval(".grid article.card .cfoot", (fs) => fs.filter((f) => {
      const v = f.querySelector(".cver");
      if (!v) return false;
      const r = v.getBoundingClientRect(), id = f.querySelector(".ccopy").getBoundingClientRect(), vote = f.querySelector(".vcell").getBoundingClientRect();
      return r.left < id.right || r.right > vote.left || v.scrollWidth > Math.ceil(r.width);
    }).map((f) => f.textContent));
    eq(bad.join(" | "), "", "a number cut or in the way at 360 px");
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/small-card-version.png` });
    // a tab that names its cards: the version in the title, nothing beside it, whole at 360 px
    await showTab(page, "fx_music");
    await sleep(500);
    const named = await page.$$eval(".grid article.card .cfoot", (fs) => fs.map((f) => {
      const t = f.querySelector(".cref"), v = f.querySelector(".crefv");
      return { text: t.textContent, beside: !!f.querySelector(".cver"),
               whole: !!v && v.getBoundingClientRect().right <= f.querySelector(".ccopy").getBoundingClientRect().left + 1 };
    }).filter((n) => n.text.startsWith("m:")));
    assert(named.length, "no named cards on fx_music");
    eq(named.filter((n) => !/^m:[^:]+:v\d+$/.test(n.text) || n.beside || !n.whole).map((n) => n.text).join(" | "), "",
       "a named card's title without its version, or the version cut, at 360 px");
    log(`named: ${named.slice(0, 3).map((n) => n.text).join(", ")}`);
    if (SHOTS) {
      await page.evaluate(() => document.querySelector(".grid article.card .cfoot").scrollIntoView({ block: "center" }));
      await sleep(300);
      await page.screenshot({ path: `${SHOTS}/small-card-named.png` });
    }
    assert(!errs.length, "page errors: " + errs.slice(0, 3).join(" | "));
  });
}
