import { withPage, assert, eq, sleep, showTab, scratchPicker, settle } from "./lib.mjs";
export const name = "the lane player — rows at once, ▶ at once; a tap and a drag jump only while silent, the sound never stopping; 🗑 and 🔊 heard as a stream of the lanes left; a long press opens the menu; nothing decoded";

const CARDS = ["fx0a1b2c3d4e", "fx7a8b9c0d1e"];        // a music card; a bundle (face comp1)
const secs = (t) => { const m = /^(\d+):(\d+(?:\.\d+)?)/.exec(t || ""); return m ? +m[1] * 60 + +m[2] : null; };

// page-side counters: every media element that plays, its events; decodeAudioData; pointercancel
const SPY = () => {
  window.__np = { media: new Set(), playing: [], seeked: 0, decodes: 0, cancels: 0, srcs: [], jumpVols: [], stopVols: [], step: 0 };
  const P = HTMLMediaElement.prototype, play = P.play, pause = P.pause;
  P.play = function (...a) {
    if (!window.__np.media.has(this)) {
      window.__np.media.add(this);
      this.addEventListener("playing", () => window.__np.playing.push({ t: performance.now(), src: this.currentSrc }));
      this.addEventListener("seeked", () => { window.__np.seeked++; });
      // a jump on a sounding waveform is a click: the volume at the moment it jumps, on an element playing
      this.addEventListener("seeking", () => { if (!this.paused) window.__np.jumpVols.push(this.volume); });
    }
    return play.apply(this, a);
  };
  P.pause = function (...a) { if (!this.paused) window.__np.stopVols.push(this.volume); return pause.apply(this, a); };
  const src = Object.getOwnPropertyDescriptor(P, "src");
  Object.defineProperty(P, "src", { ...src, set(v) { window.__np.srcs.push(String(v)); src.set.call(this, v); } });
  const AC = window.AudioContext || window.webkitAudioContext;
  // the open card's decodes (the page's lanes path or the player's), not the timeline panel's or the crop editor's
  if (AC) { const d = AC.prototype.decodeAudioData; AC.prototype.decodeAudioData = function (...a) {
    if (/\/(page|player\/\w+)\.js/.test(new Error().stack || "")) window.__np.decodes++;
    return d.apply(this, a); }; }
  document.addEventListener("pointercancel", () => { window.__np.cancels++; }, true);
  // while watching: 5-ms samples of whether any element is sounding (playing with data); a silent one is a gap
  window.__np.watch = () => {
    window.__np.gaps = 0; window.__np.samples = 0;
    clearInterval(window.__np.iv);
    window.__np.iv = setInterval(() => {
      window.__np.samples++;
      const on = [...window.__np.media].filter((e) => !e.paused && !e.ended);
      if (!on.some((e) => e.readyState >= 3)) window.__np.gaps++;
      for (const e of on) {     // the largest step between samples: a hard cut is one sample from 1 to 0
        if (e.__was != null) window.__np.step = Math.max(window.__np.step, Math.abs(e.volume - e.__was));
        e.__was = e.volume;
      }
    }, 5);
  };
  window.__np.unwatch = () => { clearInterval(window.__np.iv); return { gaps: window.__np.gaps, samples: window.__np.samples }; };
};

