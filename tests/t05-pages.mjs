import { assert, BASE } from "./lib.mjs";
export const name = "pages — the surfaces beside the grid serve";
const LIVE = ["/", "/api/types", "/api/queue", "/api/arrangements", "/api/usage/all", "/api/plugins", "/static/band.js"];
export async function run(log) {
  for (const p of LIVE) {
    const r = await fetch(BASE + p);
    assert(r.ok, `${p} should serve, answered ${r.status}`);
  }
  log(`${LIVE.length} surfaces serve`);
}
