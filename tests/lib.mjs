import puppeteer from "puppeteer-core";
export const BASE = process.env.PICKER_URL;
if (!BASE) throw new Error("PICKER_URL is not set: the checks run under picker/tests/move_check.sh");
if (new URL(BASE).port === "8080") throw new Error("the checks write: never against :8080");
const CHROME = process.env.CHROME || "/usr/bin/google-chrome";
export function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
export function eq(got, want, msg) {
  if (got !== want) throw new Error(`${msg}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
}
export async function withPage(fn, { width = 412, height = 900, dpr = 2, writes = false } = {}) {
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: "new",
    args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required",
           "--mute-audio"],
  });
  const errs = [];
  try {
    const page = await browser.newPage();
    await page.setViewport({ width, height, deviceScaleFactor: dpr });
    if (!writes) await guardWrites(page);
    page.on("pageerror", (e) => errs.push("pageerror: " + e.message));
    page.on("console", (m) => {
      if (m.type() === "error" && !/favicon/.test(m.text())) errs.push(m.text());
    });
    page.on("response", (r) => {
      if (r.status() >= 400 && !/favicon/.test(r.url()))
        errs.push(`HTTP ${r.status()} ${r.url().replace(BASE, "")}`);
    });
    await page.goto(BASE + "/", { waitUntil: "domcontentloaded", timeout: 60000 });
    return await fn(page, errs);
  } finally {
    await browser.close();
  }
}
async function guardWrites(page) {
  // Browser writes are answered locally unless a check explicitly routes them.
  page.blocked = [];
  await page.setRequestInterception(true);
  const guard = (r) => {
    const m = r.method();
    if (m === "GET" || m === "HEAD") return r.continue();
    page.blocked.push(`${m} ${new URL(r.url()).pathname}`);
    return r.respond({ status: 200, contentType: "application/json", body: "{}" });
  };
  page.on("request", guard);
  const on = page.on.bind(page);
  page.on = (ev, fn) => {
    if (ev === "request" && fn !== guard) page.off("request", guard);
    return on(ev, fn);
  };
}
export async function api(path, { method = "GET", body } = {}) {
  const r = await fetch(BASE + path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) {}
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status} ${text.slice(0, 200)}`);
  return json;
}
export async function showTab(page, type, { view = null } = {}) {
  const q = `?tab=${encodeURIComponent(type)}` + (view ? `&view=${view}` : "");
  await page.goto(BASE + "/" + q, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForSelector("article.card", { timeout: 30000 }).catch(() => {});
  await sleep(900);
}
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export async function scratchArrangement(type, n = 3, sp) {
  assert(sp, "scratchArrangement needs a scratch picker (lib.scratchPicker)");
  const call = async (path, o) => {
    const r = await sp.call(path, o);
    if (r.status >= 400) throw new Error(`scratch ${path} → ${r.status} ${r.text.slice(0, 200)}`);
    return r.json;
  };
  const { cards } = await api(`/api/cards?type=${encodeURIComponent(type)}`);
  const bands = (c) => ((c.versions || []).slice(-1)[0]?.parts || []).filter((p) => p.audio).length;
  const card = cards.find((c) => bands(c) >= n) || cards.find((c) =>
    (c.versions || []).some((v) => (v.parts || []).some((p) => p.audio)));
  assert(card, `no ${type} card with playable parts`);
  const ver = card.versions[card.versions.length - 1];
  const parts = ver.parts.filter((p) => p.audio).slice(0, n);
  const a = await call("/api/arrangements", {
    method: "POST", body: { type, name: `__test ${Date.now()}` },
  });
  let track = 0;
  for (const p of parts) {
    await call(`/api/arrangements/${a.id}/clips`, {
      method: "PUT",
      body: { ref: { card: card.id, version: ver.n, part: p.id },
              track: track++, start: 0, len: (p.time && p.time.len) || 10,
              src_len: ver.duration || 10, label: p.label || p.id },
    });
  }
  const full = await call(`/api/arrangements/${a.id}`);
  return {
    id: a.id, card: card.id, clips: full.clips,
    done: () => {},
  };
}
export async function ensurePanel(page, label, open = true) {
  const did = await page.evaluate(({ lbl, want }) => {
    for (const h of document.querySelectorAll(".phead")) {
      if (h.querySelector(".phead-lbl")?.textContent !== lbl) continue;
      const b = h.querySelector(".phead-tog");
      if ((b.getAttribute("aria-expanded") === "true") === want) return "already";
      b.click();
      return "toggled";
    }
    return "absent";
  }, { lbl: label, want: open });
  if (did === "toggled") await sleep(600);
  return did;
}
export async function openTab(page, name) {
  const ok = await page.evaluate((nm) => {
    const b = [...document.querySelectorAll(".tl-tab-nm")]
      .find((x) => x.textContent.startsWith(nm));
    if (!b) return false;
    b.click();
    return true;
  }, name);
  await sleep(700);
  return ok;
}
export async function scratchPicker() {
  // Fixture writes use a held scratch store; restore prefs and release it on done.
  const call = async (path, { method = "GET", body } = {}) => {
    const r = await fetch(BASE + path, { method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch (_) {}
    return { status: r.status, json, text };
  };
  const held = await call("/__fixture/hold", { method: "POST", body: { on: true } });
  if (held.status !== 200) throw new Error(`fixture hold → ${held.status}`);
  const prefs = (await call("/api/prefs")).json || {};
  return {
    url: BASE,
    call,
    async append(lines) {
      const r = await call("/__fixture/append", { method: "POST", body: lines });
      if (r.status !== 200) throw new Error(`fixture append → ${r.status} ${r.text.slice(0, 200)}`);
    },
    async forward(r) { return r.continue(); },
    done() {
      _pending.push((async () => {
        const r = await call("/api/arrangements");
        const all = (r.json && (r.json.arrangements || r.json)) || [];
        for (const a of Array.isArray(all) ? all : [])
          if (/^__test/.test(a.name || "")) await call(`/api/arrangements/${a.id}`, { method: "DELETE" });
        await call("/__fixture/prefs", { method: "POST", body: { prefs } });
        await call("/__fixture/hold", { method: "POST", body: { on: false } });
      })());
    },
    async route(page, wants, { seen = null } = {}) {
      page.blocked = page.blocked || [];
      await page.setRequestInterception(true);
      page.on("request", (r) => {
        const u = new URL(r.url());
        const m = r.method();
        if (u.origin === new URL(BASE).origin && wants(u.pathname, m)) {
          if (seen) seen.push({ method: m, path: u.pathname + u.search, body: r.postData() || "" });
          return r.continue();
        }
        if (m === "GET" || m === "HEAD") return r.continue();
        page.blocked.push(`${m} ${u.pathname}`);
        return r.respond({ status: 200, contentType: "application/json", body: "{}" });
      });
    },
  };
}
const _pending = [];
export async function settle() { await Promise.allSettled(_pending.splice(0)); }
import { fileURLToPath as _f } from "node:url";
import { join as _j, dirname as _d } from "node:path";
