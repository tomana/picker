import { withPage, showTab, api, assert, eq, sleep } from "./lib.mjs";
export const name = "small card — the copy icon copies its id; a version voted down steps aside";
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
      return a && { ref: a.querySelector(".cref").textContent, copy: !!a.querySelector(".cfoot .ccopy") };
    }, c.id);
    const before = await foot();
    assert(before && before.copy, `the small card has no copy icon: ${JSON.stringify(before)}`);
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
    log(`− on ${before.ref}: the card now shows ${after.ref} (v${vs[back].n ?? back + 1}), without a reload`);
    assert(!errs.length, "page errors: " + errs.slice(0, 3).join(" | "));
  });
}
