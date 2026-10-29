#!/usr/bin/env node
/* A frozen copy of a running picker, for a static site (GitHub Pages): every request its page makes, and every
   picture and sound its cards name, saved as files; frozen.js answers the page from them. Nothing runs behind it.

       tests/move_check.sh --serve                      (the example picker; it prints its address)
       node tools/freeze/freeze.mjs http://127.0.0.1:PORT site/

   site/ then opens from any folder of any static server. It holds the example picker's made-up cards only. */
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, readFileSync, cpSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url)), PICKER = join(HERE, "..", "..");
const puppeteer = createRequire(join(PICKER, "tests", "package.json"))("puppeteer-core");
const [base, out] = process.argv.slice(2);
if (!base || !out) { console.error("usage: freeze.mjs <picker url> <out dir>"); process.exit(2); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const DROP = new Set(["since", "gen", "t", "_"]);         // as frozen.js keys them
const key = (u) => {
  const x = new URL(u, base);
  const q = [...x.searchParams].filter(([k]) => !DROP.has(k)).sort(([a], [b]) => (a < b ? -1 : 1));
  return x.pathname + (q.length ? "?" + new URLSearchParams(q) : "");
};
const saved = new Map();                                  // key → {type, body}
const STREAMS = /^\/api\/events/;                        // live events: a frozen page has none
async function grab(u) {
  const k = key(u);
  if (saved.has(k) || STREAMS.test(k)) return;
  saved.set(k, null);
  let r;
  try { r = await fetch(new URL(k, base), { signal: AbortSignal.timeout(30000) }); } catch (_) { saved.delete(k); return; }
  if (!r.ok || (r.headers.get("content-type") || "").startsWith("text/event-stream")) { saved.delete(k); return; }
  saved.set(k, { type: (r.headers.get("content-type") || "application/octet-stream").split(";")[0],
                 body: Buffer.from(await r.arrayBuffer()) });
}

// 1. the page, driven as a visitor would: every tab, scrolled, cards opened and stepped, the panels, settings
const browser = await puppeteer.launch({ executablePath: process.env.CHROME || "/usr/bin/google-chrome", headless: "new",
  args: ["--autoplay-policy=no-user-gesture-required", "--mute-audio"] });
const page = await browser.newPage();
await page.setRequestInterception(true);
const asked = new Set();
page.on("request", (r) => {
  const u = new URL(r.url());
  if (u.origin === new URL(base).origin && (r.method() === "GET" || r.method() === "HEAD")) asked.add(u.pathname + u.search);
  return r.method() === "GET" || r.method() === "HEAD" ? r.continue()
    : r.respond({ status: 200, contentType: "application/json", body: "{}" });
});
const types = await (await fetch(new URL("/api/types", base))).json();
const tabs = (Array.isArray(types) ? types : types.types).map((t) => t.type);
console.log(`tabs: ${tabs.join(", ")}`);
for (const [w, h, mobile] of [[1440, 900, false], [390, 844, true]]) {
  console.log(`the page at ${w} px`);
  await page.setViewport({ width: w, height: h, deviceScaleFactor: 1, isMobile: mobile, hasTouch: mobile });
  for (const t of tabs) {
    await page.goto(new URL(`/?tab=${encodeURIComponent(t)}`, base).href, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".grid article.card", { timeout: 30000 }).catch(() => {});
    await sleep(1500);
    for (let y = 0; y < 20; y++) { await page.evaluate(() => scrollBy(0, innerHeight)); await sleep(250); }
    await page.evaluate(() => scrollTo(0, 0));
    await page.evaluate(() => document.querySelectorAll(".phead-tog").forEach((b) => b.click()));
    await sleep(1200);
    const n = await page.$$eval(".grid article.card:not(.compose)", (a) => a.length);
    for (let i = 0; i < Math.min(n, 4); i++) {
      await page.evaluate((i) => { const a = document.querySelectorAll(".grid article.card:not(.compose)")[i];
        a.scrollIntoView({ block: "center" }); (a.querySelector(".media, .vblock") || a).click(); }, i);
      await sleep(1200);
      await page.evaluate(() => document.querySelectorAll(".sheet.big .vrow button, .sheet.big .vbox button").forEach((b) => b.click()));
      await sleep(800);
      await page.keyboard.press("Escape");
      await sleep(300);
    }
  }
  await page.evaluate(() => document.querySelector('button[title^="agents:"]')?.click());
  await sleep(1500);
  await page.keyboard.press("Escape");
}
await browser.close();
console.log(`${asked.size} requests seen; saving them`);
for (const u of asked) await grab(u);

// 2. what the saved answers name: every card whole, every list whole, every picture (and its thumbnails) and sound
for (const t of tabs) {
  for (const q of [`limit=100000&type=${t}`, `type=${t}&archived=1`, `type=${t}`]) await grab(`/api/cards?${q}`);
  await grab(`/api/auto?type=${t}`);
  await grab(`/api/auto/made?type=${t}`);
  await grab(`/api/auto/made?type=${t}&limit=500`);
  const all = JSON.parse(saved.get(key(`/api/cards?limit=100000&type=${t}`)).body);
  for (const c of all.cards) await grab(`/api/cards/${encodeURIComponent(c.id)}`);
}
console.log(`${saved.size} saved; following what they name`);
const named = (s) => [...s.matchAll(/"(\/(?:media|api|static)\/[^"\s]+)"/g)].map((m) => m[1].replace(/\\u0026/g, "&"));
for (let round = 0; round < 2; round++) {
  for (const [, v] of [...saved]) {
    if (!v || v.type !== "application/json") continue;
    for (const u of named(v.body.toString())) {
      await grab(u);
      if (/^\/media\/(?!queue\/)[^/]+\/[^/?]+\.(png|jpe?g|webp)$/i.test(u)) for (const w of [160, 360, 1280]) await grab(`${u}?w=${w}`);
    }
  }
}

// 3. the usage bars: made-up readings, not the machine that froze it
const reset = (h) => new Date(Date.now() + h * 3600e3).toISOString();
saved.set("/api/usage/all", { type: "application/json", body: Buffer.from(JSON.stringify({ generated_at: Date.now() / 1000,
  sources: {
    anthropic: { available: true, windows: [{ key: "session", used_pct: 23, resets_at: reset(3) },
                                             { key: "weekly", used_pct: 41, resets_at: reset(90) }] },
    codex: { available: true, windows: [{ key: "session", used_pct: 12, resets_at: reset(4) },
                                         { key: "weekly", used_pct: 30, resets_at: reset(120) }] },
    agy: { available: true, groups: {
      gemini_models: { name: "Gemini Models", family: "gemini", model_patterns: ["gemini-*"],
                       windows: { "5h": "gemini_models:5h", weekly: "gemini_models:weekly" } },
      claude_and_gpt_models: { name: "Claude and GPT models", family: "claude_gpt", model_patterns: ["claude-*", "gpt-*"],
                               windows: { "5h": "claude_and_gpt_models:5h", weekly: "claude_and_gpt_models:weekly" } } },
      windows: [{ key: "gemini_models:5h", group: "gemini_models", used_pct: 8, resets_at: reset(2) },
                { key: "gemini_models:weekly", group: "gemini_models", used_pct: 15, resets_at: reset(100) },
                { key: "claude_and_gpt_models:5h", group: "claude_and_gpt_models", used_pct: 0, resets_at: reset(5) },
                { key: "claude_and_gpt_models:weekly", group: "claude_and_gpt_models", used_pct: 4, resets_at: reset(140) }] } } })) });

// failed jobs left out of the queue: a frozen copy shows the picker at work, not its made-up failures
for (const [k, v] of saved) {
  if (!v || !k.startsWith("/api/queue") || v.type !== "application/json") continue;
  const d = JSON.parse(v.body.toString());
  if (Array.isArray(d.queue)) v.body = Buffer.from(JSON.stringify({ ...d, queue: d.queue.filter((j) => j.status !== "failed") }));
}

// 4. the site: the saved answers by a hash of what asked for them, the page, its scripts, frozen.js with the index
rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, "r"), { recursive: true });
const EXT = { "application/json": "json", "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif",
              "audio/mpeg": "mp3", "audio/wav": "wav", "audio/x-wav": "wav", "audio/mp4": "m4a", "video/mp4": "mp4",
              "text/javascript": "js", "application/javascript": "js", "text/css": "css", "text/plain": "txt" };
