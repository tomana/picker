#!/usr/bin/env node
import { readdirSync } from "node:fs";
import { pathToFileURL } from "node:url";
let lib;
try {
  lib = await import("./lib.mjs");
} catch (e) {
  if (/puppeteer-core/.test(e.message)) {
    console.error("puppeteer-core is not installed.\n" +
                  "  cd picker/tests && npm install\n" +
                  "It drives a Chrome that is already on this machine " +
                  "(/usr/bin/google-chrome); it does not download one.");
    process.exit(2);
  }
  if (/PICKER_URL|never against/.test(e.message)) { console.error(e.message); process.exit(2); }
  throw e;
}
const { BASE } = lib;
const only = process.argv.slice(2);
const pat = /^(fx|t)\d+-.*\.mjs$/;
const dir = process.env.CHECKS_DIR ? pathToFileURL(process.env.CHECKS_DIR.replace(/\/?$/, "/")) : new URL(".", import.meta.url);
const files = readdirSync(dir)
  .filter((f) => pat.test(f)).sort((a, b) => (a[0] === b[0] ? a.localeCompare(b) : a.startsWith("fx") ? -1 : 1))
  .filter((f) => !only.length || only.some((o) => f.includes(o)));
try {
  const r = await fetch(BASE + "/api/types");
  if (!r.ok) throw new Error(String(r.status));
} catch (e) {
  console.error(`no picker at ${BASE} (${e.message}): the checks run under move_check.sh`);
  process.exit(2);
}
console.log(`picker at ${BASE}\n`);
let failed = 0, ran = 0;
const t0 = Date.now();
for (const f of files) {
  const mod = await import(new URL(f, dir).href);
  ran++;
  const started = Date.now();
  const lines = [];
  try {
    await mod.run((m) => lines.push(m));
    console.log(`PASS  ${mod.name}  (${((Date.now() - started) / 1000).toFixed(1)}s)`);
  } catch (e) {
    failed++;
    console.log(`FAIL  ${mod.name}  (${((Date.now() - started) / 1000).toFixed(1)}s)`);
    console.log(`        ${e.message}`);
  }
  for (const l of lines) console.log(`        ${l}`);
  await lib.settle();
}
console.log(`\n${ran - failed}/${ran} passed in ` +
            `${((Date.now() - t0) / 1000).toFixed(0)}s`);
process.exit(failed ? 1 : 0);