export async function run(log) {
  const sp = await scratchPicker();
  const said = [];
  try {
    for (const ID of CARDS) {
      const card = (await sp.call(`/api/cards/${ID}`)).json, v = card.versions.at(-1);
      const every = (v.parts || []).filter((p) => p.kind === "voice" && p.audio);
      const lanes = every.filter((p) => !p.archived);            // the ones in; a lane out from before stays out
      assert(lanes.length >= 2, `${ID}: two lanes in or more`);
      const row = (i) => `.sheet.big .np-row[data-lane="${lanes[i].id}"]`;
      const last0 = lanes.length - 1;
      await withPage(async (page, errs) => {
        await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
        const until = (what, fn, arg) => page.waitForFunction(fn, { timeout: 5000 }, arg)
          .catch(async () => { throw new Error(`${ID}: ${what} within 5 s: ${await page.evaluate(() => JSON.stringify({ srcs: window.__np.srcs.slice(-3), n: window.__np.playing.length, toast: (document.querySelector(".ptoast") || {}).textContent }))}`); });
        await page.evaluateOnNewDocument(SPY);
        const seen = [];
        await sp.route(page, (p, m) => m === "POST" && p.endsWith("/signal"), { seen });
        await showTab(page, "fx_music");
        const t0 = Date.now();
        await page.evaluate((id) => { const a = document.querySelector(`.grid article.card[data-cid="${id}"]`);
          a.scrollIntoView({ block: "center" }); (a.querySelector(".media, .vblock") || a).click(); }, ID);
        await page.waitForSelector(".sheet.big:not([hidden]) .np .np-row", { timeout: 10000 });
        const rowsMs = Date.now() - t0;
        eq(await page.$$eval(".sheet.big .np .np-row", (r) => r.length), every.length, `${ID}: a row per lane`);
        assert(!(await page.$(".sheet.big .vrowc")), `${ID}: the current player's rows are not drawn`);
        await sleep(400);
        const W = () => page.evaluate(() => ({ ...window.__np, media: window.__np.media.size }));

        // ▶ → sound
        const c0 = await page.evaluate(() => { window.__np.t = performance.now(); return window.__np.playing.length; });
        await page.$eval(".sheet.big .np-play", (b) => b.click());
        await until("▶ sounds", (n) => window.__np.playing.length > n, c0);
        const playMs = await page.evaluate(() => window.__np.playing.at(-1).t - window.__np.t);
        const mixSrc = await page.evaluate(() => window.__np.playing.at(-1).src);
        await sleep(600);

        // the ruler is thin; a tap at 25 % of it: the head goes there, nothing pauses
        assert((await page.$eval(".sheet.big .np-ruler", (e) => e.getBoundingClientRect().height)) <= 20, `${ID}: a thin ruler`);
        const box = await page.$eval(".sheet.big .np-rcell", (e) => { const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; });
        await page.evaluate(() => window.__np.watch());
        await page.touchscreen.tap(box.x + box.w * 0.25, box.y + box.h / 2);
        await sleep(500);
        const tapGaps = await page.evaluate(() => window.__np.unwatch());
        const tapAt = secs(await page.$eval(".sheet.big .np-t", (e) => e.textContent));
        const dur = v.duration;
        assert(Math.abs(tapAt / dur - 0.25) < 0.04 + 0.5 / dur, `${ID}: the tap lands at 25 % (${(0.25 * dur).toFixed(1)} s): ${tapAt}`);

        // a 30-move sideways drag on a strip: no pointercancel, the piece plays on
        const strip = await page.$eval(`${row(0)} .np-strip`, (e) => { const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; });
        const s0 = await W();
        await page.evaluate(() => window.__np.watch());
        await page.touchscreen.touchStart(strip.x + strip.w * 0.2, strip.y + strip.h / 2);
        for (let k = 1; k <= 30; k++) {
          await page.touchscreen.touchMove(strip.x + strip.w * (0.2 + 0.02 * k), strip.y + strip.h / 2);
          await sleep(16);
        }
        await page.touchscreen.touchEnd();
        await sleep(500);
        const dragGaps = await page.evaluate(() => window.__np.unwatch());
        const s1 = await W();
        const dragAt = secs(await page.$eval(".sheet.big .np-t", (e) => e.textContent));
        eq(s1.cancels - s0.cancels, 0, `${ID}: the drag is never cancelled`);
        assert(s1.seeked - s0.seeked <= 2, `${ID}: the moves don't jump, the landing does: ${s1.seeked - s0.seeked} seeks`);
        const quiet = await W();
        assert(quiet.jumpVols.every((x) => x <= 0.02), `${ID}: every jump is silent: ${quiet.jumpVols.join()}`);
        assert(quiet.step <= 0.6, `${ID}: no hard cut in the volume: a step of ${quiet.step}`);
        assert(Math.abs(dragAt / dur - 0.8) < 0.06, `${ID}: the drag ends at 80 %: ${dragAt} of ${dur}`);
        assert(await page.$eval(".sheet.big .np", (e) => e.classList.contains("playing")), `${ID}: still playing after the drag`);

        // a drag that starts on a row's 🔊: the head moves by as much as the finger, the button isn't pressed
        const mb = await page.$eval(`${row(0)} .np-mute`, (e) => { const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
        const hb = await page.evaluate(() => { const h = document.querySelector(".sheet.big .np-head").getBoundingClientRect(), r = document.querySelector(".sheet.big .np-strip").getBoundingClientRect(); return (h.left - r.left) / r.width; });
        const sigs0 = seen.length;
        await page.touchscreen.touchStart(mb.x, mb.y);
        for (let k = 1; k <= 12; k++) { await page.touchscreen.touchMove(mb.x - strip.w * 0.5 * (k / 12), mb.y); await sleep(16); }
        await page.touchscreen.touchEnd();
        await sleep(300);
        const ha = await page.evaluate(() => { const h = document.querySelector(".sheet.big .np-head").getBoundingClientRect(), r = document.querySelector(".sheet.big .np-strip").getBoundingClientRect(); return (h.left - r.left) / r.width; });
        assert(Math.abs(ha - (hb - 0.5)) < 0.08, `${ID}: a drag from a button moves the head by the finger's half a strip: ${hb.toFixed(2)} → ${ha.toFixed(2)}`);
        assert(!(await page.$eval(row(0), (e) => e.classList.contains("muted"))), `${ID}: the drag didn't press 🔊`);
        eq(seen.length, sigs0, `${ID}: and sent nothing`);
        assert(await page.$eval(".sheet.big .np", (e) => e.classList.contains("playing")), `${ID}: still playing after it`);

        // 🗑 on the first lane while playing: its signal, then a stream of the lanes left
        const n0 = (await W()).playing.length;
        await page.evaluate(() => { window.__np.t = performance.now(); });
        await page.$eval(`${row(0)} .np-out`, (b) => b.click());
        await until("🗑's stream sounds", (n) => window.__np.playing.length > n, n0);
        const cut = await page.evaluate(() => ({ ms: window.__np.playing.at(-1).t - window.__np.t, src: window.__np.playing.at(-1).src }));
        const sig = seen.find((s) => s.path.endsWith("/signal"));
        assert(sig, `${ID}: 🗑 sends a signal`);
        const body = JSON.parse(sig.body);
        eq(body.kind, "archive", "the signal's kind"); eq(body.voice, lanes[0].id, "its lane"); eq(body.value, true, "out");
        if (v.face_item) { eq(body.version, v.n, "a bundle's signal names the version"); eq(body.item, v.face_item, "and the item"); }
        const q = new URL(cut.src).searchParams;
        assert(/\/mix$/.test(new URL(cut.src).pathname) && q.has("lanes"), `${ID}: the lanes left as one stream: ${cut.src}`);
        assert(!q.get("lanes").split(",").includes(lanes[0].id), `${ID}: without the lane taken out: ${q.get("lanes")}`);
        assert(cut.ms <= 600, `${ID}: 🗑 heard within 600 ms: ${cut.ms.toFixed(0)} ms`);
        assert(await page.$eval(row(0), (e) => e.classList.contains("out")), `${ID}: the row shows it out`);

        // 🔊 on the second lane (with a third left to hear): heard the same way, nothing sent
        if (lanes.length >= 3) {
          const m0 = (await W()).playing.length, sigs = seen.length;
          await page.$eval(`${row(1)} .np-mute`, (b) => b.click());
          await until("🔊's stream sounds", (n) => window.__np.playing.length > n, m0);
          const muted = new URL(await page.evaluate(() => window.__np.playing.at(-1).src)).searchParams.get("lanes") || "";
          assert(!muted.split(",").includes(lanes[1].id) && !muted.split(",").includes(lanes[0].id), `${ID}: the mute leaves both out: ${muted}`);
          eq(seen.length, sigs, `${ID}: a mute is never sent`);
        }

        // a long press on a strip: its menu, the head where it was; a sideways drag opens none
        const ls = await page.$eval(`${row(last0)} .np-strip`, (e) => { e.scrollIntoView({ block: "center" }); const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; });
        const lifted0 = seen.length;
        await page.touchscreen.touchStart(ls.x + ls.w / 2, ls.y + ls.h / 2);
        await sleep(650);
        await page.touchscreen.touchEnd();
        await sleep(100);
        await sleep(400);                                    // and it stays: nothing but a press or the rows' scroll shuts it
        const items = await page.$$eval(".np-menu .np-mi", (b) => b.map((x) => x.dataset.act));
        assert(items.includes("clip") && items.includes("tag") && items.includes("out"), `${ID}: the long press's menu: ${items}`);
        eq(seen.length, lifted0, `${ID}: the lift that ends a long press presses nothing in the menu under it`);
        await page.$eval(".np-mi[data-act='tag']", (b) => b.click());
        await sleep(100);
        const f = await page.$eval(".sheet.big .ideabox", (e) => ({ v: e.value, focused: document.activeElement === e }));
        assert(f.v.includes(`lane:${lanes[last0].id}`) && !f.focused, `${ID}: the tag goes in, no keyboard: ${JSON.stringify(f)}`);
        await page.touchscreen.touchStart(ls.x + ls.w * 0.4, ls.y + ls.h / 2);
        for (let k = 1; k <= 4; k++) { await page.touchscreen.touchMove(ls.x + ls.w * (0.4 + 0.05 * k), ls.y + ls.h / 2); await sleep(30); }
        await sleep(600);
        await page.touchscreen.touchEnd();
        await sleep(200);
        assert(!(await page.$(".np-menu")), `${ID}: a drag opens no menu`);

        // a row's ▶: its own file
        const r0 = (await W()).playing.length;
        const last = last0;
        await page.$eval(`${row(last)} .np-solo`, (b) => b.click());
        await until("a row's ▶ sounds", (n) => window.__np.playing.length > n, r0);
        const solo = await page.evaluate(() => window.__np.playing.at(-1).src);
        assert(new URL(solo).pathname === new URL(lanes[last].audio, "http://x").pathname, `${ID}: the lane's own file: ${solo}`);

        // 🗑 again: back in
        await page.$eval(`${row(0)} .np-out`, (b) => b.click());
        await until("the 2nd 🗑 puts it back", (r) => !document.querySelector(r).classList.contains("out"), row(0));
        const back = JSON.parse(seen.filter((s) => s.path.endsWith("/signal")).at(-1).body);
        eq(back.value, false, `${ID}: the second 🗑 puts it back`);

        // the same from the lane's menu, and back
        const outs = () => seen.filter((x) => x.path.endsWith("/signal")).length;
        const o0 = outs();
        await page.$eval(`${row(last)} .np-strip`, (s) => s.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })));
        await page.$eval(".np-mi[data-act='out']", (b) => b.click());
        await until("the menu's take-out shows", (r) => document.querySelector(r).classList.contains("out"), row(last));
        eq(outs(), o0 + 1, `${ID}: the menu's take-out sends its signal`);
        await page.$eval(`${row(last)} .np-strip`, (s) => s.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })));
        await page.$eval(".np-mi[data-act='out']", (b) => b.click());
        await until("the menu's put-back shows", (r) => !document.querySelector(r).classList.contains("out"), row(last));

        eq((await W()).decodes, 0, `${ID}: no lane decoded`);
        assert(!errs.length, "page errors: " + errs.slice(0, 4).join(" | "));
        said.push(`${ID}: rows in ${rowsMs} ms, ▶ ${playMs.toFixed(0)} ms (${new URL(mixSrc).pathname.split("/").pop()}), ` +
                  `tap → ${tapAt} s (${tapGaps.gaps * 5} ms silent), drag ${s1.seeked - s0.seeked} seeks → ${dragAt} s ` +
                  `(${dragGaps.gaps * 5} ms silent), 🗑 heard in ${cut.ms.toFixed(0)} ms`);
      });
      // the lane back in on the store, whatever the page did
      const vv = (await sp.call(`/api/cards/${ID}`)).json.versions.at(-1);
      if ((vv.parts || []).some((p) => p.id === lanes[0].id && p.archived))
        await sp.call(`/api/cards/${ID}/signal`, { method: "POST", body: { kind: "archive", voice: lanes[0].id, value: false,
          ...(vv.face_item ? { version: vv.n, item: vv.face_item } : {}) } });
    }
  } finally {
    sp.done();
    await settle();
  }
  log(said.join("; "));
}
