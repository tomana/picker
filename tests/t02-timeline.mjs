import { withPage, showTab, ensurePanel, scratchArrangement, scratchPicker, openTab,
         assert, eq, sleep } from "./lib.mjs";
export const name = "timeline — draws, plays, drags, persists";
export async function run(log) {
  const sp = await scratchPicker();
  try {
    const scratch = await scratchArrangement("fx_music", 3, sp);
    await withPage(async (page, errs) => {
      await sp.route(page, (path) => path.startsWith("/api/arrangements"));
      await showTab(page, "fx_music");
      await ensurePanel(page, "timelines");
      assert(await page.$(".tlwrap"), "no timeline on a type that has arrangements");
      assert(await openTab(page, "__test"), "the scratch tab is not in the tab bar");
      const drew = await page.evaluate(() => ({
        clips: document.querySelectorAll(".tl-clip").length,
        waves: [...document.querySelectorAll(".tl-clip canvas.tl-wave")]
          .filter((c) => c.width > 2).length,
        ticks: document.querySelectorAll(".tl-tick").length,
        playhead: !!document.querySelector(".tl-playhead"),
      }));
      log(`drew ${drew.clips} clips, ${drew.waves} waveforms decoded`);
      eq(drew.clips, 3, "clips drawn");
      assert(drew.waves === 3, `waveforms decoded (${drew.waves}/3) — the audio did not load`);
      assert(drew.ticks > 0 && drew.playhead, "no ruler or playhead");
      await page.evaluate(() => document.querySelector(".tl-play").click());
      await sleep(2200);
      const at = await page.evaluate(() =>
        parseFloat((document.querySelector(".tl-playhead") || {}).style?.left) || 0);
      log(`playhead advanced to ${at.toFixed(0)}px`);
      assert(at > 4, "the playhead did not move — nothing is playing");
      await page.evaluate(() => document.querySelector(".tl-play").click());
      const box = await page.evaluate(() => {
        const c = document.querySelector(".tl-clip");
        c.scrollIntoView({ block: "center" });
        const r = c.getBoundingClientRect();
        return { id: c.dataset.id, left: parseFloat(c.style.left) || 0,
                 x: r.x + r.width / 2, y: r.y + r.height / 2 };
      });
      await page.mouse.move(box.x, box.y);
      await page.mouse.down();
      await page.mouse.move(box.x + 140, box.y, { steps: 10 });
      await page.mouse.up();
      await sleep(1400);
      const moved = await page.evaluate((id) => {
        const c = document.querySelector(`.tl-clip[data-id="${id}"]`);
        return c ? parseFloat(c.style.left) : -1;
      }, box.id);
      assert(moved > box.left + 60, `the clip did not move (${box.left} -> ${moved})`);
      const saved = (await sp.call(`/api/arrangements/${scratch.id}`))
        .json.clips.find((c) => c.id === box.id);
      log(`dragged ${box.left.toFixed(0)}px -> ${moved.toFixed(0)}px, stored start ${saved.start}s`);
      assert(saved.start > 0, "the drag did not reach the store");
      assert(!errs.length, "page errors: " + errs.slice(0, 3).join(" | "));
    }, { width: 1200, height: 1000, dpr: 1 });
  } finally {
    sp.done();
  }
}
