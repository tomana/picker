import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withPage, showTab, api, assert, eq, sleep, scratchPicker, BASE } from "./lib.mjs";
export const name = "request images — sent with the job, shown on row, sheet and card";
export async function run(log) {
  const cards = (await api("/api/cards?type=fx_visual")).cards;
  const target = cards.find((c) => (c.media || {}).still);
  assert(target, "no card with a picture to revise");
  const [, , cid, fname] = target.media.still.split("/");
  const res = await fetch(BASE + target.media.still);
  assert(res.ok, `no file behind ${target.media.still}: ${res.status}`);
  const img = join(tmpdir(), `t12-${cid}-${fname}`);
  writeFileSync(img, Buffer.from(await res.arrayBuffer()));
  const sp = await scratchPicker();
  const scratchOwns = (path) => path.startsWith("/api/queue") || path.startsWith("/media/queue/")
    || path === "/api/cards" || path === `/api/cards/${target.id}`;
  const before = (await sp.call(`/api/cards/${target.id}`)).json.attachments || [];
  let jid = null;
  try {
    await withPage(async (page, errs) => {
      await sp.route(page, scratchOwns);
      await showTab(page, "fx_visual");
      await page.evaluate((id) => {
        const t = [...document.querySelectorAll("article.card:not(.compose)")]
          .find((a) => a.querySelector(".ctitle")?.textContent);
        const all = [...document.querySelectorAll(".cardwrap")];
        const w = all.find((x) => x.querySelector("img.still")?.src.includes(`/media/${id}/`));
        (w || t).querySelector(".cmedia, .media, article.card").click();
      }, target.id);
      await sleep(1200);
      const input = await page.$(".sheet.big input[type=file]");
      assert(input, "the open card has no image input");
      await input.uploadFile(img);
      await sleep(600);
      eq(await page.evaluate(() => document.querySelectorAll(".sheet.big .sthumb").length),
         1, "the image was not staged");
      await page.type(".sheet.big textarea, .sheet.big input[type=text]", "zz request-images selftest");
      await page.evaluate(() => [...document.querySelectorAll(".sheet.big .acts button")]
        .find((b) => /revise/.test(b.textContent)).click());
      await sleep(500);
      const who = await page.evaluate(() => {
        const pop = document.querySelector(".whopop");
        const b = pop && (pop.querySelector(".whom.on") || pop.querySelector(".whom"));
        if (b) b.click();
        return b ? b.title : null;
      });
      if (who) log(`asked who: ${who}`);
      await sleep(1500);
      const live = (await sp.call("/api/queue?live=1")).json.queue;
      const job = live.find((j) => (j.text || "").includes("zz request-images selftest"));
      assert(job, "pressing revise queued nothing");
      jid = job.id;
      await sleep(600);
      const face = await page.evaluate((j) => [...document.querySelectorAll(".qrow img.qthumb")]
        .map((i) => i.src).find((u) => u.includes(`/media/queue/${j}/`)) || null, jid);
      const rowFields = await page.evaluate((j) => {
        const img = [...document.querySelectorAll(".qrow img.qthumb")]
          .find((i) => i.src.includes(`/media/queue/${j}/`));
        return img ? img.closest(".qrow").querySelectorAll("input, textarea").length : -1;
      }, jid);
      await page.evaluate((j) => {
        const img = [...document.querySelectorAll(".qrow img.qthumb")]
          .find((i) => i.src.includes(`/media/queue/${j}/`));
        if (img) img.closest(".qrow").click();
      }, jid);
      await sleep(900);
      const sheetShows = await page.evaluate((j) => ({
        img: [...document.querySelectorAll(".sheet.job .reqimg img")].some((i) => i.src.includes(j)),
        field: (document.querySelector(".sheet.job .req.draft textarea") || {}).value || "",
      }), jid);
      await page.focus(".sheet.job .req.draft textarea");
      await page.keyboard.type(" — edited");
      await sleep(1300);
      const edited = (await sp.call("/api/queue?live=1")).json.queue.find((x) => x.id === jid);
      await sp.append({ queue: [{ event: "claim", id: jid, researcher: "selftest" }] });
      await sleep(2600);
      const locked = await page.evaluate(() => {
        const f = document.querySelector(".sheet.job .req.draft textarea");
        return { ro: !!(f && f.readOnly),
                 note: (document.querySelector(".sheet.job .reqnote") || {}).textContent || "" };
      });
      assert(face, "the queue row's picture is not the request's image");
      eq(rowFields, 0, "the queue row is still editable in place");
      assert(sheetShows.img, "the expanded job does not draw the request's image");
      assert(sheetShows.field.includes("zz request-images selftest"),
             "the expanded job does not offer the prompt for editing");
      assert(edited && edited.text.endsWith("— edited"),
             `an edit in the expanded job did not save: ${edited && edited.text}`);
      assert(locked.ro, "the editor stayed editable after a researcher took the job");
      assert(/taken/.test(locked.note), `the editor did not say why it locked: "${locked.note}"`);
      log("row: the request's image, not editable; expanded: editable words + images, " +
          "the edit saved, and it locked when a researcher took it");
      eq(job.attachments.length, 1, "the job does not carry the staged image");
      const got = await fetch(sp.url + job.attachments[0]);
      eq(got.status, 200, "the job's image is not served");
      const after = (await sp.call(`/api/cards/${target.id}`)).json.attachments || [];
      eq(after.length, before.length, "the image was pinned on the parent card again");
      log(`revise queued ${jid} with its image; the parent card was left alone`);
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.reload({ waitUntil: "domcontentloaded" });
      await sleep(2000);
    });
    await sp.append({ queue: [{ event: "done", id: jid, result: target.id }] });
    const done = (await sp.call(`/api/cards/${target.id}`)).json.attachments || [];
    assert(done.some((u) => u.includes(`/media/queue/${jid}/`)),
           "the card the job made does not show the request's image");
    log("the card it made shows the request's image, read from the job");
    await withPage(async (page, errs) => {
      await sp.route(page, scratchOwns);
      await showTab(page, "fx_visual");
      await page.evaluate((id) => {
        const w = [...document.querySelectorAll(".cardwrap")]
          .find((x) => x.querySelector("img.still")?.src.includes(`/media/${id}/`));
        w.querySelector(".cmedia, .media, article.card").click();
      }, target.id);
      await sleep(1200);
      const shown = await page.evaluate((j) =>
        [...document.querySelectorAll(".sheet.big .reqimg img")].some((i) => i.src.includes(j)), jid);
      assert(shown, "the open card does not DRAW the request's image");
      log("…and the open card draws it");
      assert(!errs.length, "page errors: " + errs.slice(0, 3).join(" | "));
    });
  } finally {
    sp.done();
  }
}
