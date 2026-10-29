/* A voice's source, read in place: SuperCollider coloured (.scd), anything else plain; line numbers, wrap or not. */
import { el } from "../dom.js";

const SC = new RegExp([
  String.raw`(?<comment>\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$))`,
  String.raw`(?<string>"(?:[^"\\]|\\[\s\S])*"?)`,
  String.raw`(?<symbol>'(?:[^'\\\n]|\\.)*'?|\\[A-Za-z_]\w*)`,
  String.raw`(?<char>\$\\?.)`,
  String.raw`(?<number>\b\d+r[0-9a-zA-Z.]+|\b0x[0-9a-fA-F]+|(?:\b\d+(?:\.\d+)?|\.\d+)(?:e[-+]?\d+)?(?:pi)?\b)`,
  String.raw`(?<keyword>\b(?:var|arg|classvar|const|this|super|nil|true|false|inf|pi|thisProcess|thisThread|thisFunction|currentEnvironment|topEnvironment)\b)`,
  String.raw`(?<env>~[A-Za-z_]\w*)`,
  String.raw`(?<cls>\b[A-Z]\w*)`,
  String.raw`(?<key>\b[a-z_]\w*(?=:(?!:)))`,
  String.raw`(?<method>(?<=\.)[a-z_]\w*)`,
  String.raw`(?<pipe>\|)`,
].join("|"), "g");

/** [{kind, text}] for SuperCollider source; kind null is plain text. */
export function scTokens(src) {
  const out = [];
  let at = 0;
  for (const m of src.matchAll(SC)) {
    if (m.index > at) out.push({ kind: null, text: src.slice(at, m.index) });
    const kind = Object.keys(m.groups).find((k) => m.groups[k] !== undefined);
    out.push({ kind, text: m[0] });
    at = m.index + m[0].length;
  }
  if (at < src.length) out.push({ kind: null, text: src.slice(at) });
  return out;
}

/** What a SynthDef says about itself: its name and its arguments with their defaults. */
export function scDefs(src) {
  const defs = [];
  for (const m of src.matchAll(/SynthDef\s*\(\s*(?:\\(\w+)|'([^']+)'|"([^"]+)")\s*,\s*\{\s*(?:\|([^|]*)\||arg\s+([^;]*);)?/g)) {
    const args = (m[4] ?? m[5] ?? "").split(",").map((a) => a.trim()).filter(Boolean);
    defs.push({ name: m[1] || m[2] || m[3], args });
  }
  return defs;
}

/* Tokens to line rows: a token spanning lines (a block comment, a string) is cut at each newline. */
function lines(tokens) {
  const rows = [[]];
  for (const t of tokens) {
    t.text.split("\n").forEach((piece, i) => {
      if (i) rows.push([]);
      if (piece) rows[rows.length - 1].push(t.kind ? el(`span.sc-${t.kind}`, { text: piece }) : document.createTextNode(piece));
    });
  }
  return rows;
}

export function codeView(text, { name = "" } = {}) {
  const sc = /\.scd$/i.test(name);
  const tokens = sc ? scTokens(text) : [{ kind: null, text }];
  const rows = lines(tokens);
  if (rows.length > 1 && !rows[rows.length - 1].length) rows.pop();      // the file's last newline
  const width = String(rows.length).length;
  const body = el("div.codebody.wrap", { style: `--gut:${width + 1}ch` },
    rows.map((r, i) => el("div.cl", {}, [el("span.cn", { text: String(i + 1) }), el("span.cc", {}, r.length ? r : ["​"])])));
  const defs = sc ? scDefs(text) : [];
  const about = defs.length ? el("div.codedefs", {}, defs.map((d) =>
    el("div", {}, [el("span.sc-symbol", { text: `\\${d.name}` }),
                   d.args.length ? el("span", { text: `  ${d.args.join("  ")}` }) : null].filter(Boolean)))) : null;
  return el("div.codeview", {}, [about, body].filter(Boolean));
}