const index = {};
let bytes = 0;
for (const [k, v] of saved) {
  if (!v || k === "/" || k.startsWith("/static/")) continue;
  const f = `r/${createHash("sha1").update(k).digest("hex").slice(0, 16)}.${EXT[v.type] || "bin"}`;
  writeFileSync(join(out, f), v.body);
  index[k] = { f, t: v.type };
  bytes += v.body.length;
}
cpSync(join(PICKER, "static", "app"), join(out, "static", "app"), { recursive: true });
writeFileSync(join(out, "frozen.js"),
  readFileSync(join(HERE, "frozen.js"), "utf8").replace('"@INDEX@"', JSON.stringify(index)));
const shell = readFileSync(join(PICKER, "static", "shell.html"), "utf8")
  .replace('<meta charset="utf-8">', '<meta charset="utf-8">\n<script src="frozen.js"></script>')
  .replace(/<nav class="band"><\/nav><script src="\/static\/band.js"><\/script>/, '<nav class="band"></nav>')
  .replace(/(href|src)="\/static\//g, '$1="static/');
writeFileSync(join(out, "index.html"), shell);
writeFileSync(join(out, ".nojekyll"), "");
console.log(`${Object.keys(index).length} answers, ${(bytes / 1e6).toFixed(1)} MB, ${tabs.length} tabs → ${out}`);
