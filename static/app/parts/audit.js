/* Keep source and job identity on each audit event; fetch full agent logs only on demand. */

import { el } from "../dom.js";

const put = (node, ...kids) => node.replaceChildren(...kids.filter(Boolean));
const pad = (n) => String(n).padStart(2, "0");
function when(ts, approx = false) {
  if (!ts) return { day: "", time: "--:--:--" };
  const d = new Date(ts * 1000);
  return { day: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
           time: (approx ? "≈" : "") +
                 `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` };
}
const kb = (b) => (b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB`
                 : b >= 1024 ? `${Math.round(b / 1024)} KB` : `${b} B`);

function asText(d, only) {
  const lines = [`# audit · ${d.card.type} · ${d.card.id} · ${d.card.label}`, ""];
  let day = "";
  for (const x of d.entries.filter((x) => !only || x.job === only)) {
    const w = when(x.ts, x.approx);
    if (w.day && w.day !== day) { day = w.day; lines.push(`## ${day}`); }
    lines.push(`${w.time}  ${x.src.padEnd(10)} ${String(x.ev).padEnd(16)} ` +
               `${x.job ? "job=" + x.job + "  " : ""}${x.text}`);
  }
  for (const l of d.logs.filter((l) => !only || l.job === only)) {
    lines.push("", `## agent log · job=${l.job} · ${l.kind} · ${l.status} · ${l.path}`,
               l.cut ? "(first part cut — the file is larger than 2 MB)" : "", l.text);
  }
  return lines.join("\n");
}

export async function mountAudit(host, cid, { toast = () => {} } = {}) {
  put(host, el("div.snote", { text: "reading every log…" }));
  let d;
  try {
    const r = await fetch(`/api/cards/${encodeURIComponent(cid)}/audit`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    d = await r.json();
  } catch (e) { put(host, el("div.snote.err", { text: e.message })); return; }

  let only = null;
  const chips = el("div.schips");
  const list = el("div.alist");
  const logs = el("div.alogs");
  const copy = el("button.sbtn", { type: "button", text: "copy all" });
  copy.onclick = async () => {
    const text = asText(d, only);
    try { await navigator.clipboard.writeText(text); toast(`copied ${kb(text.length)}`); }
    catch (_) {
      /* When clipboard access is unavailable, select plain text for manual copying. */
      const ta = el("textarea.ideabox", { rows: "8" });
      ta.value = text;
      host.prepend(ta);
      ta.select();
      toast("select-all is set — copy it from the box");
    }
  };

  const paint = () => {
    const jobs = d.jobs;
    put(chips,
      ...[{ id: null, label: `all · ${d.entries.length}` },
          ...jobs.map((j) => ({ id: j.id, label: `${j.kind} ${j.id.slice(0, 6)} · ${j.status}` }))]
        .map((c) => {
          const b = el("button.chip" + (c.id === only ? ".on" : ""), { type: "button",
            text: c.label, title: c.id || "everything" });
          b.onclick = () => { only = c.id; paint(); };
          return b;
        }));
    let day = "";
    const rows = [];
    for (const x of d.entries.filter((x) => !only || x.job === only)) {
      const w = when(x.ts, x.approx);
      if (w.day && w.day !== day) { day = w.day; rows.push(el("div.aday", { text: day })); }
      const tok = x.job ? el("button.atok", { type: "button", text: x.job.slice(0, 6),
                                              title: `job ${x.job} — show only this job` }) : null;
      if (tok) tok.onclick = () => { only = x.job; paint(); };
      const role = ["queue", "card", "worker"].includes(x.src) ? x.src : x.src === "operator" ? "input" : "system";
      rows.push(el("div.aline." + role, {}, [
        el("span.at", { text: w.time }),
        el("span.as", { text: x.src }),
        el("span.ae", { text: x.ev }),
        tok,
        el("span.ax", { text: x.text }),
      ]));
    }
    put(list, ...rows);
    put(logs, ...d.logs.filter((l) => !only || l.job === only).map((l) => {
      const pre = el("pre.sview.alog", { text: (l.cut ? "(first part cut — larger than 2 MB)\n" : "") + l.text });
      return el("details.ajob", {}, [
        el("summary", { text: `agent log · ${l.kind} ${l.job.slice(0, 6)} · ${l.status} · ${kb(l.bytes)}` }),
        el("div.snote", { text: l.path }), pre]);
    }));
  };
  paint();
  put(host,
    d.note ? el("div.snote", { text: d.note }) : null,
    el("div.srow", {}, [copy,
      el("span.snote", { text: `${d.jobs.length} job(s) · ${d.logs.length} agent log(s)` })]),
    chips,
    el("div.ssh", { text: "timeline — card · operator · queue · system" }),
    list,
    d.logs.length ? el("div.ssh", { text: "what the agent said" }) : null,
    logs);
}
