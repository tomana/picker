import { withPage, assert, eq, sleep, api, BASE } from "./lib.mjs";
const SHOTS = process.env.SHOTS;
export const name = "the original recording's head — a tap or a drag moves it, silently, and the sound comes back where it lands; ▶ goes on from it, a stop leaves it, past the stretch it plays on";

// every element that plays; the volume at each jump of one that is playing (a jump on a sounding waveform is a click)
const SPY = () => {
  const S = window.__s = { media: new Set(), jumps: [] };
  const P = HTMLMediaElement.prototype, play = P.play;
  P.play = function (...a) {
    if (!S.media.has(this)) {
      S.media.add(this);
      this.addEventListener("seeking", () => { if (!this.paused) S.jumps.push(this.volume); });
    }
    return play.apply(this, a);
  };
  S.on = () => [...S.media].find((e) => !e.paused && !e.ended) || null;
};

export async function run(log) {
  const { cards } = await api("/api/cards?type=music");
  const c = cards.find((x) => x.origin?.span && x.lineage?.parent);
  assert(c, "a card made from a recording");
  const span = c.origin.span, dur = (await api(`/api/cards/${c.lineage.parent}`)).versions[0].duration;
  const stretchEnd = span.start + span.dur;
  assert(stretchEnd < dur - 2, `the recording goes on past the stretch: ${span.start}+${span.dur} of ${dur}`);

  await withPage(async (page, errs) => {
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    await page.evaluateOnNewDocument(SPY);
    await page.goto(`${BASE}/?tab=music&card=${c.id}`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".sheet.big:not([hidden]) .origrow .origbar .vline", { timeout: 20000 });
    await sleep(300);
    await page.$eval(".origrow", (r) => r.scrollIntoView({ block: "center" }));
    await sleep(200);

    const bar = () => page.$eval(".origbar .lane", (l) => { const r = l.getBoundingClientRect(); return { x: r.left, y: r.top + r.height / 2, w: r.width }; });
    const head = () => page.evaluate(() => {
      const l = document.querySelector(".origbar .lane").getBoundingClientRect(), v = document.querySelector(".origbar .vline");
      return v && { f: (v.getBoundingClientRect().left - l.left) / l.width, t: v.dataset.t ?? null };
    });
    const sound = () => page.evaluate(() => { const e = window.__s.on(); return e && { at: e.currentTime, vol: e.volume }; });
    const jumps = () => page.evaluate(() => window.__s.jumps.length);
    const near = (got, want, tol, what) => assert(Math.abs(got - want) <= tol, `${what}: got ${got}, want ${want} ± ${tol}`);
    const on = () => page.$eval(".origpb", (b) => b.classList.contains("on"));
    const press = () => page.$eval(".origpb", (b) => b.click());
    const back = () => page.waitForFunction(() => { const e = window.__s.on(); return e && e.volume === 1; }, { timeout: 4000 });
    const drag = async (f0, f1, { lift = true } = {}) => {
      const b = await bar();
      await page.touchscreen.touchStart(b.x + b.w * f0, b.y);
      for (let k = 1; k <= 20; k++) { await page.touchscreen.touchMove(b.x + b.w * (f0 + (f1 - f0) * k / 20), b.y); await sleep(16); }
      if (lift) await page.touchscreen.touchEnd();
    };
    const secs = (f) => f * dur;

    // at rest: on the stretch's start, no time over the label; nothing sounds
    near((await head()).f, span.start / dur, 0.01, "at rest the head is on the stretch's start");
    eq((await head()).t, null, "at rest it says no time");
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/original-rest.png` });

    // a tap and a drag at rest move it, and start nothing
    const b0 = await bar();
    await page.touchscreen.tap(b0.x + b0.w * 0.5, b0.y);
    await sleep(150);
    near((await head()).f, 0.5, 0.01, "a tap puts the head there");
    await drag(0.5, 0.3);
    await sleep(150);
    near((await head()).f, 0.3, 0.01, "a drag puts the head there");
    assert((await head()).t, "a moved head says its time");
    eq(await sound(), null, "moving the head at rest starts nothing");

    // an up-and-down swipe on the bar isn't a move
    const before = (await head()).f;
    await page.touchscreen.touchStart(b0.x + b0.w * 0.7, b0.y);
    for (let k = 1; k <= 8; k++) { await page.touchscreen.touchMove(b0.x + b0.w * 0.7, b0.y - k * 10); await sleep(16); }
    await page.touchscreen.touchEnd();
    await sleep(200);
    near((await head()).f, before, 0.005, "a vertical swipe leaves the head");

    // ▶ goes on from it
    await page.$eval(".origrow", (r) => r.scrollIntoView({ block: "center" }));
    await drag(0.3, span.start / dur + 0.02);
    await sleep(150);
    const f1 = (await head()).f;
    await press();
    await page.waitForFunction(() => { const e = window.__s.on(); return e && e.currentTime > 0 && e.readyState >= 3; }, { timeout: 8000 });
    near((await sound()).at, secs(f1), 1, "▶ plays from the head");
    await sleep(300);

    // a drag while it sounds: silent, the head under the finger, one jump, the sound back where it lands
    const j0 = await jumps();
    await drag((await head()).f, 0.6, { lift: false });
    await sleep(100);
    assert((await sound()).vol <= 0.02, `silent during the drag: ${(await sound()).vol}`);
    near((await head()).f, 0.6, 0.01, "the head is under the finger");
    eq(await jumps(), j0, "no jump until it lands");
    await page.touchscreen.touchEnd();
    await back();
    eq(await jumps(), j0 + 1, "one jump for the whole drag");
    assert(await on(), "it still plays");
    const landed = await sound();
    near(landed.at, secs(0.6), 1, "the sound is where the head landed");
    await sleep(500);
    assert((await sound()).at > landed.at, "and goes on");
    near((await head()).f * dur, (await sound()).at, 1, "the head follows the sound again");
    const silent = async (from, what) => {
      const vols = await page.evaluate((n) => window.__s.jumps.slice(n), from);
      assert(vols.length && vols.every((v) => v <= 0.02), `${what}: the volume at its jumps ${JSON.stringify(vols)}`);
    };
    await silent(j0, "the drag's jump is silent");
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/original-playing.png` });

    // a tap while it sounds: the same; past the stretch it plays on
    const j1 = await jumps(), pastF = (stretchEnd + 1) / dur, b1 = await bar();
    await page.touchscreen.tap(b1.x + b1.w * pastF, b1.y);
    await sleep(120);
    await back();
    const past = await sound();
    near(past.at, stretchEnd + 1, 1, "a tap jumps past the stretch");
    await silent(j1, "the tap's jump is silent");
    await sleep(600);
    assert(await on(), "past the stretch it plays on");

    // pause: the head stays, ▶ goes on from there
    await press();
    await sleep(150);
    eq(await on(), false, "paused");
    const rested = await head();
    near(rested.f * dur, past.at + 0.6, 1, "paused, the head stays where the sound was");
    await press();
    await page.waitForFunction(() => { const e = window.__s.on(); return e && e.readyState >= 3; }, { timeout: 8000 });
    near((await sound()).at, rested.f * dur, 1, "▶ goes on from the head");
    await back();

    // from inside the stretch it stops at the stretch's end, and the head goes back to its start
    await drag((await head()).f, (stretchEnd - 0.5) / dur);
    await back();
    await page.waitForFunction(() => !document.querySelector(".origpb.on"), { timeout: 5000 });
    near((await head()).f, span.start / dur, 0.01, "the end of the stretch: back to its start");
    eq((await head()).t, null, "and no time");

    // a sound stopped in the middle of a drag leaves the next one at full volume
    await press();
    await back();
    await drag((await head()).f, 0.6, { lift: false });
    await sleep(100);
    assert((await sound()).vol <= 0.02, "silent during the drag");
    await page.evaluate(() => document.querySelector('.scrim[data-kind="big"]').click());
    await page.touchscreen.touchEnd();
    await sleep(200);
    eq(await sound(), null, "the sheet's close stopped it");
    await page.waitForFunction(() => document.querySelector(".grid .vplay"), { timeout: 8000 });
    await page.evaluate(() => { const b = document.querySelector(".grid .vplay"); b.scrollIntoView({ block: "center" }); b.click(); });
    await page.waitForFunction(() => { const e = window.__s.on(); return e && e.readyState >= 3; }, { timeout: 8000 });
    await sleep(100);
    eq((await sound()).vol, 1, "the next sound is at full volume");
    eq(errs.length, 0, `page errors: ${errs.join(" | ")}`);
    log(`${c.id}: stretch ${span.start}–${stretchEnd} s of ${dur} s: moved at rest, one silent jump per drag, played on past the stretch, stopped at its end`);
  });

  // a mouse too
  await withPage(async (page, errs) => {
    await page.evaluateOnNewDocument(SPY);
    await page.goto(`${BASE}/?tab=music&card=${c.id}`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".sheet.big:not([hidden]) .origrow .origbar .vline", { timeout: 20000 });
    await sleep(300);
    await page.$eval(".origrow", (r) => r.scrollIntoView({ block: "center" }));
    await sleep(200);
    const b = await page.$eval(".origbar .lane", (l) => { const r = l.getBoundingClientRect(); return { x: r.left, y: r.top + r.height / 2, w: r.width }; });
    await page.mouse.move(b.x + b.w * 0.2, b.y);
    await page.mouse.down();
    await page.mouse.move(b.x + b.w * 0.7, b.y, { steps: 12 });
    await page.mouse.up();
    await sleep(150);
    const f = await page.evaluate(() => { const l = document.querySelector(".origbar .lane").getBoundingClientRect();
      return (document.querySelector(".origbar .vline").getBoundingClientRect().left - l.left) / l.width; });
    assert(Math.abs(f - 0.7) <= 0.01, `a mouse drags it: ${f}`);
    eq(errs.length, 0, `page errors: ${errs.join(" | ")}`);
    log(`a mouse drags it to ${f.toFixed(2)}`);
  });
}
