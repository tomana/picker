import { withPage, showTab, api, assert, eq, sleep } from "./lib.mjs";
export const name = "versions — a pip shows its own picture and words";
export async function run(log) {
  const { cards } = await api("/api/cards?type=fx_visual");
  const c = cards.find((x) => !x.archived && (x.versions || []).length >= 2
    && x.versions.every((v) => v.media && v.media.still)
    && new Set(x.versions.map((v) => v.media.still)).size === x.versions.length);
  assert(c, "no live card with several distinct versions");
  await withPage(async (page, errs) => {
    await showTab(page, "fx_visual");
    await page.waitForSelector(".cardwrap", { timeout: 20000 });
    const stepped = await page.evaluate((id) => {
      const w = [...document.querySelectorAll(".cardwrap")]
        .find((x) => x.querySelector(`article.card[data-cid="${id}"]`));
      if (!w || !w.querySelector(".vnav")) return null;
      const src = () => w.querySelector(".media img")?.getAttribute("src");
      const a = src();
      const btn = w.querySelector(".vnav.prev:not([disabled])") || w.querySelector(".vnav.next");
      btn.click();
      return [a, src(), !!document.querySelector(".sheet.big:not([hidden]) .vpip")];
    }, c.id);
    if (stepped) {
      assert(stepped[0] !== stepped[1], `‹ › left the picture at ${stepped[0]}`);
      assert(!stepped[2], "an arrow opened the card");
    }
    const opened = await page.evaluate((id) => {
      const w = [...document.querySelectorAll(".cardwrap")]
        .find((x) => x.querySelector(`article.card[data-cid="${id}"]`));
      if (!w) return false;
      w.querySelector(".cmedia, .media, article.card").click();
      return true;
    }, c.id);
    assert(opened, `${c.id} (${c.label}) is not on the grid`);
    await page.waitForSelector(".sheet.big .vpip", { timeout: 8000 });
    for (let i = 0; i < c.versions.length; i++) {
      await page.evaluate((i) => document.querySelectorAll(".sheet.big .vpip")[i].click(), i);
      await sleep(250);
      const src = await page.$eval(".sheet.big .cmedia img, .sheet.big .media img",
                                   (img) => img.getAttribute("src"));
      const m = c.versions[i].media || {};
      const ok = [m.still, ...(m.views || []).map((x) => x.still)];
      assert(ok.includes(String(src).split("?")[0]),
             `v${i + 1}'s picture: got ${src}, want one of ${ok.join(" | ")}`);
    }
    await page.evaluate(() => document.querySelectorAll(".sheet.big .vpip")[0].click());
    await sleep(200);
    const [words, after, by] = await page.$eval(".sheet.big .cdesc", (p) =>
      [p.innerText, p.previousElementSibling?.className || "",
       [...p.querySelectorAll(".cdtag")].map((t) => t.textContent).join(" ")]);
    eq(after, "acts", "the description is not directly under the inspire / revise row");
    if (c.versions[0].agent)
      assert(by.split(" ").includes(c.versions[0].agent), `v1's labels said: ${by}`);
    const mediaH = await page.$eval(".sheet.big .cmedia", (m) => m.getBoundingClientRect().height);
    assert(mediaH > 150, `the picture was squeezed to ${mediaH}px`);
    const v1 = (await api(`/api/cards/${encodeURIComponent(c.id)}`)).versions[0];
    if (v1.rationale)
      assert(words.includes(v1.rationale.slice(0, 40)), `v1's description said: ${words.slice(0, 120)}`);
    log(`${c.id}: ${c.versions.length} versions, each pip its own picture and words`);
    eq(errs.length, 0, `page errors: ${errs.join(" | ")}`);
  });
}
