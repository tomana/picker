/* Render server state without guessing CLI readiness; keep invocation receipts distinct from current configuration. */

import { el, glyph, infoBubble } from "../dom.js";

/* Avoid nested buttons: file rows already own the outer button target. */

const info = (text) => Object.assign(el("span.sinfo", { role: "button", tabindex: "0", title: text, "aria-label": "about this" },
                                        [glyph("info", 13)]),
                                     { onclick: (e) => { e.stopPropagation(); infoBubble(e.currentTarget, text); } });

const J = (r) => r.json().catch(() => ({})).then((b) => (r.ok ? b : Promise.reject(
  new Error(b.err || b.description || `HTTP ${r.status}`))));
const api = {
  agents: () => fetch("/api/agents").then(J),
  save: (name, model, effort, session_cap) => fetch(`/api/agents/${encodeURIComponent(name)}`, {
    method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, effort, session_cap }) }).then(J),
  check: (body = {}) => fetch("/api/agents/check", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body) }).then(J),
  checkOf: (g) => fetch(g ? `/api/agents/check/${encodeURIComponent(g)}`
                          : "/api/agents/check").then(J),
  insight: (type, agent, more = {}) => fetch(`/api/agents/insight/${encodeURIComponent(type)}?` +
    new URLSearchParams({ agent, ...Object.fromEntries(Object.entries(more).filter(([, v]) => v != null && v !== "")) })
  ).then(J),
  receipts: (job) => fetch(`/api/queue/${encodeURIComponent(job)}/receipts`).then(J),
  text: (sha) => fetch(`/api/receipts/text/${encodeURIComponent(sha)}`).then(J),
  file: (path) => fetch(`/api/agents/file?path=${encodeURIComponent(path)}`).then(J),
};

/* Filter null children before replaceChildren, which would stringify them. */

