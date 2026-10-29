import { withPage, assert, eq, sleep, BASE, showTab } from "./lib.mjs";
export const name = "fixture — version selection, timeline clips, persistent votes, AUTO actions, and metadata chips";
const pipOn = (page) => page.$$eval(".sheet.big .vpip", (bs) => bs.findIndex((b) => b.classList.contains("on")));
export async function run(log) {
  await withPage(async (page) => {
    const sent = [];
    page.on("request", (r) => {
      if (r.method() !== "GET") sent.push({ m: r.method(), path: new URL(r.url()).pathname, body: r.postData() || "" });
    });
    await page.goto(`${BASE}/?card=fx3d4e5f6071`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".sheet.big textarea", { timeout: 20000 });
    await sleep(600);
    await page.type(".sheet.big textarea", "zz a revise of the only version");
    await page.evaluate(() => [...document.querySelectorAll(".sheet.big .acts button")]
      .find((b) => /revise/.test(b.textContent)).click());
    await sleep(500);
    await page.evaluate(() => { const p = document.querySelector(".whopop");
      const b = p && (p.querySelector(".whom.on") || p.querySelector(".whom")); if (b) b.click(); });
    await sleep(1200);
    const job = sent.filter((x) => x.m === "POST" && x.path === "/api/queue").map((x) => JSON.parse(x.body)).at(-1);
    assert(job && job.card === "fx3d4e5f6071", `the revise wasn't sent: ${JSON.stringify(sent.slice(-3))}`);
    eq(job.version, 1, "a one-version made card sends its version");
    await page.goto(`${BASE}/?card=fxspr1`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".sheet.big .vpip", { timeout: 20000 });
    eq((await page.$$eval(".sheet.big .vpip span", (x) => x.map((s) => s.textContent))).join(" "), "v2 v5",
       "the sparse stack's strip");
    log(`one-version card sent version ${job.version}; the sparse strip reads v2 v5`);
    await page.goto(`${BASE}/?card=fxsame000001`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".sheet.big .vpip", { timeout: 20000 });
    await page.evaluate(() => document.querySelectorAll(".sheet.big .vpip")[1].click());
    await sleep(700);
    sent.length = 0;
    await page.evaluate(() => {
      const row = [...document.querySelectorAll(".sheet.big .vrowc")].find((r) => /drone/.test(r.textContent));
      row.querySelector('[title="add this band to the timeline"]').click();
    });
    await sleep(1500);
    const clip = sent.filter((x) => x.m === "PUT" && /\/clips/.test(x.path)).map((x) => JSON.parse(x.body)).at(-1);
    assert(clip, `no clip written: ${JSON.stringify(sent)}`);
    eq(clip.ref.version, 2, "the clip's version");
    eq(clip.ref.part, "drone", "the clip's lane");
    eq(clip.len, 10, "the clip's length (v2 is 10 s; v1 8 s)");
    log(`timeline add on v2's drone wrote ${JSON.stringify(clip.ref)}, ${clip.len} s`);
    await page.goto(`${BASE}/?card=fxsame000001`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".sheet.big .vpip", { timeout: 20000 });
    const vote = (sign) => page.evaluate((s) => [...document.querySelectorAll(".sheet.big .cfoot .vcell")]
      .find((b) => b.textContent.trim().startsWith(s)).click(), sign);
    const votesSent = () => sent.filter((x) => x.m === "POST" && /fxsame000001\/signal$/.test(x.path))
      .map((x) => JSON.parse(x.body)).filter((b) => b.kind === "vote").map((b) => b.version);
    await page.evaluate(() => document.querySelectorAll(".sheet.big .vpip")[0].click());
    await sleep(500);
    await vote("+");
    await sleep(1600);
    eq(await pipOn(page), 0, "a vote on v1 stays on v1");
    await page.evaluate(() => document.querySelectorAll(".sheet.big .vpip")[2].click());
    await sleep(500);
    await page.evaluate(() => document.querySelector(".sheet.big .vplay").click());
    await sleep(500);
    await vote("−");
    await sleep(1600);
    eq(await pipOn(page), 2, "a vote on v3 while it plays stays on v3");
    eq(votesSent().join(), "1,3", "each vote names the version it was on");
    log("votes on v1 and playing v3 each stayed on their selected version");
    await page.goto(`${BASE}/?card=fxsame000001`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".sheet.big .vpip", { timeout: 20000 });
    const chipsOn = async (i) => {
      await page.evaluate((k) => document.querySelectorAll(".sheet.big .vpip")[k].click(), i);
      await sleep(600);
      return page.evaluate(() => {
        const box = document.querySelector(".sheet.big .cdtags"), id = document.querySelector(".sheet.big .cdid");
        const r = id.getBoundingClientRect();
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        const chips = [...document.querySelectorAll(".sheet.big .cdtag")];
        const reach = chips.every((c) => {
          c.scrollIntoView({ block: "nearest", inline: "nearest" });
          const a = c.getBoundingClientRect(), b = box.getBoundingClientRect();
          return a.left >= b.left - 1 && a.right <= b.right + 1;
        });
        return { texts: chips.map((c) => c.textContent), m: chips.filter((c) => c.classList.contains("m")).map((c) => c.textContent),
                 idClear: !!hit && id.contains(hit), reach, scrolls: !!box && box.scrollWidth > box.clientWidth + 1,
                 notes: [...([...document.querySelectorAll(".sheet.big .cdsec")].at(-1) || document.body).querySelectorAll(".cdmut")]
                   .map((r) => r.textContent).join() };
      });
    };
    const chips = [];
    for (const i of [0, 1, 2, 3]) chips.push(await chipsOn(i));
    eq(chips[0].texts.join(" "), "transcribe demucs snap claude claude-opus-5-5 high", "v1's chips: the method, its settings, who");
    eq(chips[1].texts.join(" "), "free codex gpt-6.1-sol", "v2's: the method once, though its settings repeat it");
    eq(chips[2].texts.join(" "), "fixture none", "v3, no method: who made it, the only chips");
    eq(chips[3].texts.length, 11, "v4's eleven: the method, eight settings, who");
    eq(chips.map((x) => x.m.join()).join("|"), "transcribe|free||explore", "the marked chip is the method, each time");
    eq(chips[1].notes, "v16-parent · a long note the agent wrote about the bassline, which is never a chip",
       "v2's notes: a grey line of their own under the rationale, not chips");
    eq(chips[0].notes, "", "v1 has no notes: no notes line");
    assert(chips.every((x) => x.idClear), `the id is under a chip: ${JSON.stringify(chips.map((x) => x.idClear))}`);
    assert(chips[3].scrolls && chips.every((x) => x.reach), `a chip can't be scrolled to: ${JSON.stringify(chips.map((x) => [x.scrolls, x.reach]))}`);
    log(`metadata chips: v1 "${chips[0].texts.join(" · ")}"; v2 "${chips[1].texts.join(" · ")}", its notes under the rationale; v3 "${chips[2].texts.join(" · ")}"; v4 ${chips[3].texts.length}, scrolled to each; the id clear`);
    await page.keyboard.press("Escape");
    await sleep(400);
    await showTab(page, "fx_visual");
    const sel = ".card.compose.autop";
    const opened = !(await page.$(`${sel} .phead.open`));
    if (opened) { await page.click(`${sel} .phead-tog`); await sleep(400); }
    await page.click(`${sel} .astrip .asgo`);
    await page.waitForSelector(".sheet.auto:not([hidden]) .autofoot", { timeout: 15000 });
    await sleep(500);
    // the actions at the sheet's foot, under its body
    const geo = await page.evaluate(() => {
      const sh = document.querySelector(".sheet.auto"), foot = sh.querySelector(".autofoot"), body = sh.querySelector(".sbody");
      const r = foot.querySelector("button").getBoundingClientRect(), s = sh.getBoundingClientRect();
      return { last: sh.lastElementChild === foot, below: foot.getBoundingClientRect().top >= body.getBoundingClientRect().bottom - 1,
               inSheet: r.bottom <= s.bottom + 1, y: Math.round(r.top) };
    });
    assert(geo.last && geo.below && geo.inSheet, `AUTO's actions at the sheet's foot: ${JSON.stringify(geo)}`);
    log(`AUTO actions at the sheet's foot (y ${geo.y}), under its body`);
    await page.keyboard.press("Escape");
    await sleep(600);
    if (opened && (await page.$(`${sel} .phead.open`))) { await page.click(`${sel} .phead-tog`); await sleep(400); }
    assert(!opened || !(await page.$(`${sel} .phead.open`)), "the AUTO panel left shut, as it was");
  }, { writes: true });
}
