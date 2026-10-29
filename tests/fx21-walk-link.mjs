import { withPage, assert, eq, sleep, BASE } from "./lib.mjs";
export const name = "a link with ?walk=1 opens the page on the walkthrough, and the address loses it";

export async function run(log) {
  await withPage(async (page, errs) => {
    await page.goto(BASE + "/?walk=1", { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".wcap", { timeout: 20000 });
    await sleep(300);
    const at = await page.evaluate(() => ({ step: document.querySelector(".wcap").innerText.split("\n").slice(0, 2).join(" · "),
                                            search: location.search }));
    assert(/1 \/ \d+/.test(at.step), `the first step: ${at.step}`);
    eq(at.search.includes("walk"), false, "the address no longer asks for it");
    assert(!errs.length, "page errors: " + errs.slice(0, 4).join(" | "));
    log(`opened on "${at.step}"`);
  });
}
