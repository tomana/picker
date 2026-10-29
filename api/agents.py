"""Wiring checks enqueue ping-only jobs through real runners; no model calls happen here.
Allow-list browsable inputs and distinguish current configuration from captured receipts."""
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path

from flask import Blueprint, abort, jsonify, request

from api.researchers import _home, _one, _types, start_runner
from core import agents as A
from core import config as CONFIG
from core.instructions import HOME, ROOT, _chain, _file, _show, instruction_files, referenced  # noqa: F401
from core import prefs as P
from core import queue as Q

bp = Blueprint("agents", __name__)




def _row(name: str, reg: dict, discover: bool = True, cached: bool = False) -> dict:
    s = reg["agents"][name]
    cat = A.cached_catalogue(name, reg=reg) if cached else A.catalogue(name, reg=reg, discover=discover)
    return {"name": name, "label": s.get("label", name), "cli": s["cli"],
            "installed": bool(A.binary(s["cli"], reg)),
            "choice": A.choice(name, reg=reg),
            "default": {"model": s.get("model"), "effort": s.get("effort"), "session_cap": 100},
            "execution": A.execution(name, reg),
            "catalogue": cat,
            "menu": A.menu(name, reg=reg, cat=cat)}


@bp.get("/api/agents")
def list_agents():
    """Refresh the stored catalogue unless cached=1; cached callers must never start discovery."""
    reg = A.load()
    cached = request.args.get("cached") in ("1", "true")
    rows = [_row(n, reg, cached=cached) for n in A.names(reg)]
    if not cached:
        try:
            A.remember({r["name"]: r["catalogue"] for r in rows})
        except OSError:
            pass
    return jsonify({
        "agents": rows,
        "execution_mode": "unrestricted" if CONFIG.get().unrestricted_agents else "restricted",
        "types": [{"type": t["type"], "label": t.get("label", t["type"]),
                   "agents": t.get("agents", [])} for t in _types()],
    })


@bp.put("/api/agents/<name>")
def set_agent(name):
    reg = A.load()
    if name not in reg["agents"]:
        abort(404, description=f"no agent {name!r}")
    body = request.get_json(silent=True) or {}
    current = A.choice(name, reg=reg)
    model = body.get("model", current["model"]) or None
    effort = body.get("effort", current["effort"]) or None
    cap = body.get("session_cap", current["session_cap"])
    from core import budget as B
    if isinstance(cap, bool) or not isinstance(cap, int) or cap not in B.CAPS:
        return jsonify({"ok": False, "err": "session_cap is 50, 60, 70, 80, 90 or 100 (off)"}), 400
    why = A.validate(name, model, effort, reg=reg)
    if why:
        return jsonify({"ok": False, "err": why}), 400
    mine = dict(A.chosen())
    d = reg["agents"][name]
    # Choosing the default is forgetting the choice, so the registry's next default
    # applies; rather than pinning today's default for ever.
    if model == d.get("model") and effort == d.get("effort") and cap == 100:
        mine.pop(name, None)
    else:
        mine[name] = {"model": model, "effort": effort, **({"session_cap": cap} if cap < 100 else {})}
    P.set("agents", mine)
    if cap == 100:
        B.release(name)
    return jsonify({"ok": True, "agent": _row(name, reg, discover=False)})


@bp.get("/api/agents/<name>/budget")
def agent_budget(name):
    if name not in A.names():
        abort(404)
    from core import budget as B
    return jsonify(B.check(name, model=request.args.get("model") or None,
                           permissions=request.args.get("permissions") != "0"))



_DESCRIBE = r"""
import json, sys
sys.path.insert(0, ".")
import queue_runner as Q
agent = sys.argv[1]
job = {"id": "insight", "type": Q.TYPE, "kind": sys.argv[2], "card": sys.argv[3] or None,
       "text": sys.argv[4], "version": int(sys.argv[5]) if sys.argv[5].isdigit() else None}
print(json.dumps({"cwd": str(Q.cwd()), "brief": Q.brief(job, agent)}))
"""


