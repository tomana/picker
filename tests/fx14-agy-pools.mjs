import { withPage, assert, eq } from "./lib.mjs";

export const name = "usage — Antigravity has two pool columns, five-hour above week, resets in the tooltip";

export async function run(log) {
  await withPage(async (page, errs) => {
    await page.waitForSelector(".notch > .ubox:nth-child(3)");
    await page.evaluate(() => {
      const original = window.fetch.bind(window);
      window.fetch = (u, o) => {
        if (new URL(String(u), location.origin).pathname === "/api/usage/all")
          return Promise.resolve(new Response(JSON.stringify(window.poolPayload),
            {headers:{"Content-Type":"application/json"}}));
        return original(u, o);
      };
    });
    const cases = [
      {g:0, gw:0, c:45, cw:23},
      {g:0, gw:0, c:62, cw:31},
      {g:80, gw:7, c:62, cw:100},
      {g:62, gw:11, c:62, cw:31},
      {g:0, gw:99, c:0, cw:100},
      {g:100, gw:100, c:100, cw:100},
      {g:null, gw:null, c:62, cw:31},
    ];
    // AUTO's agent tabs: agy's percentage is the lit model's pool, not the busiest pool (the reader's live shape)
    const pcts = await page.evaluate(async () => {
      const {sessionPct} = await import("/static/app/data.js");
      const src = {groups:{
        claude_and_gpt_models:{family:"claude_gpt", model_patterns:["claude-*", "gpt-*"]},
        gemini_models:{family:"gemini", model_patterns:["gemini-*"]},
        gemini_4_argon:{family:null, model_patterns:[]}},
        windows:[{key:"gemini_models:5h", group:"gemini_models", used_pct:0.7},
          {key:"claude_and_gpt_models:5h", group:"claude_and_gpt_models", used_pct:61.9},
          {key:"claude_and_gpt_models:weekly", group:"claude_and_gpt_models", used_pct:31},
          {key:"gemini_4_argon:weekly", group:"gemini_4_argon", used_pct:100}]};
      return ["gemini-3.8-flash-high", "gemini-4-argon-high", "claude-opus-5-5-high", "gpt-oss-120b-medium", null]
        .map((m) => sessionPct(src, m));
    });
    eq(pcts.join(), "1,1,62,62,62", "flash and argon read gemini's pool, claude and gpt c+g's; no model, the busiest");
    log(`AUTO's agy tab by model: ${pcts.join(" / ")}`);
    for (const t of cases) {
      const reset = (hours, minutes = 0) => new Date(Date.now() + ((hours * 60 + minutes) * 60 + 30) * 1000).toISOString();
      const payload = {sources:{
        anthropic:{available:true, windows:[{key:"session",used_pct:12,resets_at:reset(1,5)},
          {key:"weekly",used_pct:22,resets_at:reset(24)}]},
        codex:{available:true, windows:[{key:"session",used_pct:34,resets_at:reset(2,7)},
          {key:"weekly",used_pct:44,resets_at:reset(48)}]},
        // the reader's shape: a group per pool agy lists; a pool with no family (one model's own quota) isn't drawn
        agy:{available:true, groups:{
          claude_and_gpt_models:{name:"Claude and GPT models", family:"claude_gpt",
            windows:{"5h":"claude_and_gpt_models:5h", weekly:"claude_and_gpt_models:weekly"}},
          gemini_models:{name:"Gemini Models", family:"gemini",
            windows:{"5h":"gemini_models:5h", weekly:"gemini_models:weekly"}},
          gemini_4_argon:{name:"Gemini 4 Argon", family:null, windows:{weekly:"gemini_4_argon:weekly"}}},
          windows:[{key:"claude_and_gpt_models:weekly",used_pct:t.cw,resets_at:reset(96)},
          {key:"gemini_models:weekly",used_pct:t.gw,resets_at:reset(72)},
          {key:"claude_and_gpt_models:5h",used_pct:t.c,resets_at:reset(4,20)},
          {key:"gemini_models:5h",used_pct:t.g,resets_at:reset(2,10)},
          {key:"gemini_4_argon:weekly",used_pct:100,resets_at:reset(90)}]}}};
      const mapped = await page.evaluate(async (payload) => {
        window.poolPayload = payload;
        const {mapUsage} = await import("/static/app/data.js");
        return mapUsage(payload).usage.filter((u) => u.pool === "agy");
      }, payload);
      eq(mapped.length, 4, "four windows in two pool columns");
      eq(mapped.map((u) => u.column).join(), "gemini,gemini,claude_gpt,claude_gpt", "fixed column order, the single-model pool left out");
      eq(mapped.map((u) => u.label).join(), "g,w,c+g,w", "five-hour above week in each column");
      eq(mapped.map((u) => u.unknown ? "missing" : u.pct).join(),
        [t.g,t.gw,t.c,t.cw].map((n) => n == null ? "missing" : n).join(), "all four readings");
      eq(mapped[0].color, mapped[2].color, "both pools in agy's green");
      assert(mapped[0].color !== mapped[1].color && mapped[2].color !== mapped[3].color,
        "weeks use each pool's deep colour");
      await page.click(".notch > .ubox:nth-child(3)");
      await page.waitForFunction((expected) => {
        const box = document.querySelector(".notch > .ubox:nth-child(3)");
        return [...box.querySelectorAll(".ucol > .kbar > .kline > span:first-child")]
          .map((e) => e.textContent).join() === expected;
      }, {}, [["g",t.g],["w",t.gw],["c+g",t.c],["w",t.cw]]
        .map(([label,n]) => `${label} ${n == null ? "\u2014" : `${n}%`}`).join());
      const drawn = await page.$eval(".notch > .ubox:nth-child(3)", (e) => {
        const rect = (n) => { const r = n.getBoundingClientRect(); return {x:r.x,y:r.y,w:r.width,h:r.height}; };
        return {
          columns:[...e.querySelectorAll(".ucol")].map((c) => ({...rect(c), rows:[...c.children].map(rect)})),
          resets:[...e.querySelectorAll(".ucol > .kbar > .kline > span:last-child")].map((n) => n.textContent),
          colors:[...e.querySelectorAll(".kfill")].map((n) => getComputedStyle(n).backgroundColor),
          labelsFit:[...e.querySelectorAll(".ucol > .kbar > .kline > span:first-child")].every((n) => {
            const range = document.createRange(); range.selectNodeContents(n);
            return range.getBoundingClientRect().right <= n.closest(".kbar").getBoundingClientRect().right + .5;
          }),
        };
      });
      eq(drawn.columns.length, 2, "two columns rendered");
      const [g,c] = drawn.columns;
      eq(g.y, c.y, "columns sit side by side");
      assert(Math.abs(c.x - (g.x + g.w) - 3) < .1, "3px column gap");
      for (const col of drawn.columns) {
        eq(col.rows.length, 2, "two rows per column");
        assert(col.rows.every((r) => r.h === 12), "12px rows");
        eq(col.rows[1].y - col.rows[0].y - col.rows[0].h, 4, "4px row gap");
      }
      assert(drawn.resets.every((text) => text === ""), "no reset times in the compact rows");
      assert(drawn.colors[0] === drawn.colors[2] && drawn.colors[0] !== drawn.colors[1]
        && drawn.colors[2] !== drawn.colors[3], "agy's green in both pools, its deep green for the weeks");
      assert(drawn.labelsFit, "all labels fit, including c+g 100%");
      const title = await page.$eval(".notch > .ubox:nth-child(3)", (e) => e.title);
      for (const [label,n,time] of [["Gemini 5h",t.g,"2h10m"],["Gemini week",t.gw,"3d0h"],
        ["Claude/GPT 5h",t.c,"4h20m"],["Claude/GPT week",t.cw,"4d0h"]])
        assert(title.includes(`${label}: ${n == null ? "\u2014" : `${n}%`} / ${time}`),
          `tooltip names every window and reset: ${title}`);
      const others = await page.$$eval(".notch > .ubox:not(.columns)", (boxes) => boxes.map((box) => ({
        labels:[...box.querySelectorAll(":scope > .kbar > .kline > span:first-child")].map((n) => n.textContent).join(),
        resets:[...box.querySelectorAll(":scope > .kbar > .kline > span:last-child")].map((n) => n.textContent).join(),
      })));
      eq(others.length, 2, "other boxes stay single-column");
      eq(others[0].labels, "s:12%,w:22%", "Claude rows unchanged");
      eq(others[0].resets, "1h5m,1d0h", "Claude reset times unchanged");
      eq(others[1].labels, "s:34%,w:44%", "Codex rows unchanged");
      eq(others[1].resets, "2h7m,2d0h", "Codex reset times unchanged");
    }
    const unknown = await page.evaluate(async () => {
      const {mapUsage} = await import("/static/app/data.js");
      return mapUsage({sources:{agy:{available:false, windows:[]}}}).usage.filter((u) => u.pool === "agy");
    });
    assert(unknown.length === 4 && unknown.every((u) => u.unknown), "missing readings stay unknown");
    const partial = await page.evaluate(async () => {
      const {mapUsage} = await import("/static/app/data.js");
      return mapUsage({sources:{agy:{available:true, groups:{
          claude_and_gpt_models:{name:"Claude and GPT models", family:"claude_gpt", windows:{"5h":"claude_and_gpt_models:5h"}}},
        windows:[{key:"claude_and_gpt_models:5h",used_pct:62}]}}})
        .usage.filter((u) => u.pool === "agy");
    });
    assert(partial[0].unknown && partial[1].unknown && !partial[2].unknown && partial[2].pct === 62 && partial[3].unknown,
      "a missing pool does not hide the other pool or become zero usage");
    const wide = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    assert(!wide, "pool labels do not widen the phone page");
    eq(errs.length, 0, `page errors: ${errs.join(" | ")}`);
    log("two columns: g / w and c+g / w, agy's green; 12px rows, 4px row gaps, 3px column gap, deep weekly colours");
    log("all four resets only in tooltip; missing readings dashed; c+g 100% fits; other boxes and phone width unchanged");
  });
}