const put = (node, ...kids) => node.replaceChildren(...kids.filter(Boolean));
const kb = (n) => (n == null ? "" : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
const sec = (s) => (s == null ? "" : s >= 60 ? `${Math.floor(s / 60)}m${Math.round(s % 60)}s`
                                              : `${Math.round(s)}s`);

/* Skeletons reserve layout without matching selectors for real rows. */

const bar = (w) => el("span.sk", { style: `width:${w}px`, text: "\u00a0" });
const skName = (a, b) => el("div.sk-name", {}, [el("span.sdot.sk"), bar(a), bar(b)]);
/* Size skeletons from manifest agents; agent-free methods have no agent rows. */
const agentsOf = (types) => [...new Set(types.flatMap((t) => t.agents || []))].filter((a) => a !== "sweep");

function section(label, ...kids) {
  return el("div.sset", {}, [el("div.ssh", { text: label }), ...kids]);
}

function sectionI(label, about, ...kids) {
  return el("div.sset", {}, [el("div.ssh", {}, [el("span", { text: label }), info(about)]), ...kids]);
}

function select(options, value, onchange) {
  const s = el("select.ssel");
  for (const o of options) {
    const opt = el("option", { value: o.value ?? "", text: o.label });
    if ((o.value ?? "") === (value ?? "")) opt.selected = true;
    s.append(opt);
  }
  s.onchange = () => onchange(s.value || null);
  return s;
}

function agentRow(a) {
  const note = el("span.snote");
  const box = el("div.sagent");
  let model = a.choice.model, effort = a.choice.effort, sessionCap = a.choice.session_cap ?? 100;
  const models = a.catalogue.models || [];
  const effortsOf = (m) => ((models.find((x) => x.id === m) || {}).efforts
                            || a.catalogue.efforts || []);
  const paint = () => {
    const cd = a.catalogue.cli_default || {};
    const opts = [{ value: null, label: cd.model ? `CLI default (${cd.model})` : "CLI default" },
                  ...models.map((m) => ({ value: m.id, label: m.label !== m.id
                    ? `${m.id} · ${m.label}` : m.id }))];
    if (model && !models.some((m) => m.id === model))
      opts.push({ value: model, label: `${model} (not listed)` });
    const efforts = effortsOf(model);
    const mSel = select(opts, model, (v) => {
      model = v;
      if (effort && !effortsOf(model).includes(effort)) effort = null;
      save();
    });
    const eSel = efforts.length
      ? select([{ value: null, label: cd.effort ? `effort: default (${cd.effort})`
                                                : "effort: default" },
                ...efforts.map((e) => ({ value: e, label: e }))], effort,
               (v) => { effort = v; save(); })
      : el("span.snote", { text: "no effort setting" });
    const capSel = select([100, 90, 80, 70, 60, 50].map((n) => ({value: String(n), label: n === 100 ? "off (100%)" : `${n}%`})),
                          String(sessionCap), (v) => { sessionCap = Number(v); save(); });
    capSel.classList.add("session-cap");
    capSel.setAttribute("aria-label", "session cap");
    capSel.title = "session cap: stops new jobs, never a running job; off reads no usage for admission";
    const isDefault = model === a.default.model && effort === a.default.effort && sessionCap === 100;
    put(box,
      el("div.sagname", {}, [
        el("span.sdot" + (a.installed ? ".ok" : ".bad"),
           { title: a.installed ? `${a.cli} is installed` : `${a.cli} not found on PATH` }),
        el("b", { text: a.label }),
        el("span.snote", { text: a.cli !== a.name ? a.cli : "" }),
        el("span.snote.sdef", { text: isDefault ? "default" : "set" }),
      ]),
      el("div.sctl", {}, [mSel, eSel, el("label.scap", {}, ["session cap ", capSel])]),
      a.execution && !a.execution.allowed ? el("div.snote.err", {text: a.execution.reason}) : null,
      a.catalogue.error ? el("div.snote.err", { text: a.catalogue.error }) : null,
      note);
  };
  const save = async () => {
    note.textContent = "saving…";
    try {
      const r = await api.save(a.name, model, effort, sessionCap);
      Object.assign(a, r.agent, { catalogue: a.catalogue });
      model = a.choice.model; effort = a.choice.effort; sessionCap = a.choice.session_cap ?? 100;
      paint();
      note.textContent = "saved — the next job uses it";
    } catch (e) {
      model = a.choice.model; effort = a.choice.effort; sessionCap = a.choice.session_cap ?? 100;
      paint();
      note.textContent = `not saved: ${e.message}`;
      note.classList.add("err");
    }
  };
  paint();
  return box;
}

const skAgent = () => el("div.sk-agent", { "aria-hidden": "true" },
                         [skName(70, 40), el("div.sctl", {}, [el("span.sk-sel"), el("span.sk-sel")]), el("span")]);

function wiring(types) {
  const grid = el("div.swire");
  const detail = el("div.swdetail");
  const runners = el("div.snote");
  const btn = el("button.sbtn", { type: "button", text: "check all" });
  let poll = 0, picked = null;
  /* Report causes from server issues; a type-wide warning must not mark every agent as broken. */

  const cellOf = (r) => {
    const s = r.state || (r.status === "done" ? "ok" : r.status);
    const mark = { ok: "check", warn: "check", limited: "limited", failed: "cut", running: "loop" }[s];
    const text = s === "ok" ? sec(r.seconds)
      : r.issue ? r.issue.short
      : s === "failed" ? "failed" : (r.phase || s);
    const c = el("button.swcell." + s, { type: "button",
      title: `${(types.find((t) => t.type === r.type) || { label: r.type }).label} · ${r.agent}: ${(r.issue && r.issue.detail) || r.why || r.phase || s}` }, [
      el("span.swm", { text: mark ? null : "…" }, mark ? [glyph(mark, 15)] : []),
      el("span.swt", { text }),
    ]);
    c.onclick = () => { picked = r.id; showDetail(r); };
    return c;
  };
  /* Deduplicate shared problems while retaining affected locations and suggested fixes. */

  const issuesBox = el("div.swissues");
  const paintIssues = (list) => put(issuesBox, ...(list || []).map((i) =>
    el("div.swiss." + i.level, {}, [
      el("div.swih", {}, [el("span.swidot"), el("b", { text: i.title || i.short }),
                          el("span.snote", { text: ` · ${i.where.join(", ")}` })]),
      i.detail ? el("div.swid", { text: i.detail }) : null,
      i.fix ? el("div.swifix", { text: `→ ${i.fix}` }) : null,
    ].filter(Boolean))));
  const showDetail = (r) => put(detail,
    el("div.swhead", { text: `${(types.find((t) => t.type === r.type) || { label: r.type }).label} · ${r.agent} · ${r.state || r.status}` }),
    r.issue && r.issue.fix ? el("div.swifix", { text: `→ ${r.issue.fix}` }) : null,
    ...(r.stages || []).map((t, i, a) =>
      el("div.swstage" + (i === a.length - 1 ? ".now" : "")
         + (/^warn/.test(t || "") ? ".warn" : ""), { text: t })),
    r.why ? el("div.swwhy" + (r.state === "limited" ? ".warn" : ""), { text: r.why }) : null);
  const paint = (res) => {
    const rows = res.rows || [];
    paintIssues(res.issues);
    if (!rows.length) {
      put(grid, el("div.snote", { text: "never checked" }));
      return;
    }
    const agents = [...new Set(rows.map((r) => r.agent))];
    const byType = types.filter((t) => rows.some((r) => r.type === t.type));
    /* A type-wide condition marks the type, once. */
    const typeWarn = (t) => {
      const seen = new Set();
      rows.filter((r) => r.type === t.type)
        .forEach((r) => (r.type_issues || []).forEach((i) => seen.add(i.short)));
      return [...seen];
    };
    grid.style.gridTemplateColumns = `auto repeat(${agents.length}, minmax(0,1fr))`;
    put(grid,
      el("span"), ...agents.map((a) => el("span.swa", { text: a })),
      ...byType.flatMap((t) => [
        (() => {
          const w = typeWarn(t);
          return el("span.swtype" + (w.length ? ".warned" : ""),
                    { text: t.label, title: w.join(" · ") || "" },
                    w.length ? [el("span.swtw", { text: w.join(" · ") })] : []);
        })(),
        ...agents.map((a) => {
          const r = rows.find((x) => x.type === t.type && x.agent === a);
          return r ? cellOf(r) : el("span.swna", { text: "—" });
        }),
      ]));
    const hit = rows.find((r) => r.id === picked);
    if (hit) showDetail(hit);
    const when = (res.group || "").replace(/^wiring-(\d{4})(\d\d)(\d\d)-(\d\d)(\d\d).*/,
                                             "$3.$2 $4:$5");
    btn.textContent = res.done === false ? "checking…" : "check all";
    btn.disabled = res.done === false;
    if (res.group && !runners.dataset.fresh) runners.textContent = `last check ${when}`;
  };
  const follow = (group) => {
    clearTimeout(poll);
    let first = true;
    const tick = async () => {
      /* Stop polling after close, but allow the initial request before the section is attached. */

      if (!first && !grid.isConnected) return;
      first = false;
      try {
        const res = await api.checkOf(group);
        paint(res);
        if (!res.done) poll = setTimeout(tick, 1500);
      } catch (e) { runners.textContent = e.message; }
    };
    tick();
  };
  btn.onclick = async () => {
    btn.disabled = true;
    try {
      const res = await api.check();
      runners.dataset.fresh = "1";
      runners.textContent = Object.entries(res.runners || {})
        .map(([t, s]) => `${(types.find((x) => x.type === t) || { label: t }).label}: ${s}`).join(" · ");
      paint({ ...res, done: false });
      follow(res.group);
    } catch (e) { runners.textContent = e.message; btn.disabled = false; }
  };

  const rows = types.filter((t) => t.start), cols = [...agentsOf(rows), "render"];
  grid.style.gridTemplateColumns = `auto repeat(${cols.length}, minmax(0,1fr))`;
  put(grid, el("span"), ...cols.map(() => el("span.swa", {}, [bar(34)])),
      ...rows.flatMap(() => [el("span.swtype", {}, [bar(64)]), ...cols.map(() => el("span.sk-cell"))]));
  follow(null);
  return sectionI("wiring",
    "Each type, through its real runner: brief builds · binaries, tools and datasets present · store sync · every " +
    "agent answers READY with the model above and writes a file where its work goes · render: a real render, no " +
    "agent. Not checked: how good the work is. Never touches queued work. ✓ works · ✓ ◔ works, but not now (out " +
    "of usage, or something running is in the way) · ✕ broken — tap a cell.",
    el("div.srow", {}, [btn, runners]), issuesBox, grid, detail);
}

/* Current configuration is not a receipt; recorded invocations retain their original hashed inputs. */

const pre = (text) => el("pre.sview", { text });
const toggle = (label, note, body) => {
  const b = el("button.sfile", { type: "button" }, [el("span.sfp", { text: label }), el("span.snote", { text: note })]);
  body.hidden = true;
  b.onclick = () => { body.hidden = !body.hidden; };
  return [b, body];
};
function manifestRow(m) {
  if (!m || !Object.keys(m).length) return null;
  return el("div", {}, [el("div.ssub", {}, [el("span", { text: "the tab's manifest" }),
                                            info("what this type is and can do, read-only: its picker-type.json")]),
                         ...toggle(`${m.type}`, "read-only", pre(JSON.stringify(m, null, 1)))]);
}
const hhmm = (ts) => (ts ? new Date(ts * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "");

export async function configured({ type, agent, kind, card, version, model }) {
  const box = el("div.sins", {}, [el("div.snote", { text: "reading…" })]);
  let d;
  try { d = await api.insight(type, agent, { kind, card, version, model }); }
  catch (e) { put(box, el("div.snote.err", { text: e.message })); return box; }
  if (d.error) { put(box, el("div.snote.err", { text: `the brief does not build: ${d.error}` })); return box; }
  const viewer = pre("");
  viewer.hidden = true;
  const view = async (path) => {
    viewer.hidden = false;
    viewer.textContent = `${path}\n\n…`;
    try { const f = await api.file(path); viewer.textContent = `${path}\n\n${f.text}`; }
    catch (e) { viewer.textContent = `${path}\n\n${e.message}`; }
  };
  const fileRow = (f) => {
    const b = el("button.sfile", { type: "button", title: f.why }, [
      el("span.sfp", { text: f.path }), el("span.snote", { text: f.missing ? "missing" : f.why })]);
    b.onclick = () => view(f.path);
    return b;
  };
  const ins = d.instructions || {};
  put(box,
    el("div.snote", { text: "as configured: what this send would run now. What a job ran is in its sheet, under " +
                            "receipts — the files may have changed since." }),
    el("div.skv", {}, [
      el("span", { text: "runs in" }), el("code", { text: d.cwd }),
      el("span", { text: "model" }),
      el("span", { text: `${model || d.choice.model || "CLI default"} · effort ${d.choice.effort || "default"}` }),
      el("span", { text: "command" }), el("code", { text: (d.command || []).join(" ") }),
    ]),
    ...toggle(`the brief · ${d.kind}${d.card ? " of " + d.card : ""}`, `${kb(d.brief.chars)} chars`, pre(d.brief.text)),
    el("div.ssub", { text: "named in the brief" }),
    ...(d.referenced.length ? d.referenced.map(fileRow) : [el("div.snote", { text: "none" })]),
    el("div.ssub", { text: `loaded by ${d.cli} on its own` }),
    ins.note ? el("div.snote", { text: ins.note }) : null,
    ...((ins.files || []).length ? ins.files.map(fileRow) : [el("div.snote", { text: "none found" })]),
    manifestRow(d.manifest),
    viewer);
  return box;
}

export async function receipts(job) {
  const box = el("div.sins", {}, [el("div.snote", { text: "reading…" })]);
  let d;
  try { d = await api.receipts(job); }
  catch (e) { put(box, el("div.snote.err", { text: e.message })); return box; }
  if (!(d.receipts || []).length) {
    put(box, el("div.snote", { text: "no receipts: none was run yet, or it ran before they were kept (10-25)" }));
    return box;
  }
  const viewer = pre("");
  viewer.hidden = true;
  const view = async (label, sha) => {
    viewer.hidden = false;
    viewer.textContent = `${label}\n\n…`;
    try { const t = await api.text(sha); viewer.textContent = `${label} · as it was then\n\n${t.text}`; }
    catch (e) { viewer.textContent = `${label}\n\n${e.message}`; }
  };
  const textRow = (label, why, sha, missing) => {
    const b = el("button.sfile", { type: "button", title: why || "" }, [
      el("span.sfp", { text: label }), el("span.snote", { text: missing ? "missing then" : why || "" })]);
    if (sha) b.onclick = () => view(label, sha);
    return b;
  };
  const one = (r) => el("div.srec", {}, [
    el("div.ssub", { text: [r.tool || `${r.agent} · ${r.model || "CLI default"} · effort ${r.effort || "default"}`,
                            r.attempt ? `attempt ${r.attempt}` : "", hhmm(r.started),
                            r.ok === true ? "ok" : r.ok === false ? "failed" : "running"].filter(Boolean).join(" · ") }),
    r.why ? el("div.snote.err", { text: r.why }) : null,
    el("div.skv", {}, [
      ...(r.cwd ? [el("span", { text: "ran in" }), el("code", { text: r.cwd })] : []),
      ...(r.argv ? [el("span", { text: "command" }), el("code", { text: r.argv.join(" ") })] : []),
      ...(r.inputs && Object.keys(r.inputs).length
        ? [el("span", { text: "inputs" }), el("code", { text: JSON.stringify(r.inputs) })] : []),
    ]),
    r.prompt ? textRow("the brief", `${kb(r.prompt.chars)} chars`, r.prompt.sha256) : null,
    ...(r.files || []).map((f) => textRow(f.path, f.why, f.sha256, f.missing)),
    r.manifest ? textRow("the type's manifest", "", r.manifest.sha256, r.manifest.missing) : null,
    ...(r.input_files || []).map((f) => el("div.snote", { text: `${f.path} · ${f.missing ? "missing" : "sha256 " + f.sha256.slice(0, 12)}` })),
  ]);
  put(box, el("div.snote", { text: "as it ran: what each invocation was given, kept as it was then" }),
      ...d.receipts.map(one), viewer);
  return box;
}

const skFile = (w) => el("div.sk-file", {}, [el("div.sfp", {}, [bar(w)]), el("div.snote", {}, [bar(90)])]);
const skInsight = () => [
  el("div.skv", {}, [bar(44), bar(210), bar(38), bar(150)]),
  skFile(70), el("div.ssub", {}, [bar(100)]), skFile(150), skFile(120), el("div.ssub", {}, [bar(110)]), skFile(160)];

function insight(types) {
  const body = el("div.sins");
  const typeRow = el("div.schips");
  const agentRow = el("div.schips");
  const viewer = el("pre.sview", { hidden: "" });
  let type = types[0], agent = null;
  const chip = (label, on, click) => {
    const b = el("button.chip" + (on ? ".on" : ""), { type: "button", text: label });
    b.onclick = click;
    return b;
  };
  const view = async (path) => {
    viewer.hidden = false;
    viewer.textContent = `${path}\n\n…`;
    try {
      const f = await api.file(path);
      viewer.textContent = `${path} · ${kb(f.bytes)}B${f.cut ? " (cut)" : ""}\n\n${f.text}`;
    } catch (e) { viewer.textContent = `${path}\n\n${e.message}`; }
    viewer.scrollTop = 0;
    viewer.scrollIntoView({ block: "nearest" });
  };
  const fileRow = (f) => {
    const b = el("button.sfile", { type: "button", title: f.why }, [
      el("span.sfp", { text: f.path }),
      el("span.snote", { text: f.missing ? "missing" : `${f.lines} lines · ~${kb(f.tokens)} tok` }),
    ]);
    b.onclick = () => view(f.path);
    return b;
  };
  const load = async () => {
    const agents = (type.agents || []).filter((a) => a !== "sweep");
    if (!agents.includes(agent)) agent = agents[0];
    typeRow.replaceChildren(...types.map((t) =>
      chip(t.label, t === type, () => { type = t; load(); })));
    agentRow.replaceChildren(...agents.map((a) =>
      chip(a, a === agent, () => { agent = a; load(); })));
    viewer.hidden = true;
    /* Keep the previous answer height while loading to avoid layout jumps. */
    body.style.minHeight = `${body.offsetHeight}px`;
    put(body, ...skInsight());
    const show = (...kids) => { body.style.minHeight = ""; put(body, ...kids); };
    let d;
    try { d = await api.insight(type.type, agent); }
    catch (e) { show(el("div.snote.err", { text: e.message })); return; }
    if (d.error) {
      show(el("div.snote.err", { text: `the brief does not build: ${d.error}` }));
      return;
    }
    const briefPre = el("pre.sview", { hidden: "", text: d.brief.text });
    const briefBtn = el("button.sfile", { type: "button" }, [
      el("span.sfp", {}, ["the brief", info("what this agent is handed for a job")]),
      el("span.snote", { text: `${kb(d.brief.chars)} chars · ~${kb(d.brief.tokens)} tok` }),
    ]);
    briefBtn.onclick = () => { briefPre.hidden = !briefPre.hidden; };
    const ins = d.instructions || {};
    show(
      el("div.skv", {}, [
        el("span", { text: "runs in" }), el("code", { text: d.cwd }),
        el("span", { text: "model" }),
        el("span", { text: `${d.choice.model || "CLI default"} · effort ${d.choice.effort || "default"}` }),
      ]),
      briefBtn, briefPre,
      el("div.ssub", {}, [el("span", { text: "named in the brief" }), info("the brief tells the agent to read these")]),
      ...(d.referenced.length ? d.referenced.map(fileRow)
                              : [el("div.snote", { text: "none" })]),
      el("div.ssub", { text: `loaded by ${d.cli} on its own` }),
      ins.note ? el("div.snote", { text: ins.note }) : null,
      ...((ins.files || []).length ? ins.files.map(fileRow)
                                   : [el("div.snote", { text: "none found" })]),
      el("div.ssub", { text: `skills ${d.cli} can use here · ${d.skills.length}` }),
      ...d.skills.map((s) => {
        const b = el("button.sfile", { type: "button", title: s.path }, [
          el("span.sfp", { text: `${s.name}` }),
          el("span.snote", {}, [s.scope, ...(s.description ? [info(s.description)] : [])]),
        ]);
        if (s.path.endsWith("SKILL.md")) b.onclick = () => view(s.path);
        return b;
      }),
      manifestRow(d.manifest),
      el("div.ssub", { text: `last jobs on ${type.label}` }),
      ...(d.recent.length ? d.recent.map((j) => el("div.sjob." + j.status, {}, [
        el("span", { text: `${j.kind}${j.card ? " · " + j.card : ""}` }),
        el("span.snote", { text: [j.status, (j.researcher || "").split(":")[1],
                                  sec(j.seconds)]
                                  .filter(Boolean).join(" · ") }),
        j.why ? el("div.swwhy", { text: j.why }) : null,
      ])) : [el("div.snote", { text: "none yet" })]),
      viewer);
  };
  load();
  return section("insight", typeRow, agentRow, body);
}

/* Read APK freshness from the server; do not infer it from client state. */

function apkRow() {
  const body = el("div.sset", {}, [skName(80, 150), el("div.srow", {}, [el("span.sk-btn")])]);
  const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;
  const day = (t) => new Date(t * 1000).toLocaleDateString(undefined,
    { day: "numeric", month: "short" });
  fetch("/api/downloads/app").then(J).then(({ app: a, apk }) => {
    if (!a || !a.name || !a.publish) throw new Error("app metadata is missing");
    if (!apk) {
      put(body, el("div.snote", { text: `no ${a.name} APK published — run ${a.publish}` }));
      return;
    }
    const stale = apk.behind > 0 || apk.uncommitted || apk.dirty_build;
    const why = apk.dirty_build ? "built from uncommitted code"
      : apk.behind > 0 ? `${apk.behind} app commit${apk.behind > 1 ? "s" : ""} newer than this build`
      : apk.uncommitted ? "the app has uncommitted changes"
      : "up to date with the code";
    put(body,
      el("div.sagname", {}, [el(`span.sdot.${stale ? "warn" : "ok"}`),
        el("span", { text: `${a.name} ${apk.version}` }),
        el("span.snote", { text: `${apk.sha} · ${mb(apk.size)} · ${day(apk.mtime)}` }), info(a.description || "")]),

      stale ? el("div.snote", { text: `${why} — run ${a.publish}` }) : null,
      el("div.srow", {}, [
        el("a.sbtn.sdl", { href: apk.url, download: apk.name }, [glyph("download", 14), "download APK"])]));
  }).catch((e) => put(body, el("div.snote.err", { text: e.message })));
  return el("div", {}, [body]);
}

/* Show app downloads only when a plugin serves them. */
function companion() {
  return sectionI("the phone app", "Android asks once to allow installs from your browser.", apkRow(),
    el("div.srow", {}, [el("a.snote", { href: "/download", text: "all downloads ↗" })]));
}

function walkthrough({ steps, start, card }) {
  const all = steps();
  if (!all.length) return null;
  const link = (s, go) => el("li", {}, [Object.assign(el("button.swk", { type: "button", text: s.line, "data-key": s.key }),
                                                      { onclick: go })]);
  const list = el("ul.swalk", { hidden: "" }, [...all.map((s, i) => link(s, () => start(i))),
                                               card && link({ key: "an open card", line: "An open card, part by part." },
                                                            () => card())]);
  const head = el("button.ssh.swhead", { type: "button", "aria-expanded": "false" },
                  [el("span.swchev", {}, [glyph("chev", 13)]), el("span.swq", {}, [glyph("help", 14)]), "help"]);
  head.onclick = () => { list.hidden = !list.hidden; head.setAttribute("aria-expanded", String(!list.hidden)); };
  return el("div.sset", {}, [head, list]);
}

/* Paint quick metadata first and reserve space for slow CLI-backed model reads. */

export async function mountSettings(host, { walk = null } = {}) {
  const asked = api.agents();
  const [types, serves] = await Promise.all([
    fetch("/api/types").then(J).then((r) => r.types || r).catch(() => []),
    fetch("/api/plugins").then(J).then((r) => r.serves || []).catch(() => []),
  ]);
  const agentsAt = section("agents", ...Array.from({ length: agentsOf(types).length || 3 }, skAgent));
  host.replaceChildren(...[walk && walkthrough(walk), agentsAt,
                           serves.includes("/api/downloads/app") && companion(),
                           types.length && wiring(types), types.length && insight(types)].filter(Boolean));
  try {
    const d = await asked;
    agentsAt.replaceWith(section("agents",
      el("div.snote", {text: "Subscription logins only: Claude Code, ChatGPT/Codex, Antigravity. API keys/pay-per-use are unsupported (per-token bills; bars/caps cover subscription windows only). Keep API keys out of the environment."}),
      el("div.snote", {text: d.execution_mode === "unrestricted"
      ? "unrestricted agents — enabled in picker.toml" : "restricted agents — workspace-only, no permission prompts"}),
      ...d.agents.map(agentRow)));
  } catch (e) {
    agentsAt.replaceWith(section("agents", el("div.snote.err", { text: e.message })));
  }
}
