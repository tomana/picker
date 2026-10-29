import { withPage, showTab, api, assert, eq, sleep, scratchPicker } from "./lib.mjs";
export const name = "panels — one header, and the caret outlives the page";
const heads = (page) => page.evaluate(() => [...document.querySelectorAll(".phead")]
  .map((h) => ({
    label: h.querySelector(".phead-lbl")?.textContent,
    open: h.querySelector(".phead-tog")?.getAttribute("aria-expanded") === "true",
    summary: h.querySelector(".phead-sum")?.textContent || "",
    extras: [...h.children].filter((c) => !c.matches(".phead-tog, .phead-gap")).length,
    w: Math.round(h.querySelector(".phead-tog").getBoundingClientRect().width),
    h: Math.round(h.querySelector(".phead-tog").getBoundingClientRect().height),
  })));
export async function run(log) {
  const sp = await scratchPicker();
  try { await check(sp, log); } finally { sp.done(); }
}
async function check(sp, log) {
  const { types } = await api("/api/types");
  await withPage(async (page, errs) => {
    await sp.route(page, (path) => path === "/api/prefs");
    for (const t of types) {
      await showTab(page, t.type);
      const hs = await heads(page);
      assert(hs.some((h) => h.label === "cup"), `${t.type}: no cup header`);
      for (const h of hs) {
        assert(h.w >= 44 && h.h >= 24,
               `${t.type} "${h.label}" toggle is ${h.w}×${h.h} — too small to aim at`);
      }
      log(`${t.type}: ${hs.map((h) => h.label).join(" + ")}`);
    }
    const t0 = types.find((t) => t.type === "fx_music") || types[0];
    const other = types.find((t) => t.type !== t0.type);
    const baseline = {};
    for (const t of types) {
      baseline[`cup:${t.type}`] = true;
      baseline[`timeline:${t.type}`] = true;
    }
    // Establish state through the API; click writes are fire-and-forget across navigation.
    await sp.call("/api/prefs", { method: "PATCH", body: { panels: baseline } });
    await showTab(page, t0.type);
    await page.evaluate(() =>
      document.querySelectorAll(".phead-tog").forEach((b) => {
        if (b.getAttribute("aria-expanded") === "true") b.click();
      }));
    await sleep(1000);
    const shut = await heads(page);
    eq(shut.filter((h) => h.open).length, 0, "a panel stayed open");
    for (const h of shut) {
      eq(h.summary, "", `closed "${h.label}" is still reporting`);
      eq(h.extras, 0, `closed "${h.label}" still carries ${h.extras} control(s)`);
      assert(/^(AUTOoff|cup|timelines?|Add idea|Add recording)$/.test(h.label || ""),
             `closed row says "${h.label}"`);
    }
    const rows = await page.evaluate(() => [...document.querySelectorAll(
      ".tlwrap, .card.compose.cup")].map((e) => Math.round(e.getBoundingClientRect().height)));
    for (const h of rows) {
      assert(h <= 36, `a minimized panel is ${h}px — it was 46 before it was asked to be thin`);
    }
    log(`minimized rows: ${rows.join("px, ")}px`);
    const bodies = await page.evaluate(() => ({
      tl: !!document.querySelector(".tl-tabs"),
      cup: !!document.querySelector(".card.compose.cup .cnote"),
    }));
    eq(bodies.tl, false, "the timeline body survived being closed");
    eq(bodies.cup, false, "the cup body survived being closed");
    const stray = await page.evaluate(() =>
      /\bnull\b/.test(document.querySelector(".card.compose.cup").textContent));
    eq(stray, false, 'the cup panel printed "null"');
    log(`closed rows say: ${shut.map((h) => h.label).join(" · ")} — and nothing else`);
    await showTab(page, t0.type);
    const back = await heads(page);
    eq(back.filter((h) => h.open).length, 0,
       "a panel re-opened itself across a reload — the state is not server-side");
    log(`after a reload: ${back.map((h) => `${h.label}=${h.open ? "open" : "shut"}`).join(" ")}`);
    if (other) {
      const now = (await sp.call("/api/prefs")).json;
      const mine = Object.entries(now.panels || {})
        .filter(([k]) => k.endsWith(`:${other.type}`));
      eq(mine.filter(([, v]) => v === false).length, 0,
         `closing ${t0.type}'s panels also closed ${other.type}'s: ${JSON.stringify(mine)}`);
      eq(Object.entries(now.panels || {})
        .filter(([k, v]) => k.endsWith(`:${t0.type}`) && v === false).length >= 1, true,
        `${t0.type}'s panels were not recorded as closed`);
      log(`per type: ${JSON.stringify(now.panels)}`);
    }
    {
      const at = async (want) => {
        await page.evaluate((w) => document.querySelectorAll(".phead-tog")
          .forEach((b) => { if ((b.getAttribute("aria-expanded") === "true") !== w) b.click(); }), want);
        await sleep(700);
        return page.evaluate(() => [...document.querySelectorAll(".phead-lbl")].map((e) => {
          const r = e.getBoundingClientRect(), h = e.closest(".phead").getBoundingClientRect();
          return `${Math.round(r.left)},${(r.top - h.top).toFixed(1)},${r.width.toFixed(1)}`; }));
      };
      const opened = await at(true);
      const closed = await at(false);
      eq(new Set(opened.map((o) => o.split(",")[0])).size, 1, `the titles don't share one x: ${opened}`);
      eq(JSON.stringify(opened), JSON.stringify(closed), `the title moves between states: open ${opened} vs shut ${closed}`);
      log(`title at ${closed[0].split(",")[0]}px, ${closed[0].split(",")[1]}px down, in both states`);
    }
    await showTab(page, t0.type);
    await page.evaluate(() => document.querySelectorAll(".phead-tog").forEach((b) => {
      if (b.getAttribute("aria-expanded") === "true") b.click(); }));
    await sleep(700);
    const spans = await page.evaluate(() => [...document.querySelectorAll(
      ".tlwrap, .card.compose.cup")].map((p) => {
        const b = p.querySelector(".phead-tog").getBoundingClientRect();
        const r = p.getBoundingClientRect();
        return Math.round(r.width - b.width);
      }));
    for (const gap of spans) {
      assert(gap <= 10, `${gap}px of the minimized row is not pressable`);
    }
    const edge = await page.evaluate(() => {
      const r = document.querySelector(".tlwrap").getBoundingClientRect();
      return { x: r.right - 14, y: r.top + r.height / 2 };
    });
    await page.mouse.click(edge.x, edge.y);
    await sleep(700);
    eq(await page.evaluate(() =>
      document.querySelector(".tlwrap .phead-tog").getAttribute("aria-expanded")),
      "true", "a tap at the far right of a minimized row did nothing");
    log(`minimized rows are pressable end to end (${spans.join("/")}px dead)`);
    eq(await page.evaluate(() =>
      document.querySelectorAll(".phead.open .phead-x").length > 0), true,
      "an open panel has no ✕");
    const beside = await page.evaluate(() => {
      const x = document.querySelector(".tlwrap .phead-x").getBoundingClientRect();
      const t = document.querySelector(".tlwrap .phead-tog").getBoundingClientRect();
      return { x: x.left - 18, y: x.top + x.height / 2,
               gap: Math.round(x.left - t.right) };
    });
    assert(beside.gap <= 12,
           `${beside.gap}px between the open title row and the ✕ is dead`);
    await page.mouse.click(beside.x, beside.y);
    await sleep(700);
    eq(await page.evaluate(() =>
      document.querySelector(".tlwrap .phead-tog").getAttribute("aria-expanded")),
      "false", "a tap beside the ✕ on an open panel did nothing");
    log(`open title row reaches the ✕ (${beside.gap}px between them)`);
    await page.evaluate(() => document.querySelectorAll(".phead-tog").forEach((b) => {
      if (b.getAttribute("aria-expanded") === "true") b.click(); }));
    await sleep(700);
    const fit = await page.evaluate(() => {
      const out = [];
      for (const p of document.querySelectorAll(".tlwrap, .card.compose.cup")) {
        const t = p.querySelector(".phead-tog");
        const pr = p.getBoundingClientRect(), tr = t.getBoundingClientRect();
        const ps = getComputedStyle(p), ts = getComputedStyle(t);
        out.push({
          inset: [tr.left - pr.left, pr.right - tr.right,
                  tr.top - pr.top, pr.bottom - tr.bottom].map((n) => Math.round(n)),
          radius: parseFloat(ts.borderRadius) || 0,
          clipped: ps.overflow === "hidden",
          plateBg: ps.backgroundColor,
        });
      }
      return out;
    });
    for (const f of fit) {
      assert(f.inset.every((n) => n <= 2),
             `the hover box is inset ${f.inset.join("/")} from the plate`);
      eq(f.radius, 0, `the hover box has its own ${f.radius}px radius inside the plate`);
      eq(f.clipped, true, "the plate does not clip, so a square fill would overflow it");
    }
    const plateBg = fit[1] ? fit[1].plateBg : fit[0].plateBg;
    await showTab(page, t0.type);
    await page.evaluate(() => document.querySelectorAll(".phead-tog").forEach((b) => {
      if (b.getAttribute("aria-expanded") === "true") b.click(); }));
    await sleep(700);
    for (const on of [".card.compose.cup .phead-tog", ".card.compose.cup .phead"]) {
      await page.$eval(on, (e) => e.scrollIntoView({ block: "center" }));
      await sleep(300);
      await page.hover(on);
      await sleep(300);
      const lit = await page.evaluate(() => {
        const h = document.querySelector(".card.compose.cup .phead");
        const hr = h.getBoundingClientRect();
        const pr = document.querySelector(".card.compose.cup").getBoundingClientRect();
        const x = h.querySelector(".phead-x");
        return { bg: getComputedStyle(h).backgroundColor,
                 short: Math.round(pr.width - hr.width),
                 xIn: !x || (x.getBoundingClientRect().right <= hr.right + 1) };
      });
      assert(/rgba?\(/.test(lit.bg) && !/,\s*0\)$/.test(lit.bg),
             `hovering ${on} paints nothing (${lit.bg})`);
      assert(lit.bg !== plateBg,
             `the hover fill is the plate's own colour (${lit.bg})`);
      assert(lit.short <= 2,
             `the lit band stops ${lit.short}px short of the plate`);
      assert(lit.xIn, "the ✕ sits outside the lit band");
    }
    log(`the whole header lights (inset ${fit[0].inset.join("/")}, no radius, ` +
        `${await page.evaluate(() => getComputedStyle(
          document.querySelector(".card.compose.cup .phead")).backgroundColor)})`);
    await showTab(page, t0.type);
    await page.evaluate(() => document.querySelectorAll(".phead-tog").forEach((b) => {
      if (b.getAttribute("aria-expanded") !== "true") b.click(); }));
    await sleep(700);
    await page.evaluate(() => document.querySelector(".tlwrap .phead-x").click());
    await sleep(700);
    eq(await page.evaluate(() =>
      document.querySelector(".tlwrap .phead-tog").getAttribute("aria-expanded")),
      "false", "the ✕ did not minimize the panel");
    eq(await page.evaluate(() =>
      document.querySelectorAll(".phead:not(.open) .phead-x").length), 0,
      "a minimized row still carries a ✕ — it would have nothing to close");
    log("the ✕ minimizes, and is absent once minimized");
    const caps = await page.evaluate(() => {
      const pick = (e) => { const c = getComputedStyle(e);
        return { face: `${c.fontSize} ${c.letterSpacing}`, col: c.color,
                 w: Number(c.fontWeight) }; };
      const shutAll = [...document.querySelectorAll(".phead:not(.open) .phead-lbl")]
        .filter((e) => !e.closest(".addrec") && !e.classList.contains("astat"));
      const one = shutAll[0];
      const probe = Object.assign(document.createElement("span"), { className: "ph" });
      document.querySelector(".cardhead").append(probe);
      const cards = pick(probe);
      probe.remove();
      const white = Object.assign(document.createElement("span"), { style: "color:var(--fg)" });
      document.body.append(white);
      const fg = getComputedStyle(white).color;
      white.remove();
      return { cards, fg,
               shut: pick(one),
               rows: shutAll
                 .map((e) => JSON.stringify(pick(e))) };
    });
    eq(new Set(caps.rows).size, 1, `the two rows are set differently: ${caps.rows}`);
    eq(caps.shut.face, caps.cards.face,
       `shut rows are not set like the cards label: ${caps.shut.face} vs ${caps.cards.face}`);
    eq(caps.shut.col, caps.fg, `shut rows are not the page's white: ${caps.shut.col} vs ${caps.fg}`);
    log(`shut: ${caps.shut.face} ${caps.shut.col} — same as CARDS`);
    await page.evaluate(() => document.querySelectorAll(".phead-tog").forEach((b) => {
      if (b.getAttribute("aria-expanded") !== "true") b.click(); }));
    await sleep(800);
    const open = await page.evaluate(() => {
      const c = getComputedStyle(document.querySelector(".phead.open .phead-lbl"));
      return { col: c.color, w: Number(c.fontWeight), caps: c.textTransform,
               face: `${c.fontSize} ${c.letterSpacing}` };
    });
    eq(open.caps, "uppercase", `open is ${open.caps}, not uppercase`);
    eq(open.w, caps.shut.w, `open is set in another weight: ${open.w} against ${caps.shut.w}`);
    eq(open.col, caps.fg, `open is not the page's white (${open.col})`);
    eq(open.face, caps.shut.face,
       `open letterforms differ from shut: ${open.face} vs ${caps.shut.face}`);
    log(`open: ${open.caps} weight ${open.w} ${open.col} — shut was ` +
        `${caps.shut.w} ${caps.shut.col}, same ${open.face}`);
    assert(!errs.length, "page errors: " + errs.slice(0, 3).join(" | "));
  });
}
