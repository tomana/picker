/* Finger flings on a phone-size page: what shows up not ready while the grid moves (cards not built yet, pictures not
   loaded, rows not fetched), at each look-ahead distance. A measuring tool, not a check (move_check doesn't run it).

     PICKER_URL=… node tests/fling.mjs <tab> [--cpu 4] [--rtt 60] [--speeds 2000,4000,8000] [--ahead 1,2,3] [--rows 1,2,3]
                                         [--swipes 6] [--eager]

   --ahead sets --grid-ahead (screens built ahead); --rows sets --rows-ahead (screens of card data fetched ahead),
   from outside, on the page's root. A frame "shows a gap" when any of those is inside the viewport. */
import puppeteer from "puppeteer-core";

const BASE = process.env.PICKER_URL;
if (!BASE) throw new Error("PICKER_URL is not set");
const args = process.argv.slice(2);
const opt = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const tab = args.find((a, i) => !a.startsWith("--") && !(args[i - 1] || "").startsWith("--")) || "fx_visual";
const cpu = Number(opt("--cpu", 4)), rtt = Number(opt("--rtt", 60));
const speeds = opt("--speeds", "2000,4000,8000").split(",").map(Number);
const aheads = opt("--ahead", "3").split(",").map(Number), rows = opt("--rows", "").split(",").filter(Boolean).map(Number);
const swipes = Number(opt("--swipes", 6)), eager = args.includes("--eager");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({ executablePath: process.env.CHROME || "/usr/bin/google-chrome", headless: "new",
  args: ["--mute-audio", "--autoplay-policy=no-user-gesture-required"] });

async function run(ahead, rowsAhead, speed) {
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
  await page.setRequestInterception(true);
  let fetches = 0;
  page.on("request", (r) => {
    if (/[?&]ids=/.test(r.url())) fetches++;
    return (r.method() === "GET" || r.method() === "HEAD") ? r.continue()
      : r.respond({ status: 200, contentType: "application/json", body: "{}" });
  });
  const cdp = await page.target().createCDPSession();
  if (cpu > 1) await cdp.send("Emulation.setCPUThrottlingRate", { rate: cpu });
  await cdp.send("Network.enable");
  await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: rtt, downloadThroughput: 20e6 / 8,
                                                       uploadThroughput: 5e6 / 8 });
  if (eager) await page.evaluateOnNewDocument(() => { window.__eager = true; });
  await page.evaluateOnNewDocument((ahead, rowsAhead) => {
    const set = () => {
      const r = document.documentElement;
      if (!r) return;
      r.style.setProperty("--grid-ahead", String(ahead));
      if (rowsAhead) r.style.setProperty("--rows-ahead", String(rowsAhead));
    };
    set();
    document.addEventListener("readystatechange", set);
    if (window.__eager) {                               // --eager: the grid's pictures load when their card is built
      const set0 = Element.prototype.setAttribute;
      Element.prototype.setAttribute = function (n, v) { if (n === "loading" && this.tagName === "IMG") return; return set0.call(this, n, v); };
    }
  }, ahead, rowsAhead || 0);
  await page.goto(`${BASE}/?tab=${encodeURIComponent(tab)}`, { waitUntil: "domcontentloaded", timeout: 120000 });
  await page.waitForSelector(".grid article.card:not(.compose)", { timeout: 120000 });
  await sleep(4000);
  // the sampler: every frame, what inside the viewport isn't ready. It looks only inside the blocks in view (kept by an
  // IntersectionObserver), so it costs the page little while it moves
  await page.evaluate(() => {
    window.__f = [];
    const vis = new Set(), seen = new WeakSet();
    const io = new IntersectionObserver((es) => { for (const e of es) (e.isIntersecting ? vis.add : vis.delete).call(vis, e.target); });
    const watch = () => document.querySelectorAll(".grid .gblock").forEach((b) => { if (!seen.has(b)) { seen.add(b); io.observe(b); } });
    watch();
    new MutationObserver(watch).observe(document.querySelector(".grid"), { childList: true });
    let last = performance.now();
    const tick = (now) => {
      const vh = innerHeight, inView = (e) => { const r = e.getBoundingClientRect(); return r.bottom > 0 && r.top < vh && r.height > 0; };
      let slots = 0, stubs = 0, pics = 0;
      for (const b of vis) {
        if (!b.isConnected) { vis.delete(b); continue; }
        for (const ph of b.querySelectorAll(":scope > .cardph")) if (inView(ph)) { slots++; if (ph.classList.contains("nodata")) stubs++; }
        for (const i of b.querySelectorAll("article.card img[src]"))
          if (i.getAttribute("src") && !(i.complete && i.naturalWidth) && inView(i)) pics++;
      }
      window.__f.push({ dt: now - last, slots, stubs, pics, y: scrollY });
      last = now;
      if (!window.__stop) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  // a fling: headless Chrome drives no touch gestures, so wheel gestures (scrolled by the compositor, as a finger's are)
  // at the start speed, then slower and slower: five steps of ~0.12 s, each 0.6 of the one before
  for (let i = 0; i < swipes; i++) {
    for (let k = 0, v = speed; k < 5; k++, v *= 0.6)
      await cdp.send("Input.synthesizeScrollGesture", { x: 195, y: 650, yDistance: -Math.round(v * 0.12), speed: Math.round(v),
                                                         gestureSourceType: "mouse", preventFling: true });
    await sleep(250);                                  // the finger lifts and comes down again
  }
  await sleep(1500);
  const f = await page.evaluate(() => { window.__stop = true; return window.__f; });
  await page.close();
  const gap = f.filter((x) => x.slots || x.pics);
  return { frames: f.length, travelled: Math.round(Math.max(...f.map((x) => x.y))),
           gapPct: f.length ? Math.round((100 * gap.length) / f.length) : 0,
           slotFrames: f.filter((x) => x.slots).length, picFrames: f.filter((x) => x.pics).length,
           stubFrames: f.filter((x) => x.stubs).length, maxSlots: Math.max(0, ...f.map((x) => x.slots)),
           long: f.filter((x) => x.dt > 50).length, maxDt: Math.round(Math.max(0, ...f.map((x) => x.dt))), fetches };
}

console.log(`${tab} · ${BASE} · 390×844 · CPU ×${cpu} · RTT ${rtt} ms · ${swipes} flings`);
console.log("ahead rows speed  frames travelled  gap%  unbuilt-frames  no-picture-frames  no-data-frames  max-unbuilt  long>50ms  max-frame  row-fetches");
for (const ahead of aheads) for (const r of (rows.length ? rows : [0])) for (const speed of speeds) {
  const m = await run(ahead, r, speed);
  console.log(`${String(ahead).padStart(5)} ${String(r || "-").padStart(4)} ${String(speed).padStart(5)}  ${String(m.frames).padStart(6)} ${String(m.travelled).padStart(9)}`
    + `  ${String(m.gapPct).padStart(4)}  ${String(m.slotFrames).padStart(14)}  ${String(m.picFrames).padStart(17)}  ${String(m.stubFrames).padStart(14)}`
    + `  ${String(m.maxSlots).padStart(11)}  ${String(m.long).padStart(9)}  ${String(m.maxDt).padStart(9)}  ${String(m.fetches).padStart(11)}`);
}
await browser.close();
