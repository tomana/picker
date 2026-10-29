import { withPage, assert, eq, sleep, showTab } from "./lib.mjs";
export const name = "code — a voice's source opens over the card: SuperCollider coloured, numbered, its SynthDef's arguments";
const SHOTS = process.env.SHOTS;

const SCD = `// a measured pulse, not heard
SynthDef(\\coil_buzz, { |out=0, dur=1.446, amp=1.0, freq=29.9|
    var env = EnvGen.kr(Env.linen(0.003, (dur-0.011).max(0.001), 0.008), doneAction:2);
    var sig = RLPF.ar(LFPulse.ar(freq, 0.42, 0.09), 620, 0.55);
    /* two lines
       of comment */
    ~bus = "a string";
    Out.ar(out, (LeakDC.ar(sig) * env * amp * 0.13).dup);
}).add;
`;

export async function run(log) {
  await withPage(async (page, errs) => {
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    await page.setRequestInterception(true);
    page.on("request", (r) => {
      if (r.method() === "GET" && /\.scd(\?|$)/.test(r.url()))
        return r.respond({ status: 200, contentType: "text/plain; charset=utf-8", body: SCD });
      if (r.method() === "GET" || r.method() === "HEAD") return r.continue();
      return r.respond({ status: 200, contentType: "application/json", body: "{}" });
    });
    await showTab(page, "fx_music");
    const opened = await page.evaluate(() => {
      const a = document.querySelector('.grid article.card[data-cid="fx0a1b2c3d4e"]');
      if (!a) return false;
      a.scrollIntoView({ block: "center" });
      (a.querySelector(".media, .vblock") || a).click();
      return true;
    });
    assert(opened, "fx0a1b2c3d4e is on the grid");
    const btn = ".sheet.big button.vc[title^='open its source']";
    await page.waitForSelector(btn, { timeout: 10000 });
    await page.$eval(btn, (b) => b.click());
    await page.waitForSelector(".sheet.code:not([hidden]) .codebody", { timeout: 8000 });
    const got = await page.evaluate(() => {
      const s = document.querySelector(".sheet.code");
      const all = (k) => [...s.querySelectorAll(`.codebody .sc-${k}`)].map((x) => x.textContent);
      return { lines: s.querySelectorAll(".cl").length, nums: [...s.querySelectorAll(".cn")].map((x) => x.textContent).join(),
               cls: all("cls"), symbol: all("symbol"), comment: all("comment"), number: all("number").slice(0, 4),
               key: all("key"), env: all("env"), string: all("string"), method: all("method").slice(0, 4),
               defs: s.querySelector(".codedefs")?.textContent, title: s.querySelector(".shead .t").textContent,
               big: !document.querySelector(".sheet.big").hidden };
    });
    eq(got.lines, 9, "a row per line (the last newline ends the file)");
    eq(got.nums, "1,2,3,4,5,6,7,8,9", "numbered");
    for (const c of ["SynthDef", "EnvGen", "Env", "RLPF", "LFPulse", "Out", "LeakDC"]) assert(got.cls.includes(c), `class ${c}: ${got.cls}`);
    eq(got.symbol.join(), "\\coil_buzz", "the def's name, a symbol");
    eq(got.comment.length, 3, `the line comment, and the block comment cut at its line (${got.comment.join(" | ")})`);
    assert(got.number.includes("1.446") && got.number.includes("29.9"), `numbers: ${got.number}`);
    eq(got.key.join(), "doneAction", "a keyword argument");
    eq(got.env.join(), "~bus", "an environment variable");
    eq(got.string.join(), '"a string"', "a string");
    assert(got.method.includes("kr") && got.method.includes("linen"), `methods: ${got.method}`);
    eq(got.defs, "\\coil_buzz  out=0  dur=1.446  amp=1.0  freq=29.9", "its SynthDef's name and arguments on top");
    assert(got.title.length > 0, `the voice in the head: ${got.title}`);
    assert(got.big, "the card stays open beneath");
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/code-sheet.png` });
    // wrap is on; off, a long line scrolls sideways
    const wrapW = await page.$eval(".sheet.code .sbody.code", (b) => b.scrollWidth <= b.clientWidth + 1);
    assert(wrapW, "wrapped: no sideways scroll");
    await page.evaluate(() => [...document.querySelectorAll(".sheet.code .shead button")].find((b) => /wrap/.test(b.textContent)).click());
    const scrolls = await page.$eval(".sheet.code .sbody.code", (b) => b.scrollWidth > b.clientWidth + 1);
    assert(scrolls, "no wrap: the long lines scroll sideways");
    const shut = () => page.evaluate(() => [document.querySelector(".sheet.code").hidden,
                                            document.querySelector(".sheet.big").hidden].join());
    const reopen = async () => {
      await page.$eval(btn, (b) => b.click());
      await page.waitForSelector(".sheet.code:not([hidden]) .codebody", { timeout: 8000 });
    };
    await page.keyboard.press("Escape");
    await sleep(300);
    eq(await shut(), "true,false", "Escape shuts the code, not the card");
    await reopen();
    await page.$eval(".sheet.code .shead button[title='close']", (b) => b.click());
    await sleep(300);
    eq(await shut(), "true,false", "its ✕ shuts the code, not the card");
    await reopen();
    // a tap beside the sheet lands on the code's scrim, over the card
    const box = await page.$eval(".sheet.code", (s) => { const r = s.getBoundingClientRect(); return { x: r.left, b: r.bottom }; });
    await page.mouse.click(Math.max(4, box.x - 6), Math.min(840, box.b + 20));
    await sleep(300);
    eq(await shut(), "true,false", "a tap beside it shuts the code, not the card");
    assert(!errs.length, "page errors: " + errs.slice(0, 4).join(" | "));
    log(`${got.lines} lines, ${got.cls.length} classes, the def's arguments on top; wrap and scroll; Escape back to the card`);
  });
}
