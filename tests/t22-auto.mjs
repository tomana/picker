import { withPage, showTab, assert, eq, sleep, BASE, api } from "./lib.mjs";
export const name = "auto — the order and the style for auto revise, remembered (PUT intercepted)";
const SHOTS = process.env.SHOTS;
export async function run(log) {
  const real = await api("/api/auto");
  const survey = { type: "fx_visual", running: null, criterion: "slowest first",
    ts: Date.now() / 1000 - 600, job: "svfake", stale: false, report: "flok01 5.8 ms\nmagfld1 1.0 ms",
    order: [{ card: "flok01", label: "starling murmuration", why: "5.8 ms over empty", revised: true },
            { card: "magfld1", label: "Magnetosphere", why: "1.0 ms", revised: false }] };
  await withPage(async (page, errs) => {
    let settings = { ...real.settings, on: false, tabs: {} };
    const puts = [];
    // Simulate PUT responses so the check never changes persistent AUTO settings.
    await page.setRequestInterception(true);
    page.on("request", (r) => {
      if (r.method() === "GET" && /\/api\/auto(\?.*)?$/.test(r.url()))
        return r.respond({ status: 200, contentType: "application/json",
                           body: JSON.stringify({ ...real, settings, survey }) });
      if (r.method() === "GET") return r.continue();
      if (r.method() === "PUT" && /\/api\/auto$/.test(r.url())) {
        const body = JSON.parse(r.postData() || "{}");
        puts.push(body);
        const { for: t, kinds, keep, comment, criterion, ...shared } = body;
        settings = { ...settings, ...shared };
        const own = Object.fromEntries(Object.entries({ kinds, keep, comment, criterion }).filter(([, v]) => v !== undefined));
        if (t && Object.keys(own).length)
          settings = { ...settings, tabs: { ...(settings.tabs || {}), [t]: { ...((settings.tabs || {})[t] || {}), ...own } } };
        return r.respond({ status: 200, contentType: "application/json",
                           body: JSON.stringify({ ok: true, ...real, settings, survey }) });
      }
      r.abort();
    });
    await page.evaluate(() => { try { localStorage.removeItem("picker.auto.open"); } catch (_) {} });
    await showTab(page, "fx_visual");
    await page.waitForSelector(".card.compose.autop .phead-tog", { timeout: 30000 });
    await sleep(800);
    const pad = await page.$$eval(".pads button", (bs) => bs.map((b) => `${b.title} ${b.textContent}`));
    eq(pad.filter((t) => /\bauto\b|↻|work the queue/i.test(t)).length, 0,
       `AUTO or ↻ in the pad: ${pad.join(" | ")}`);
    assert(!(await page.$(".autobtn")), "an AUTO button is still in the header");
    const openPanel = async (sel = ".card.compose.autop") => {
      if (!(await page.$(`${sel} .phead.open`))) { await page.click(`${sel} .phead-tog`); await sleep(400); }
    };
    const pill = (sel = ".card.compose.autop") => page.$eval(`${sel} .phead .astat`, (p) => ({ on: p.classList.contains("on"), text: p.textContent }));
    const go = async (sel = ".card.compose.autop") => { await openPanel(sel); return page.$eval(`${sel} .astrip .asgo`, (b) => b.dataset.s); };
    const openSheet = async (sel = ".card.compose.autop") => {
      eq(await go(sel), "▶", "off, the strip's button is ▶");
      assert(!(await page.$(`${sel} .astrip .asset`)), "no sliders on the strip");
      await page.click(`${sel} .astrip .astext`);
    };
    await openSheet();
    await page.waitForSelector(".sheet.auto:not([hidden]) .acrit", { timeout: 15000 });
    const parts = () => page.$$eval(".sheet.auto .asec", (d) => d.map((x) =>
      `${x.classList.contains("k-order") ? "order" : "style"}:${!x.querySelector(".asecb") ? "words"
        : x.querySelector(".asecb").hidden ? "shut" : "open"}`).join());
    eq(await parts(), "order:shut", "the order, one line, shut");
    eq(JSON.stringify(await page.$$eval(".sheet.auto .akind", (bs) => bs.map((b) => [b.textContent, b.classList.contains("on")]))),
       JSON.stringify([["revise", true], ["inspire", false], ["both", false]]), "revise | inspire | both, revise on");
    eq(await page.$eval(".sheet.auto .akeepbox", (x) => x.checked), false, "keep in list until voted: off");
    await page.evaluate(() => [...document.querySelectorAll(".sheet.auto .akind")][2].click());
    await page.evaluate(() => document.querySelector(".sheet.auto .akeepbox").click());
    assert(await page.$eval(".sheet.auto .k-style .ainstr", (x) => x.offsetHeight > 0), "the comment in sight");
    assert(await page.$eval(".sheet.auto .asec.k-order .acrit", (x) => x.offsetHeight === 0), "the criterion behind the order's line");
    assert(!(await page.$(".sheet.auto .aonbar")), "no ON/OFF bar on top");
    const tops = await page.$$eval(".sheet.auto .awho .whotab", (bs) => bs.map((b) => Math.round(b.getBoundingClientRect().top)));
    eq(new Set(tops).size, 1, "the agents are one row");
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/auto-0-folded.png` });
    await page.type(".sheet.auto .ainstr", "make it slower and calmer");
    await page.click(".sheet.auto .asec.k-order .asumt");
    await sleep(200);
    eq(await parts(), "order:open", "a tap on the order's line opens it");
    await page.waitForFunction(() => / · /.test(document.querySelectorAll(".sheet.auto .awho .whotab")[0]?.title || ""), { timeout: 8000 });
    const agents = await page.$$eval(".sheet.auto .awho .whotab", (bs) => bs.map((b) =>
      [b.dataset.agent, b.classList.contains("on"), b.title]));
    eq(agents.length, real.agents.length, "a button per agent");
    eq(agents.filter((a) => a[1]).map((a) => a[0]).join(), real.settings.agent, "the current agent is on");
    const other = agents.find((a) => !a[1])[0];
    await page.evaluate((n) => [...document.querySelectorAll(".sheet.auto .awho .whotab")]
      .find((b) => b.dataset.agent === n).click(), other);
    log(`who revises: ${agents.map((a) => `${a[0]}${a[1] ? "*" : ""} (${a[2]})`).join(" · ")}; picked ${other}`);
    // its models inline, as in the revise menu: on the current agent a tap lights another; a new agent starts on its own
    await page.evaluate((n) => [...document.querySelectorAll(".sheet.auto .awho .whotab")]
      .find((b) => b.dataset.agent === n).click(), real.settings.agent);
    await page.waitForSelector(".sheet.auto .awho .whom", { timeout: 8000 });
    const rows = await page.$$eval(".sheet.auto .awho .whom", (x) => x.map((m) => m.classList.contains("on")));
    assert(rows.length > 1 && rows.filter(Boolean).length === 1, `${real.settings.agent}'s models, one lit: ${rows}`);
    const tap = rows.findIndex((on) => !on);
    await page.evaluate((i) => document.querySelectorAll(".sheet.auto .awho .whom")[i].click(), tap);
    eq(await page.$$eval(".sheet.auto .awho .whom", (x) => x.findIndex((m) => m.classList.contains("on"))), tap,
       "the tapped model is lit");
    await page.evaluate((n) => [...document.querySelectorAll(".sheet.auto .awho .whotab")]
      .find((b) => b.dataset.agent === n).click(), other);
    // back to the first agent: its pick is still lit (browsing the tabs keeps each agent's pick); then the other again
    const tabTo = (n) => page.evaluate((n) => [...document.querySelectorAll(".sheet.auto .awho .whotab")]
      .find((b) => b.dataset.agent === n).click(), n);
    await tabTo(real.settings.agent);
    eq(await page.$$eval(".sheet.auto .awho .whom", (x) => x.findIndex((m) => m.classList.contains("on"))), tap,
       "back on the first agent, its pick is kept");
    await tabTo(other);
    log(`its models inline: ${rows.length} for ${real.settings.agent}, one tapped; then ${other}`);
    eq(await page.$$eval(".sheet.auto .aolist li", (x) => x.length), 2, "the order's two cards");
    assert(await page.$(".sheet.auto details.areport"), "the survey's report");
    const top = await page.$eval(".sheet.auto .aolist li .aol", (x) => ({ text: x.textContent, title: x.title }));
    assert(/^✓ flok\d+$/.test(top.text) && top.title === "starling murmuration", `revised-since mark: ${JSON.stringify(top)}`);
    await page.type(".sheet.auto .acrit", "something else");
    await page.click(".sheet.auto .acritclear");
    eq(await page.$eval(".sheet.auto .acrit", (x) => x.value), "", "clear empties the criterion");
    assert(await page.$eval(".sheet.auto .acritclear", (b) => b.hidden), "and hides itself");
    await page.type(".sheet.auto .acrit", "slowest first");
    const osum = await page.$eval(".sheet.auto .asec.k-order .asumv", (x) => x.textContent);
    assert(/in order: 2 cards, 1 revised/.test(osum), `the order's line says it: ${osum}`);
    log(`0 · the order: 2 cards with reasons, the report, clear, a criterion typed; its line: ${osum}`);
    const step2 = await page.$$eval(".autofoot .sbtn", (bs) => bs.map((b) => b.textContent));
    log(`the sheet offers: ${step2.join(" / ")}`);
    eq(step2.join(), "start", "off, the sheet offers start");
    await page.click(".autofoot .sbtn:not(.astop)");
    await sleep(500);
    eq(puts.length, 1, "one PUT");
    eq(puts[0].criterion, "slowest first", "it carries the criterion");
    eq(puts[0].agent, other, "and the agent picked in the sheet");
    eq(puts[0].model, null, "another agent starts on its own model");
    eq(puts[0].comment, "make it slower and calmer", "and the typed comment");
    eq(JSON.stringify([puts[0].kinds, puts[0].keep]), JSON.stringify([["revise", "inspire"], true]),
       "and what it makes, and keep in list until voted");
    settings = { ...settings, on: false };
    await showTab(page, "fx_visual");
    await page.waitForSelector(".card.compose.autop .phead .astat", { timeout: 15000 });
    await sleep(600);
    await openSheet();
    await page.waitForSelector(".sheet.auto:not([hidden]) .acrit", { timeout: 15000 });
    await sleep(300);
    eq(await page.$eval(".sheet.auto .ainstr", (x) => x.value), "make it slower and calmer",
       "the comment comes back");
    eq(JSON.stringify(await page.$$eval(".sheet.auto .akind.on", (bs) => bs.map((b) => b.textContent))),
       JSON.stringify(["both"]), "and both kinds");
    eq(await page.$eval(".sheet.auto .akeepbox", (x) => x.checked), true, "and keep");
    eq(await page.$eval(".sheet.auto .acrit", (x) => x.value), "slowest first", "and the criterion");
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/auto-2-again.png` });
    log("reopened: the criterion, the comment, the kinds and keep come back");
    eq(puts[0].for, "fx_visual", "the sheet's PUT says which tab it is for");
    settings = { ...settings, on: false, types: [] };
    await showTab(page, "fx_visual");
    await page.waitForSelector(".card.compose.autop .phead .astat", { timeout: 15000 });
    await sleep(600);
    if (await page.$(".card.compose.autop .phead.open")) { await page.click(".card.compose.autop .phead-tog"); await sleep(400); }
    const off = await pill();
    assert(!off.on && /^AUTO\s*off$/.test(off.text), `off, it says AUTO off: ${JSON.stringify(off)}`);
    const shutHead = await page.$eval(".card.compose.autop .phead", (h) => ({ h: Math.round(h.getBoundingClientRect().height),
      others: h.querySelectorAll("button:not(.phead-tog)").length }));
    assert(shutHead.others === 0 && shutHead.h <= 28, `shut, the head is the status alone, 26 px as the others: ${JSON.stringify(shutHead)}`);
    assert(!(await page.$(".card.compose.autop .autobtn")), "no big AUTO button in the panel");
    const n0 = puts.length;
    await openSheet();
    await page.waitForSelector(".sheet.auto:not([hidden]) .autofoot .sbtn", { timeout: 15000 });
    eq(puts.length, n0, "start opened the sheet and wrote nothing");
    await page.click(".autofoot .sbtn:not(.astop)");
    await sleep(800);
    eq(JSON.stringify([puts[n0].on, puts[n0].types, puts[n0].for]), JSON.stringify([true, ["fx_visual"], "fx_visual"]),
       "the sheet's start turns the visual tab on");
    const lit = await pill();
    assert(lit.on && /^AUTO\s*on\s*· \w/.test(lit.text), `on, AUTO on · the agent: ${JSON.stringify(lit)}`);
    const frame = await page.$eval(".card.compose.autop .phead", (h) => {
      const p = getComputedStyle(h.parentElement);
      return { aon: h.classList.contains("aon"), ring: `${p.outlineStyle} ${p.outlineWidth}`,
               pulse: getComputedStyle(h.querySelector(".astate")).animationName };
    });
    assert(frame.aon && frame.ring === "solid 1px" && frame.pulse === "autobreath", `on, the frame and the pulse: ${JSON.stringify(frame)}`);
    eq(await go(), "■", "and the strip's button is ■");
    await page.click(".card.compose.autop .phead-tog");
    await sleep(400);
    assert(!(await page.$(".card.compose.autop .phead.open")), "on, the panel still shuts");
    await openPanel();
    await page.click(".card.compose.autop .astrip .asgo");
    await sleep(800);
    eq(JSON.stringify([puts[n0 + 1].on, puts[n0 + 1].types]), JSON.stringify([false, []]),
       "■ takes it out (no type left: auto revise off)");
    log(`▶ opens the sheet, its start turns the tab on; the pill "${lit.text}"; ■ stops at once; the panel shuts`);
    settings = { ...settings, on: false, types: [] };
    await showTab(page, "fx_music");
    await page.waitForSelector(".card.compose.autop .phead .astat", { timeout: 15000 });
    await sleep(600);
    await openSheet(".card.compose.autop");
    await page.waitForSelector(".sheet.auto:not([hidden]) .acrit", { timeout: 15000 });
    eq(await page.$$eval(".sheet.auto .akind", (x) => x.length), 3, "the music sheet is the same: revise | inspire | both");
    assert(await page.$(".sheet.auto .akeepbox") && await page.$(".sheet.auto .asec.k-order"), "keep, and the order");
    await page.waitForSelector(".sheet.auto:not([hidden]) .autofoot .sbtn", { timeout: 15000 });
    const n1 = puts.length;
    const label = await page.$eval(".autofoot .sbtn", (b) => b.textContent);
    eq(label, "start", "the sheet offers start");
    await page.click(".autofoot .sbtn");
    await sleep(800);
    eq(JSON.stringify([puts[n1].for, puts[n1].on, puts[n1].types]), JSON.stringify(["fx_music", true, ["fx_music"]]),
       "its start is AUTO's, for fx_music");
    assert(puts[n1].agent && !("session_max" in puts[n1]), "carries the agent without a session limit");
    log(`fx_music: the same sheet; its start PUTs /api/auto ${JSON.stringify({ for: puts[n1].for, types: puts[n1].types })}`);
    await showTab(page, "fx_show");
    await page.waitForSelector(".card.compose.autop .phead-tog", { timeout: 15000 });
    await sleep(600);
    const n2 = puts.length;
    await openSheet();
    await page.waitForSelector(".sheet.auto:not([hidden]) .sbody.live", { timeout: 15000 });
    const manifest = (await api("/api/types")).types.find((t) => t.type === "fx_show");
    eq(await page.$eval(".card.compose.autop .phead", (x) => x.title), manifest.auto_placeholder.tooltip,
       "the placeholder tooltip comes from the manifest");
    eq(await page.$eval(".sheet.auto .sbody.live", (x) => x.textContent), manifest.auto_placeholder.description,
       "the placeholder description comes from the manifest");
    eq(await page.$eval(".sheet.auto .shead .t", (x) => x.textContent), manifest.auto_placeholder.title,
       "the placeholder title comes from the manifest");
    eq(puts.length, n2, "and nothing was written");
    await page.keyboard.press("Escape");
    log("show: manifest placeholder copy, nothing written");
    assert(!errs.filter((e) => !/ERR_FAILED|aborted/i.test(e)).length,
           "page errors: " + errs.slice(0, 3).join(" | "));
  });
}
