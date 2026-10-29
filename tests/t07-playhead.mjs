import { withPage, showTab, api, assert, eq, sleep } from "./lib.mjs";
export const name = "playhead — grid ▶, scrub, and one reused element";
async function blockBox(page, sel) {
  return page.evaluate((s) => {
    const b = document.querySelector(s);
    const r = b.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  }, sel);
}
export async function run(log) {
  const { cards } = await api("/api/cards?type=fx_music");
  const long = (c) => ((c.versions || []).slice(-1)[0] || {}).duration >= 15;
  const skip = cards.filter((c) => (c.origin || {}).kind === "recording" || !long(c)).map((c) => c.id);
  await withPage(async (page, errs) => {
    await showTab(page, "fx_music");
    const cid = await page.evaluate((skip) => {
      const a = [...document.querySelectorAll("article.card[data-cid]")]
        .find((x) => x.querySelector(".vblock[data-audio]") && !skip.includes(x.dataset.cid));
      if (!a) return null;
      a.scrollIntoView({ block: "center" });
      return a.dataset.cid;
    }, skip);
    assert(cid, "no card with audio on the grid that is not a recording and plays 15 s or more");
    const C = `article.card[data-cid="${cid}"]`;
    log(`card ${cid}`);
    await sleep(500);
    await page.evaluate(() => document.querySelectorAll("article.card .vplay.on").forEach((b) => b.click()));
    await sleep(300);
    await page.evaluate(() => {
      const A = window.Audio; window.__live = [];
      window.Audio = function (u) { const a = new A(u); window.__live.push(a); return a; };
    });
    await page.evaluate((C) => document.querySelector(`${C} .vplay`).click(), C);
    await sleep(1500);
    const playing = await page.evaluate((C) => ({
      lit: !!document.querySelector(`${C} .vplay.on`),
      head: (document.querySelector(`${C} .vline`) || { style: {} }).style.left,
      panel: !!document.querySelector(".sheet.big:not([hidden])"),
      vol: window.__live.map((a) => +a.volume.toFixed(2)),
    }), C);
    log(`grid ▶: lit=${playing.lit} playhead=${playing.head} volume=${playing.vol}`);
    assert(playing.lit, "the grid play button did nothing");
    assert(playing.head, "playing with no playhead");
    assert(!playing.panel, "pressing ▶ opened the card");
    assert(playing.vol.some((v) => v > 0.9), "it never reached full volume");
    await page.evaluate((C) => document.querySelector(`${C} .vplay`).click(), C);
    await sleep(400);
    const stopped = await page.evaluate(() => window.__live.map((a) => ({
      n: window.__live.length, paused: a.paused, vol: a.volume,
      keptSrc: !!a.getAttribute("src"),
    })));
    eq(stopped.length, 1, "a second <audio> was made — the element must be reused");
    assert(stopped[0].paused, "stop did not pause");
    eq(stopped[0].vol, 1, "something is ramping `volume` again — that is the click");
    assert(stopped[0].keptSrc, "the src was torn down; the decoder dies with it");
    log("stop pauses one reused element, volume untouched, src kept");
    const box = await blockBox(page, `${C} .vblock[data-audio] .lane`);
    await page.mouse.move(box.x + box.w * 0.15, box.y + box.h * 0.5);
    await page.mouse.down();
    await page.mouse.move(box.x + box.w * 0.8, box.y + box.h * 0.5, { steps: 10 });
    await page.mouse.up();
    await sleep(1300);
    const dragged = await page.evaluate((C) => ({
      head: (document.querySelector(`${C} .vline`) || { style: {} }).style.left,
      panel: !!document.querySelector(".sheet.big:not([hidden])"),
    }), C);
    log(`grid drag to 80%: playhead ${dragged.head}, card stayed shut=${!dragged.panel}`);
    assert(parseFloat(dragged.head) > 60, `the drag did not scrub (${dragged.head})`);
    assert(!dragged.panel, "a scrub also opened the card");
    await page.mouse.click(box.x + box.w * 0.5, box.y + box.h * 0.5);
    await sleep(1000);
    assert(await page.evaluate(() => !!document.querySelector(".sheet.big:not([hidden])")),
      "a tap no longer opens the card");
    const sb = await blockBox(page, ".sheet .vblock .lane");
    await page.mouse.click(sb.x + sb.w * 0.25, sb.y + sb.h / 2);
    await sleep(1200);
    const head = await page.evaluate(() => {
      const blk = document.querySelector(".sheet .vblock");
      const lr = blk.querySelector(".lane").getBoundingClientRect();
      const line = blk.querySelector(".vline");
      return line ? ((line.getBoundingClientRect().left - lr.left) / lr.width) * 100 : null;
    });
    log(`open-card tap at 25% along the lane: playhead at ${head.toFixed(1)}%`);
    assert(Math.abs(head - 25) < 8, `tap did not seek (${head})`);
    const at = async () => page.evaluate(() => {
      const blk = document.querySelector(".sheet .vblock");
      const lr = blk.querySelector(".lane").getBoundingClientRect();
      const line = blk.querySelector(".vline");
      return line ? ((line.getBoundingClientRect().left - lr.left) / lr.width) * 100 : null;
    });
    const a1 = await at();
    await sleep(1800);
    const a2 = await at();
    log(`open card, after a grid start: playhead ${a1.toFixed(1)}% -> ${a2.toFixed(1)}%`);
    assert(a1 > -1, `the panel's playhead is off its lane (${a1}%)`);
    assert(a2 > a1, "the panel's playhead stopped advancing");
    await page.mouse.click(sb.x + sb.w * 0.6, sb.y + sb.h / 2);
    await sleep(400);
    const b1 = await at();
    await sleep(2200);
    const b2 = await at();
    log(`after scrubbing to 60%: ${b1.toFixed(1)}% -> ${b2.toFixed(1)}%`);
    assert(b2 > b1, "the playhead froze after a scrub");
    assert(!errs.length, "page errors: " + errs.slice(0, 3).join(" | "));
  }, { width: 412, height: 900, dpr: 1 });
}
