import puppeteer from "puppeteer-core";
import { existsSync, readFileSync } from "node:fs";
import { BASE } from "./lib.mjs";
const args = process.argv.slice(2);
const cpu = args.includes("--cpu") ? Number(args[args.indexOf("--cpu") + 1]) : 1;
const profile = args.includes("--profile");
const statics = args.includes("--static") ? args[args.indexOf("--static") + 1] : null;
const tabs = args.filter((a, i) => !a.startsWith("--") && !["--cpu", "--static"].includes(args[i - 1]));
const TYPES = { ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".html": "text/html" };
const want = tabs.length ? tabs : ["fx_music", "fx_visual"];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function list(type, page = "") {
  const t0 = Date.now();
  const r = await fetch(`${BASE}/api/cards?type=${type}${page}`);
  const body = Buffer.from(await r.arrayBuffer());
  const ms = Date.now() - t0;
  const gz = await fetch(`${BASE}/api/cards?type=${type}${page}`, { headers: { "Accept-Encoding": "gzip" } });
  const n = JSON.parse(body).cards?.length;
  return { cards: n, bytes: body.length, gzBytes: Number(gz.headers.get("content-length")) || null, ms };
}
function top({ profile: pr }, tab) {
  const self = new Map(), byId = new Map(pr.nodes.map((n) => [n.id, n]));
  pr.samples.forEach((id, i) => {
    const f = byId.get(id).callFrame;
    const k = `${f.functionName || "(anonymous)"} ${(f.url || "").split("/").pop()}:${f.lineNumber + 1}`;
    self.set(k, (self.get(k) || 0) + (pr.timeDeltas[i] || 0));
  });
  const all = [...self.values()].reduce((a, b) => a + b, 0);
  const idle = ["(idle) :0", "(program) :0", "(garbage collector) :0"].map((k) => self.get(k) || 0);
  console.log(`\n${tab}: profile ${(all / 1e3).toFixed(0)} ms (idle ${(idle[0] / 1e3).toFixed(0)}, program ${(idle[1] / 1e3).toFixed(0)}, gc ${(idle[2] / 1e3).toFixed(0)})`);
  for (const [k, v] of [...self].filter(([k]) => !k.startsWith("(idle)")).sort((a, b) => b[1] - a[1]).slice(0, 25))
    console.log(`  ${(v / 1e3).toFixed(1).padStart(7)} ms  ${k}${native(k) ? `  ← ${callers(pr, byId, k)}` : ""}`);
}
const native = (k) => / :0$/.test(k) && !k.startsWith("(");
function callers(pr, byId, key) {
  const parent = new Map();
  for (const n of pr.nodes) for (const c of n.children || []) parent.set(c, n.id);
  const by = new Map();
  pr.samples.forEach((id, i) => {
    const f = byId.get(id).callFrame;
    if (`${f.functionName || "(anonymous)"} ${(f.url || "").split("/").pop()}:${f.lineNumber + 1}` !== key) return;
    let p = byId.get(parent.get(id));
    while (p && !p.callFrame.url) p = byId.get(parent.get(p.id));
    const c = p ? `${p.callFrame.functionName || "(anonymous)"} ${p.callFrame.url.split("/").pop()}:${p.callFrame.lineNumber + 1}` : "?";
    by.set(c, (by.get(c) || 0) + (pr.timeDeltas[i] || 0));
  });
  return [...by].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([c, v]) => `${c} ${(v / 1e3).toFixed(0)}`).join(", ");
}
const browser = await puppeteer.launch({ executablePath: process.env.CHROME || "/usr/bin/google-chrome",
  headless: "new", args: ["--no-sandbox", "--mute-audio"] });
console.log(`picker at ${BASE} · CPU ×${cpu}\n`);
for (const tab of want) {
  const page = await browser.newPage();
  await page.setViewport({ width: 412, height: 900, deviceScaleFactor: 2 });
  await page.setRequestInterception(true);
  page.on("request", (r) => {
    if (r.method() !== "GET" && r.method() !== "HEAD") return r.respond({ status: 200, contentType: "application/json", body: "{}" });
    const p = new URL(r.url()).pathname, f = statics && p.startsWith("/static/") && `${statics}${p}`;
    if (f && existsSync(f))
      return r.respond({ status: 200, contentType: TYPES[p.slice(p.lastIndexOf("."))] || "application/octet-stream",
                         body: readFileSync(f) });
    return r.continue();
  });
  const cdp = await page.target().createCDPSession();
  if (cpu > 1) await cdp.send("Emulation.setCPUThrottlingRate", { rate: cpu });
  await page.evaluateOnNewDocument(() => {
    window.__long = [];
    new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__long.push(e.duration); })
      .observe({ type: "longtask", buffered: true });
  });
  const q = tab === "archive" ? "?tab=fx_visual&view=archive" : `?tab=${tab}`;
  if (profile) { await cdp.send("Profiler.enable"); await cdp.send("Profiler.setSamplingInterval", { interval: 200 });
                 await cdp.send("Profiler.start"); }
  const t0 = Date.now();
  await page.goto(`${BASE}/${q}`, { waitUntil: "domcontentloaded", timeout: 120000 });
  await page.waitForSelector(".grid article.card", { timeout: 120000 });
  const first = Date.now() - t0;
  let n = 0, same = 0;
  while (same < 4) {
    await sleep(250);
    const m = await page.$$eval(".grid article.card", (x) => x.length);
    same = m === n ? same + 1 : 0;
    n = m;
  }
  const built = Date.now() - t0 - 1000;
  if (profile) { top(await cdp.send("Profiler.stop"), `${tab}, the load`); await cdp.send("Profiler.start"); }
  const loadLong = await page.evaluate(() => window.__long.splice(0));
  const s0 = Date.now();
  await page.evaluate(async () => {
    const step = innerHeight * 0.9;
    for (let y = 0; y < document.documentElement.scrollHeight; y += step) {
      scrollTo(0, y);
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    }
  });
  const scrollMs = Date.now() - s0;
  if (profile) top(await cdp.send("Profiler.stop"), `${tab}, the scroll`);
  const scrollLong = await page.evaluate(() => window.__long.splice(0));
  const m = await page.metrics();
  const dom = await page.evaluate(() => document.getElementsByTagName("*").length);
  const l = tab === "archive" ? null : await list(tab);
  const p1 = tab === "archive" ? null : await list(tab, "&limit=24");
  const sum = (a) => Math.round(a.reduce((x, y) => x + y, 0));
  console.log(`${tab.padEnd(9)} ${l ? `list ${l.cards} cards, ${(l.bytes / 1e6).toFixed(2)} MB (gz ${l.gzBytes ? (l.gzBytes / 1e6).toFixed(2) + " MB" : "?"}), ${l.ms} ms · `
                                     + `first page ${(p1.bytes / 1e3).toFixed(0)} KB (gz ${p1.gzBytes ? (p1.gzBytes / 1e3).toFixed(0) : "?"} KB), ${p1.ms} ms · ` : ""}`
    + `first card ${first} ms · ${n} built by ${built} ms · ${dom} DOM nodes · heap ${(m.JSHeapUsedSize / 1e6).toFixed(0)} MB`
    + ` · load: ${loadLong.length} long tasks, ${sum(loadLong)} ms, max ${Math.round(Math.max(0, ...loadLong))}`
    + ` · scroll: ${scrollMs} ms, ${scrollLong.length} long, max ${Math.round(Math.max(0, ...scrollLong))}`);
  await page.close();
}
await browser.close();
