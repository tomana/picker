import { withPage, showTab, ensurePanel, api, assert, sleep } from "./lib.mjs";
export const name = "hairpin — on the lanes from the start, grabbed in any direction, and in the cup's rows";
export async function run(log) {
  await withPage(async (page, errs) => {
    await showTab(page, "fx_music");
    await page.evaluate(() => {
      const w = [...document.querySelectorAll(".grid .cardwrap")].find((x) => x.querySelectorAll(".lane").length >= 2);
      w.scrollIntoView({ block: "center" });
      w.querySelector("article.card .media, article.card .vblock, article.card").click();
    });
    await sleep(1200);
    const samples = await page.evaluate(async () => {
      const blk = document.querySelector(".sheet.big .vblock");
      window.__ins = [];
      new MutationObserver((ms) => {
        for (const m of ms) for (const n of m.addedNodes) {
          const lines = n.nodeType === 1 ? (n.matches(".vline") ? [n] : [...n.querySelectorAll(".vline")]) : [];
          for (const l of lines) {
            const lane = l.parentElement && l.parentElement.querySelector(".lane");
            if (!lane) continue;
            window.__ins.push({ visible: getComputedStyle(l).visibility !== "hidden",
                                rel: Math.round(l.getBoundingClientRect().left - lane.getBoundingClientRect().left) });
          }
        }
      }).observe(document.querySelector(".sheet.big"), { childList: true, subtree: true });
      document.querySelector(".sheet.big .vplay").click();
      const out = [];
      const t0 = performance.now();
      let muted = false;
      while (performance.now() - t0 < 1500) {
        if (!muted && performance.now() - t0 > 700) {
          muted = true;
          const m = document.querySelectorAll(".sheet.big .vrowc [title='mute this band']")[1];
          if (m) m.click();
        }
        await new Promise((r) => requestAnimationFrame(r));
        const b = document.querySelector(".sheet.big .vblock") || blk;
        const l = b.querySelector(".vline"), lane = b.querySelector(".lane");
        if (!l || !lane || getComputedStyle(l).visibility === "hidden") continue;
        out.push(Math.round(l.getBoundingClientRect().left - lane.getBoundingClientRect().left));
      }
      return out;
    });
    assert(samples.length > 10, `too few frames with a line: ${samples.length}`);
    const ins = await page.evaluate(() => window.__ins);
    const flash = ins.filter((x) => x.visible && x.rel < -2);
    assert(!flash.length, `a line was drawn left of the lanes on insertion (the jump): ${JSON.stringify(ins)}`);
    log(`${ins.length} lines inserted while playing (a mute included): none drawn left of the lanes`);
    const left = Math.min(...samples);
    assert(left >= -2, `the line was ${-left}px left of the lanes (a jump): ${samples.slice(0, 12).join(",")}`);
    log(`open card ▶: ${samples.length} frames, the line never left of the lanes (min ${left}px)`);
    const g = await page.evaluate(() => {
      const l = document.querySelector(".sheet.big .vline"), lane = document.querySelector(".sheet.big .lane");
      const r = l.getBoundingClientRect(), lr = lane.getBoundingClientRect();
      return { x: r.left + 1, y: lr.top + lr.height / 2, laneL: lr.left, laneW: lr.width };
    });
    const to = g.laneL + g.laneW * 0.6;
    await page.mouse.move(g.x + 6, g.y);
    await page.mouse.down();
    await page.mouse.move(g.x + 8, g.y + 14, { steps: 3 });
    await page.mouse.move(to, g.y + 20, { steps: 8 });
    await page.mouse.up();
    await sleep(120);
    const after = await page.evaluate(() => {
      const l = document.querySelector(".sheet.big .vline"), lane = document.querySelector(".sheet.big .lane");
      const lr = lane.getBoundingClientRect();
      return l ? (l.getBoundingClientRect().left - lr.left) / lr.width : null;
    });
    assert(after != null && Math.abs(after - 0.6) < 0.05, `grabbed and dragged to 60%: the line is at ${after}`);
    log(`grabbed on its handle, dragged down then across: the line at ${(after * 100).toFixed(1)}%`);
    const tab = await page.evaluate(() => {
      const t = document.querySelector(".auxplay"), sh = document.querySelector(".sheet.big");
      const v = [...sh.querySelectorAll(":scope > .cfoot > .vcell")].map((x) => x.getBoundingClientRect());
      const r = t.getBoundingClientRect();
      return { shown: !t.hidden, dl: Math.abs(r.left - v[0].left), dw: Math.abs(r.width - (v[1].right - v[0].left)),
               dy: Math.abs(r.top - sh.getBoundingClientRect().bottom), h: r.height };
    });
    assert(tab.shown && tab.dl < 2 && tab.dw < 2 && tab.dy < 3 && tab.h >= 44, `the tab under − +: ${JSON.stringify(tab)}`);
    const lit = () => page.evaluate(() => [document.querySelector(".auxplay").classList.contains("on"),
                                           !!document.querySelector(".sheet.big .vplay.on")].join());
    const was = await lit();
    await page.click(".auxplay"); await sleep(600);
    const once = await lit();
    await page.click(".auxplay"); await sleep(900);
    const twice = await lit();
    assert(was === "true,true" && once === "false,false" && twice === "true,true",
           `the tab pauses and plays with the card's ▶: ${was} → ${once} → ${twice}`);
    log(`the ▶ under − +: ${Math.round(tab.h)}px tall, as wide as the votes; it paused and played the card`);
    const tb = await page.evaluate(() => { const x = document.querySelector(".auxplay").getBoundingClientRect();
      return { x: x.left, y: x.top + x.height / 2, w: x.width }; });
    await page.mouse.move(tb.x + tb.w * 0.15, tb.y); await page.mouse.down();
    await page.mouse.move(tb.x + tb.w * 0.8, tb.y + 4, { steps: 8 }); await page.mouse.up();
    await sleep(700);
    const pin = await page.evaluate(() => {
      const t = document.querySelector(".auxplay"), tr = t.getBoundingClientRect(), l = t.querySelector(".auxline");
      const ml = document.querySelector(".sheet.big .vline"), lr = document.querySelector(".sheet.big .lane").getBoundingClientRect();
      return { tab: (l.getBoundingClientRect().left + 1 - tr.left) / tr.width, card: ml ? (ml.getBoundingClientRect().left - lr.left) / lr.width : null,
               playing: t.classList.contains("on") };
    });
    assert(pin.playing && pin.card > 0.76 && pin.card < 0.9 && Math.abs(pin.tab - pin.card) < 0.05,
           `a drag in the tab scrubs the card: ${JSON.stringify(pin)}`);
    log(`a drag in the tab to 80%: the card's playhead at ${(pin.card * 100).toFixed(0)}%, the tab's at ${(pin.tab * 100).toFixed(0)}%, playing on`);
    await page.keyboard.press("Escape");
    await sleep(300);
    assert(await page.evaluate(() => document.querySelector(".auxplay").hidden), "the tab stayed after the card closed");
    await sleep(500);
    const st = await api("/api/cup?type=fx_music");
    if (!(st.last && (st.last.ranking || []).length)) { log("no finished fx_music cup: the rows aren't checked"); return; }
    await ensurePanel(page, "cup", true);
    await sleep(800);
    const names = await page.evaluate(() => [...document.querySelectorAll("article.cup .rkrow .rkname")]
      .map((n) => n.firstChild ? n.firstChild.textContent : n.textContent));
    const want = st.last.ranking.map((r) => (r.card.name ? `m:${r.card.name}` : r.card.id));
    const off = want.map((w, i) => [w, names[i]]).filter(([w, n]) => w !== n);
    assert(!off.length, `rows not named by their card's name (want, shown): ${JSON.stringify(off.slice(0, 4))}`);
    const archived = st.last.ranking.filter((r) => r.card.archived).length;
    log(`cup rows: all ${names.length} by their h: name, ${archived} of them archived`);
    const row = "article.cup .rkrow:nth-child(2)";
    const box = await page.evaluate((q) => { const n = document.querySelector(`${q} .rkname`); n.scrollIntoView({ block: "center" });
      const r = n.getBoundingClientRect(); return { x: r.left, y: r.top + r.height / 2, w: r.width }; }, row);
    await page.mouse.move(box.x + box.w * 0.2, box.y);
    await page.mouse.down();
    await page.mouse.move(box.x + box.w * 0.7, box.y + 2, { steps: 8 });
    await page.mouse.up();
    await sleep(300);
    const scrub = await page.evaluate((q) => {
      const l = document.querySelector(`${q} .rkname .vline`), n = document.querySelector(`${q} .rkname`);
      return { playing: !!document.querySelector(`${q} .rkplay.on`), at: l ? (l.getBoundingClientRect().left - n.getBoundingClientRect().left) / n.getBoundingClientRect().width : null,
               opened: !!document.querySelector(".sheet.big:not([hidden])") };
    }, row);
    assert(scrub.playing && scrub.at > 0.6 && scrub.at < 0.8 && !scrub.opened, `a drag on the row: ${JSON.stringify(scrub)}`);
    await page.mouse.click(box.x + box.w * 0.3, box.y);
    await sleep(500);
    const seek = await page.evaluate((q) => {
      const l = document.querySelector(`${q} .rkname .vline`), n = document.querySelector(`${q} .rkname`);
      return { at: l ? (l.getBoundingClientRect().left - n.getBoundingClientRect().left) / n.getBoundingClientRect().width : null,
               opened: !!document.querySelector(".sheet.big:not([hidden])") };
    }, row);
    assert(seek.at > 0.25 && seek.at < 0.4 && !seek.opened, `a tap while it plays seeks: ${JSON.stringify(seek)}`);
    await page.evaluate((q) => document.querySelector(`${q} .rkplay`).click(), row);
    await sleep(300);
    await page.mouse.click(box.x + box.w * 0.5, box.y);
    await sleep(900);
    assert(await page.evaluate(() => !!document.querySelector(".sheet.big:not([hidden])")), "a tap on a quiet row didn't open its card");
    log(`cup row: a drag scrubbed to ${(scrub.at * 100).toFixed(0)}%, a tap seeked to ${(seek.at * 100).toFixed(0)}%, a tap on it quiet opened the card`);
    await page.keyboard.press("Escape");
    await sleep(500);
    const kept = await page.evaluate(async () => {
      const l = document.querySelector("article.cup .cuprank");
      l.scrollTop = 200; l.dispatchEvent(new Event("scroll"));
      await new Promise((r) => setTimeout(r, 100));
      const rows = [...l.querySelectorAll(".rkrow")];
      const vis = rows.find((r) => r.getBoundingClientRect().top > l.getBoundingClientRect().top + 10);
      vis.querySelector(".rkarch").click();
      await new Promise((r) => setTimeout(r, 900));
      return document.querySelector("article.cup .cuprank").scrollTop;
    });
    assert(kept > 150, `the list jumped after an archive: scrollTop ${kept}`);
    log(`an archive in the list: it stayed at ${Math.round(kept)}px`);
    assert(!errs.length, "page errors: " + errs.slice(0, 3).join(" | "));
  });
}
