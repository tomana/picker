import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withPage, assert, eq, sleep, BASE, api, showTab } from "./lib.mjs";

export const name = "fixture — music: original span, upload, trim and make a card";

function wav() {
  const rate = 48000, frames = rate * 4, b = Buffer.alloc(44 + frames * 4);
  b.write("RIFF"); b.writeUInt32LE(b.length - 8, 4); b.write("WAVEfmt ", 8);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(2, 22);
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 4, 28); b.writeUInt16LE(4, 32);
  b.writeUInt16LE(16, 34); b.write("data", 36); b.writeUInt32LE(frames * 4, 40);
  for (let i = 0; i < frames; i++) {
    const x = Math.round(9000 * Math.sin(2 * Math.PI * 220 * i / rate));
    b.writeInt16LE(x, 44 + i * 4); b.writeInt16LE(x, 46 + i * 4);
  }
  return b;
}

export async function run(log) {
  const { cards } = await api("/api/cards?type=music");
  const seeded = cards.find((c) => c.origin?.span && c.lineage?.parent);
  assert(seeded, "a seeded loop based on a recording");
  const tmp = await mkdtemp(join(tmpdir(), "picker-recording-"));
  const file = join(tmp, "fixture take.wav");
  await writeFile(file, wav());
  try {
    await withPage(async (page, errs) => {
      await page.goto(`${BASE}/?tab=music&card=${seeded.id}`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector(".sheet.big:not([hidden]) .origrow .origat", { timeout: 20000 });
      const source = await api(`/api/cards/${seeded.lineage.parent}`);
      const fraction = await page.$eval(".origbar .ltrim.l", (e) => parseFloat(e.style.width));
      assert(Math.abs(fraction - seeded.origin.span.start / source.versions[0].duration * 100) < 0.02,
             "the original lane shades the chosen span");
      assert((await page.$eval(".origbar .sname", (e) => e.textContent)).includes(source.label), "the original is named");
      await page.click(".origgo");
      await page.waitForSelector(".sheet.big:not([hidden]) .trim", { timeout: 10000 });
      log(`${seeded.id}: original recording, shaded span and link back`);

      await showTab(page, "music");
      assert(await page.$(".grid .addrec:not(.addidea)"), "Add recording is visible");
      assert(await page.$(".grid .addidea"), "Add idea is still visible");
      const [chooser] = await Promise.all([page.waitForFileChooser(), page.click(".addrec:not(.addidea) .phead-tog")]);
      const uploaded = page.waitForResponse((r) => r.url().endsWith("/api/music/upload") && r.request().method() === "POST");
      await chooser.accept([file]);
      const response = await uploaded;
      eq(response.status(), 200, "the upload succeeded");
      const { ok, card: cid } = await response.json();
      assert(ok && cid, "the upload names its recording card");
      const rec = await api(`/api/cards/${cid}`);
      eq(rec.origin.kind, "recording", "uploaded card is a recording");
      eq(rec.label, "fixture take", "the filename labels the recording");
      const audio = Buffer.from(await (await fetch(BASE + rec.media.audio)).arrayBuffer());
      eq(audio.readUInt16LE(22), 1, "decoded mono");
      eq(audio.readUInt32LE(24), 22050, "decoded 22050 Hz");
      await page.waitForSelector(".sheet.big:not([hidden]) .trim .twave", { timeout: 20000 });
      eq(await page.$eval(".addidea .phead-lbl", (e) => e.textContent), "Add idea", "upload does not relabel Add idea");
      const box = await page.$eval(".trim .twave", (e) => {
        const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height };
      });
      const drag = async (from, to) => {
        await page.mouse.move(box.x + box.w * from, box.y + box.h / 2);
        await page.mouse.down();
        await page.mouse.move(box.x + box.w * to, box.y + box.h / 2, { steps: 12 });
        await page.mouse.up();
      };
      await drag(0.001, 0.25);
      await drag(0.999, 0.75);
      await page.waitForFunction(() => document.querySelector(".trim .tsaved")?.textContent === "saved");
      const trimmed = await api(`/api/cards/${cid}`);
      assert(Math.abs(trimmed.trim.start - 1) < 0.05 && Math.abs(trimmed.trim.end - 3) < 0.05,
             `the trim saved: ${JSON.stringify(trimmed.trim)}`);

      await page.evaluate(() => [...document.querySelectorAll(".sheet.big:not([hidden]) button")]
        .find((b) => b.textContent.trim() === "make a card").click());
      await page.waitForSelector(".whopop .whotab");
      await page.evaluate(() => [...document.querySelectorAll(".whopop .whotab")]
        .find((b) => b.textContent === "fake").click());
      const sent = page.waitForResponse((r) => r.url().endsWith("/api/queue") && r.request().method() === "POST");
      await page.click(".whopop .whom");
      const job = await (await sent).json();
      eq(job.backend, "fake", "only the local fake agent is used");
      eq(JSON.stringify(job.trim), JSON.stringify(trimmed.trim), "the job freezes the trim");
      let finished;
      for (let i = 0; i < 90; i++) {
        finished = await api(`/api/queue/${job.id}`);
        if (["done", "failed"].includes(finished.status)) break;
        await sleep(1000);
      }
      eq(finished.status, "done", `make a card: ${finished.why || finished.status}`);
      const made = await api(`/api/cards/${finished.result}`);
      eq(made.lineage.parent, cid, "the stack is based on the uploaded recording");
      const span = made.origin.span;
      assert(Math.abs(span.start - trimmed.trim.start) < 0.001
             && Math.abs(span.dur - (trimmed.trim.end - trimmed.trim.start)) < 0.001, "the stack keeps the chosen seconds");
      assert(made.versions[0].parts.some((p) => p.id === "rec"), "the stack has a recording lane");
      await page.goto(`${BASE}/?tab=music&card=${made.id}`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector(".sheet.big:not([hidden]) .origrow .origat", { timeout: 20000 });
      eq(errs.length, 0, `page errors: ${errs.join(" | ")}`);
      log(`${cid}: uploaded stereo 48 kHz -> mono 22050; trimmed -> ${made.id}, span ${JSON.stringify(span)}, rec lane`);
    }, { writes: true });
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}
