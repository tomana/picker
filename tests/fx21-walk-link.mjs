import { withPage, assert, eq, sleep, BASE } from "./lib.mjs";
export const name = "a link with ?walk=1 opens on the walkthrough, its first step with the picker's four squares, as is the tab's icon";

export async function run(log) {
  await withPage(async (page, errs) => {
    await page.goto(BASE + "/?walk=1", { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".wcap", { timeout: 20000 });
    await sleep(300);
    const at = await page.evaluate(() => ({ step: document.querySelector(".wcap").innerText.split("\n").slice(0, 2).join(" · "),
                                            search: location.search }));
    assert(/1 \/ \d+/.test(at.step), `the first step: ${at.step}`);
    const pic = () => page.evaluate(() => { const p = document.querySelector(".wcap .wpic");
      return p && !p.hidden ? p.querySelectorAll("svg rect").length : 0; });
    eq(await pic(), 4, "the first step shows the picker: four squares");
    await page.evaluate(() => [...document.querySelectorAll(".wcap .wbtn")].at(-1).click());
    await sleep(300);
    eq(await pic(), 0, "the next step shows none");
    const icon = await page.evaluate(() => decodeURIComponent(document.querySelector('link[rel="icon"]').href));
    eq((icon.match(/<rect x=/g) || []).length, 4, "the tab's icon: the same four squares");
    eq(at.search.includes("walk"), false, "the address no longer asks for it");
    assert(!errs.length, "page errors: " + errs.slice(0, 4).join(" | "));
    log(`opened on "${at.step}"`);
  });
}