def _describe(t: dict, agent: str, kind="seed", card="", text="", version="") -> dict:
    """Run the type's own context and brief helpers in its runner environment to avoid a second prompt implementation."""
    # Give the helper the same editable package path as the actual runner.
    path = os.pathsep.join(filter(None, [str(CONFIG.PICKER), os.environ.get("PYTHONPATH")]))
    r = subprocess.run([sys.executable, "-c", _DESCRIBE, agent, kind, card, text, str(version or "")],
                       cwd=str(_home(t)), capture_output=True, text=True, timeout=30,
                       env={**A.agent_env(), "PYTHONDONTWRITEBYTECODE": "1", "PYTHONPATH": path})
    if r.returncode:
        tail = (r.stderr or r.stdout).strip().splitlines()[-3:]
        return {"error": " / ".join(tail)[:400]}
    return json.loads(r.stdout.strip().splitlines()[-1])






def _frontmatter(p: Path) -> dict:
    try:
        head = p.read_text(errors="replace")[:2000]
    except OSError:
        return {}
    m = re.match(r"---\n(.*?)\n---", head, re.S)
    out, key = {}, None
    for line in (m.group(1).splitlines() if m else []):
        if key and line[:1] in (" ", "\t"):          # a folded (`>-`, `|`) value
            out[key] = (out[key] + " " + line.strip()).strip()
            continue
        key = None
        k, _, v = line.partition(":")
        k, v = k.strip(), v.strip()
        if k in ("name", "description"):
            if v in (">", ">-", "|", "|-", ""):
                out[k], key = "", k
            else:
                out[k] = v.strip('"')
    return out


def skills(cli: str, cwd: Path) -> list[dict]:
    """Include user skills and project skill folders along cwd's ancestry up to the repository root."""
    roots = []
    if cli == "claude":
        roots.append((HOME / ".claude/skills", "user"))
        roots += [(d / ".claude/skills", "project") for d in _chain(cwd, ROOT)]
    elif cli == "codex":
        roots.append((HOME / ".codex/skills", "user"))
    elif cli == "agy":
        roots += [(HOME / ".gemini/antigravity-cli/builtin/skills", "built in"),
                  (HOME / ".gemini/antigravity-cli/skills", "user")]
    else:
        roots.append((HOME / ".gemini/skills", "user"))
    out, seen = [], set()
    for base, scope in roots:
        if not base.is_dir():
            continue
        for f in sorted(base.rglob("SKILL.md")):
            if len(f.relative_to(base).parts) > 4 or f in seen:
                continue
            seen.add(f)
            fm = _frontmatter(f)
            out.append({"name": fm.get("name") or f.parent.name, "scope": scope,
                        "description": (fm.get("description") or "")[:240],
                        "path": _show(f)})
        for d in sorted(base.iterdir()) if cli == "agy" else []:
            if d.is_dir() and not (d / "SKILL.md").exists() and d not in seen:
                seen.add(d)
                out.append({"name": d.name, "scope": scope, "description": "",
                            "path": _show(d)})
    return out



@bp.get("/api/agents/insight/<type_>")
def insight(type_):
    t = _one(type_)
    names = [a for a in t.get("agents", []) if a in A.names()]
    agent = request.args.get("agent") or (names[0] if names else None)
    if agent not in names:
        abort(400, description=f"{type_} runs {names}")
    # Show what this send would run now; receipts capture what actually ran.
    kind, card = request.args.get("kind") or "seed", request.args.get("card") or ""
    d = _describe(t, agent, kind, card, request.args.get("text") or "", request.args.get("version") or "")
    if "error" in d:
        return jsonify({"type": type_, "agent": agent, "error": d["error"]}), 200
    cwd = Path(d["cwd"])
    cli = A.spec(agent)["cli"]
    brief = d["brief"]
    recent = [j for j in Q.jobs(type=type_) if j["kind"] != "ping"][-8:]
    return jsonify({
        "type": type_, "agent": agent, "cwd": _show(cwd), "cli": cli, "kind": kind, "card": card or None,
        "choice": A.choice(agent),
        # the command, as the runner would run it now (the brief in it by name); the type's manifest, read-only
        "command": [a if a != brief else "<the brief>"
                    for a in A.argv(agent, brief, cwd, model=request.args.get("model") or A.choice(agent)["model"],
                                    effort=A.choice(agent)["effort"])],
        "manifest": CONFIG.manifest(type_),
        "brief": {"text": brief, "chars": len(brief), "tokens": len(brief) // 4},
        "referenced": referenced(brief, cwd),
        "instructions": instruction_files(cli, cwd),
        "skills": skills(cli, cwd),
        "recent": [{"id": j["id"], "kind": j["kind"], "card": j.get("card"),
                    "status": j["status"], "researcher": j.get("researcher"),
                    "why": j.get("why"),
                    "seconds": round(j["ended"] - j["started"])
                    if j.get("ended") and j.get("started") else None}
                   for j in reversed(recent)],
    })


# Allow only manifest-derived research areas and listed instructions/skills, never card stores or credentials.
# Outside research areas, admit only listed Markdown instructions and skill files.
_HOME_FILES = [HOME / ".claude/CLAUDE.md", HOME / ".codex/AGENTS.md", HOME / ".gemini/GEMINI.md"]
_HOME_DIRS = [HOME / ".claude/skills", HOME / ".codex/skills", HOME / ".gemini/skills",
              HOME / ".gemini/antigravity-cli/skills", HOME / ".gemini/antigravity-cli/builtin/skills"]
_SECRETS = re.compile(r"(credential|auth|token|secret|\.env)", re.I)
_INSTRUCTIONS = ("CLAUDE.md", "CLAUDE.local.md", "AGENTS.md", "GEMINI.md")


def _git_top(d: Path) -> Path:
    for x in _chain(d, Path("/")):
        if (x / ".git").exists():
            return x
    return d


def _areas() -> tuple[list[Path], list[Path]]:
    areas, chain = [], []
    for t in _types():
        home = _home(t).resolve()
        top = _git_top(home)
        rel = home.relative_to(top).parts if home.is_relative_to(top) else ()
        areas.append(top / rel[0] if rel else home)
        chain += _chain(home, top)
    return areas, chain


def _readable(p: Path) -> bool:
    if _SECRETS.search(p.name):
        return False
    from core import stores as ST
    if any(p.is_relative_to(s.resolve()) for s in ST.every()):
        return False
    areas, chain = _areas()
    # a project's own text files, never inside a hidden folder (settings, credentials, caches live there)
    if p.suffix in (".md", ".json", ".jsonl") and any(
            p.is_relative_to(a) and not any(x.startswith(".") for x in p.relative_to(a).parts) for a in areas):
        return True
    if p.suffix != ".md":
        return False
    # an instruction file in a researcher's folder or any folder above it: what its CLI loads
    if p.name in _INSTRUCTIONS and any(_home(t).resolve().is_relative_to(p.parent) for t in _types()):
        return True
    if any(p.is_relative_to(d / ".claude/skills") for d in chain):
        return True
    return p in [f.resolve() for f in _HOME_FILES] or any(p.is_relative_to(d.resolve()) for d in _HOME_DIRS)


@bp.get("/api/agents/file")
def read_file():
    """One instruction or skill file, as text; only what the insight lists point at (_readable)."""
    raw = request.args.get("path", "")
    p = (HOME / raw[2:]) if raw.startswith("~/") else (ROOT / raw)
    p = p.resolve()
    if not p.is_file() or not _readable(p):
        abort(404)
    text = p.read_text(errors="replace")
    return jsonify({"path": raw, "bytes": len(text.encode()),
                    "text": text[:200_000], "cut": len(text) > 200_000})



def _row_of(j: dict) -> dict:
    """Keep type-wide preflight issues separate from agent-cell states.
    Limits and skipped checks warn; broken wiring fails."""
    stages = [e.get("text") for e in Q.history(j["id"]) if e.get("event") == "phase"]
    warns = [w for w in (A.parse_warn(t) for t in stages) if w]
    own = [w for w in warns if w["scope"] != "preflight"]
    issue = None
    if j["status"] == "failed":
        limited = (j.get("why") or "").startswith("AgentLimited")
        state = "limited" if limited else "failed"
        issue = {"level": state, **A.explain(j.get("why"), stages, j.get("backend"))}
    elif j["status"] == "done":
        state = "warn" if own else "ok"
        if own:
            issue = {"level": "warn", "short": own[-1]["name"],
                     "detail": own[-1]["detail"], "fix": own[-1]["fix"]}
    else:
        state = j["status"]
    return {"id": j["id"], "type": j["type"], "agent": j.get("backend"),
            "status": j["status"], "state": state, "issue": issue,
            "type_issues": [{"level": "warn", "short": w["name"], "detail": w["detail"],
                             "fix": w["fix"]} for w in warns if w["scope"] == "preflight"],
            "phase": j.get("phase"), "why": j.get("why"),
            "researcher": j.get("researcher"),
            "seconds": round(j["ended"] - j["started"], 1)
            if j.get("ended") and j.get("started") else None,
            "stages": stages}


def issues(rows: list[dict]) -> list[dict]:
    """Deduplicate issues by cause and affected scope rather than repeating them per cell."""
    out: dict = {}
    for r in rows:
        found = ([(r["issue"], f"{r['type']} · {r['agent']}")] if r.get("issue") else []) \
            + [(t, r["type"]) for t in r.get("type_issues", [])]
        for iss, where in found:
            # Attribute agent failures to the agent; type and render conditions retain their own scope.
            who = r["agent"] if (iss is r.get("issue") and r["agent"] != "render") else None
            title = f"{who} · {iss['short']}" if who else iss["short"]
            key = (iss["level"], title, iss.get("fix"))
            g = out.setdefault(key, {**iss, "title": title, "where": []})
            if where not in g["where"]:
                g["where"].append(where)
    order = {"failed": 0, "limited": 1, "warn": 2}
    for name in A.api_env_vars():
        out[("environment", name)] = {
            "level": "warn", "short": f"{name} is set", "title": f"{name} is set",
            "detail": "Subscription logins only: this API/provider variable is removed from agent and check environments.",
            "fix": f"Remove {name} from the picker's environment; use the CLI's subscription login.",
            "where": ["picker environment"],
        }
    return sorted(out.values(), key=lambda g: (order.get(g["level"], 3), g["short"]))


@bp.post("/api/agents/check")
def check():
    body = request.get_json(silent=True) or {}
    want_types = body.get("types")
    want_agents = body.get("agents")
    group = f"wiring-{time.strftime('%Y%m%d-%H%M%S')}"
    made, runners = [], {}
    for t in _types():
        if want_types and t["type"] not in want_types:
            continue
        if not t.get("start"):
            continue
        # Every agent this type runs, plus `render`: the agent-free half of a job;
        # this type's real render, through its own tool (researcher.ping_with).
        agents = [a for a in t.get("agents", []) + ["render"]
                  if (a in A.names() or a == "render")
                  and (not want_agents or a in want_agents)
                  and (a == "render" or A.execution(a)["allowed"])]    # a refused agent's ping would wait for ever
        for a in agents:
            made.append(Q.enqueue(type=t["type"], kind="ping", backend=a, group=group,
                                  text=f"wiring check · {a}"))
        if not agents:
            continue
        res, code = start_runner(t, kinds=["ping"])
        if code == 409:
            who = (res.get("state") or {}).get("agent")
            runners[t["type"]] = (f"{who or 'a researcher'} is already working it — "
                                  f"the pings go next, ahead of the queue")
        elif res.get("ok"):
            runners[t["type"]] = "started, pings only"
        else:
            runners[t["type"]] = res.get("err") or f"HTTP {code}"
    if not made:
        abort(400, description="nothing to check")
    rows = [_row_of(Q.get(j["id"])) for j in made]
    return jsonify({"group": group, "runners": runners, "rows": rows,
                    "issues": issues(rows)}), 202


@bp.get("/api/agents/check/<group>")
def check_status(group):
    rows = [_row_of(j) for j in Q.jobs() if j.get("group") == group
            and j["kind"] == "ping"]
    if not rows:
        abort(404, description=f"no check {group!r}")
    return jsonify({"group": group, "rows": rows, "issues": issues(rows),
                    "done": all(r["status"] not in Q.LIVE for r in rows)})


@bp.get("/api/agents/check")
def last_check():
    groups = sorted({j["group"] for j in Q.jobs()
                     if j["kind"] == "ping" and (j.get("group") or "").startswith("wiring-")})
    if not groups:
        return jsonify({"group": None, "rows": [], "done": True, "issues": issues([])})
    return check_status(groups[-1])
