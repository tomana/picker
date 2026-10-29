#!/usr/bin/env python3
"""Real agents through the examples, end to end: a throwaway copy of this working tree, a picker on a spare port and
each case's job checked against what ran (the trace's agent.start: model and flags) and what it made (the card's new
version and the model it records). It spends the agents' quota, so it runs by hand, never from move_check.

    uv run --no-project python tests/agents_matrix.py [--agents claude,codex,antigravity] [--only R1,U2] [--keep]

Results go to ~/.cache/picker_matrix/<stamp>/report.json; the copies (and their data) are kept with --keep or when a
case fails.
"""
import argparse
import json
import os
import shutil
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

PICKER = Path(__file__).resolve().parents[1]
OUT = Path.home() / ".cache" / "picker_matrix"
ENDED = ("done", "failed", "cancelled", "paused")
RESTRICTED = {"claude": ["--restricted", "--permission-prompts"], "codex": ["--sandbox", "workspace-write"]}
UNRESTRICTED = {"claude": [], "codex": ["--dangerously-bypass-approvals-and-sandbox"],
                "antigravity": ["--dangerously-skip-permissions"]}


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def copy_tree(dst: Path) -> None:
    """Tracked and new files of the working tree, without what the examples made (runs/, cards/, data/)."""
    names = subprocess.run(["git", "ls-files", "-co", "--exclude-standard", "-z"], cwd=PICKER, check=True,
                           capture_output=True).stdout.split(b"\0")
    for n in filter(None, names):
        rel = n.decode()
        src = PICKER / rel
        if src.is_file():
            (dst / rel).parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, dst / rel)


class Picker:
    def __init__(self, root: Path, unrestricted: bool):
        self.root, self.unrestricted, self.port = root, unrestricted, free_port()
        self.ex = root / "examples"
        self.proc = None

    def prepare(self) -> None:
        copy_tree(self.root)
        for t in ("visual", "music"):
            m = self.ex / t / "picker-type.json"
            d = json.loads(m.read_text())
            d["agents"] = [*d["agents"], "antigravity"] if "antigravity" not in d["agents"] else d["agents"]
            m.write_text(json.dumps(d, indent=1))
            subprocess.run(["uv", "run", "-q", "--with-editable", str(self.root), "seed.py", "3"], cwd=self.ex / t,
                           check=True, capture_output=True, timeout=600)
        cfg = (self.ex / "picker.toml").read_text()
        cfg = cfg.replace('port = 8080', f'port = {self.port}')
        (self.ex / "picker.toml").write_text(f"unrestricted_agents = {str(self.unrestricted).lower()}\n" + cfg)

    def start(self) -> None:
        env = {k: v for k, v in os.environ.items() if k != "INVOCATION_ID"}   # runners as plain children, no scopes
        log = open(self.root / "server.log", "w")
        self.proc = subprocess.Popen(["uv", "run", "-q", "server.py", "--config", "examples/picker.toml",
                                      "--port", str(self.port)], cwd=self.root, env=env, stdout=log,
                                     stderr=subprocess.STDOUT, start_new_session=True)
        for _ in range(240):
            try:
                if self.call("GET", "/api/types")[0] == 200:
                    return
            except OSError:
                pass
            if self.proc.poll() is not None:
                raise RuntimeError(f"the picker exited: {(self.root / 'server.log').read_text()[-800:]}")
            time.sleep(0.5)
        raise RuntimeError("the picker didn't answer in 120 s")

    def stop(self) -> None:
        if self.proc and self.proc.poll() is None:
            os.killpg(self.proc.pid, 15)
            try:
                self.proc.wait(20)
            except subprocess.TimeoutExpired:
                os.killpg(self.proc.pid, 9)
        # runners outlive the server by design; theirs are the processes started in this copy
        subprocess.run(["pkill", "-f", "--", f"--with-editable {self.root} "], check=False)

    def call(self, method: str, path: str, body=None, timeout: float = 120) -> tuple[int, dict]:
        req = urllib.request.Request(f"http://127.0.0.1:{self.port}{path}", method=method,
                                     data=None if body is None else json.dumps(body).encode(),
                                     headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.status, json.loads(r.read() or b"{}")
        except urllib.error.HTTPError as e:
            raw = e.read()
            try:
                return e.code, json.loads(raw)
            except ValueError:
                return e.code, {"err": raw.decode(errors="replace")[:300]}

    def trace(self, job: str) -> list[dict]:
        f = self.ex / "data" / "trace.jsonl"
        out = []
        for line in f.read_text().splitlines() if f.is_file() else []:
            try:
                e = json.loads(line)
            except ValueError:
                continue
            if e.get("job") == job:
                out.append(e)
        return out

    def job(self, jid: str) -> dict:
        return self.call("GET", f"/api/queue/{jid}")[1]

    def wait(self, jid: str, until=ENDED, timeout: float = 900) -> dict:
        end = time.time() + timeout
        while time.time() < end:
            j = self.job(jid)
            if j.get("status") in until:
                return j
            time.sleep(3)
        return self.job(jid)

    def wait_start(self, jid: str, timeout: float = 300) -> dict | None:
        end = time.time() + timeout
        while time.time() < end:
            s = [e for e in self.trace(jid) if e.get("ev") == "agent.start"]
            if s:
                return s[-1]
            time.sleep(2)
        return None

    def versions(self, cid: str) -> list[dict]:
        return (self.call("GET", f"/api/cards/{cid}")[1] or {}).get("versions") or []

    def cards(self, type_: str) -> list[str]:
        d = self.call("GET", f"/api/cards?type={type_}")[1]
        return [c["id"] for c in (d.get("cards") if isinstance(d, dict) else d) or []]


def started(p: Picker, jid: str) -> list[dict]:
    return [e for e in p.trace(jid) if e.get("ev") == "agent.start"]


def verdict(p: Picker, jid: str, agent: str, model: str | None, *, want="done", card: str | None = None,
            before: int = 0) -> list[str]:
    """What's wrong with the job, by what ran: the last agent.start's agent, model and flags, the end, the card."""
    bad = []
    j = p.job(jid)
    if j.get("status") != want:
        bad.append(f"ended {j.get('status')} (want {want}): {(j.get('why') or '')[:200]}")
    runs = started(p, jid)
    if want == "done" and not runs:
        bad.append("no agent.start in the trace")
    if runs:
        s = runs[-1]
        if s.get("agent") != agent:
            bad.append(f"ran {s.get('agent')} (want {agent})")
        if model and s.get("model") != model:
            bad.append(f"ran model {s.get('model')} (want {model})")
        argv = s.get("argv") or []
        if model and model not in argv:
            bad.append(f"argv lacks the model: {argv[:12]}")
        flags = (UNRESTRICTED if p.unrestricted else RESTRICTED).get(agent, [])
        missing = [f for f in flags if f not in argv]
        if missing:
            bad.append(f"argv lacks {missing}: {argv[:14]}")
        if not p.unrestricted and "--dangerously-bypass-approvals-and-sandbox" in argv:
            bad.append("restricted, yet codex ran unsandboxed")
    if card and want == "done":
        vs = p.versions(card)
        if len(vs) <= before:
            bad.append(f"{card}: no new version ({len(vs)})")
        elif model and vs[-1].get("model") != model:
            bad.append(f"{card} v{vs[-1].get('n')} records model {vs[-1].get('model')} (want {model})")
    return bad


def pick_models(p: Picker, agents: list[str]) -> dict:
    """Two models per agent from the scratch picker's own discovery: the cheapest-sounding first."""
    code, d = p.call("GET", "/api/agents", timeout=300)
    out = {}
    for a in d.get("agents") or []:
        if a["name"] not in agents:
            continue
        ids = [m["id"] for m in (a.get("catalogue") or {}).get("models") or [] if m.get("id")]
        rank = lambda m: next((i for i, w in enumerate(("haiku", "flash-low", "flash", "luna", "astra", "terra", "sonnet",
                                                         "sol")) if w in m), 9)
        ids = sorted(ids, key=rank)
        out[a["name"]] = {"models": ids, "cheap": ids[0] if ids else None,
                          "other": next((m for m in ids[1:] if rank(m) != rank(ids[0])), ids[1] if len(ids) > 1 else None),
                          "choice": (a.get("choice") or {}).get("model")}
    return out


def enqueue(p: Picker, **body) -> str:
    code, d = p.call("POST", "/api/queue", body)
    if code >= 300:
        raise RuntimeError(f"enqueue {body}: HTTP {code} {d}")
    return (d.get("job") or d)["id"]


# ---- the cases: each returns (name, problems, note) ------------------------------------------------------------

def c_seed(p, M, agent, type_="visual"):
    m = M[agent]["cheap"]
    jid = enqueue(p, type=type_, kind="seed", text="a slow tide of rings", backend=agent, model=m)
    p.wait(jid)
    return verdict(p, jid, agent, m), f"seed {type_} · {agent} {m}"


def c_revise(p, M, agent, type_="visual", model="cheap"):
    m = M[agent][model]
    card = p.cards(type_)[0]
    before = len(p.versions(card))
    jid = enqueue(p, type=type_, kind="revise", card=card, text="calmer, fewer parts", backend=agent, model=m)
    p.wait(jid)
    return verdict(p, jid, agent, m, card=card, before=before), f"revise {type_}/{card} · {agent} {m}"


def c_choice(p, M, agent, type_="music"):
    """No model on the job: ⚙'s choice runs (set first to the cheap one), and the version records it."""
    m = M[agent]["cheap"]
    code, d = p.call("PUT", f"/api/agents/{agent}", {"model": m})
    if code != 200:
        return [f"⚙ choice PUT: {code} {d}"], f"⚙ choice · {agent}"
    card = p.cards(type_)[0]
    before = len(p.versions(card))
    jid = enqueue(p, type=type_, kind="revise", card=card, text="one voice quieter", backend=agent)
    p.wait(jid)
    return verdict(p, jid, agent, m, card=card, before=before), f"revise {type_} with ⚙'s choice · {agent} {m}"


def c_refused_then_retry(p, M, agent):
    """Restricted: agy is refused at once (no hang); retry hands it to `agent` with a model, and that runs."""
    card = p.cards("visual")[1]
    jid = enqueue(p, type="visual", kind="revise", card=card, text="warmer", backend="antigravity")
    j = p.wait(jid, until=("failed", "done", "waiting"), timeout=180)
    why = (j.get("why") or "") + ((j.get("waiting") or {}).get("why") or "")
    bad = [] if j.get("status") in ("failed", "waiting") and "unrestricted" in why and not started(p, jid) else \
        [f"agy in restricted mode: {j.get('status')} {why[:160]} (want held or failed: needs unrestricted)"]
    m = M[agent]["other"] or M[agent]["cheap"]
    before = len(p.versions(card))
    code, d = p.call("POST", f"/api/queue/{jid}/retry", {"agent": agent, "model": m})
    if code != 200:
        return bad + [f"retry: {code} {d}"], f"agy refused → retry {agent} {m}"
    p.wait(jid)
    return bad + verdict(p, jid, agent, m, card=card, before=before), f"agy refused → retry with {agent} {m}"


def c_pause_resume(p, M, agent):
    """Pause a running job, resume it on the other model: the second start is that model."""
    m1, m2 = M[agent]["cheap"], M[agent]["other"]
    card = p.cards("visual")[2]
    jid = enqueue(p, type="visual", kind="revise", card=card, text="bolder colours", backend=agent, model=m1)
    if not p.wait_start(jid):
        return ["never started"], f"pause/resume · {agent}"
    code, d = p.call("POST", f"/api/queue/{jid}/pause", {})
    j = p.wait(jid, until=("paused", "done", "failed"), timeout=120)
    if j.get("status") != "paused":
        return [f"pause: {code} {d}; then {j.get('status')}"], f"pause/resume · {agent}"
    before = len(p.versions(card))
    code, d = p.call("POST", f"/api/queue/{jid}/resume", {"agent": agent, "model": m2})
    if code != 200:
        return [f"resume: {code} {d}"], f"pause/resume · {agent}"
    p.wait(jid)
    return verdict(p, jid, agent, m2, card=card, before=before), f"pause on {m1} → resume on {m2} · {agent}"


def _auto(p, M, agent, type_, criterion=""):
    m = M[agent]["cheap"]
    code, d = p.call("PUT", "/api/auto", {"on": True, "types": [type_], "agent": agent, "model": m, "for": type_,
                                          "kinds": ["revise"], "criterion": criterion, "comment": ""})
    if code != 200:
        return None, m, [f"AUTO PUT: {code} {d}"]
    return d, m, []


def _auto_jobs(p, type_):
    return [j for j in p.call("GET", "/api/queue")[1].get("queue", []) if j.get("group") == "auto"
            and j.get("type") == type_]


def _auto_off(p):
    p.call("PUT", "/api/auto", {"on": False, "types": []})


def c_auto(p, M, agent, type_="visual"):
    """AUTO with a model: its first job runs that model; AUTO goes off after it."""
    old = {j["id"] for j in _auto_jobs(p, type_)}
    _, m, bad = _auto(p, M, agent, type_)
    if bad:
        return bad, f"AUTO · {agent}"
    end, jid = time.time() + 150, None
    while time.time() < end and not jid:
        js = [j for j in _auto_jobs(p, type_) if j["id"] not in old]
        jid = js[0]["id"] if js else None
        time.sleep(3)
    _auto_off(p)
    if not jid:
        return ["AUTO queued nothing in 150 s"], f"AUTO {type_} · {agent} {m}"
    card = p.job(jid).get("card")
    p.wait(jid)
    return verdict(p, jid, agent, m, card=card, before=0), f"AUTO {type_} · {agent} {m} (revised {card})"


def c_survey(p, M, agent, type_="visual"):
    """AUTO with a criterion: the survey runs the model, writes an order, and AUTO's next job is its first card."""
    old = {j["id"] for j in _auto_jobs(p, type_)}            # an earlier case's AUTO jobs aren't this one's
    _, m, bad = _auto(p, M, agent, type_, criterion="the card with the fewest versions first")
    if bad:
        return bad, f"survey · {agent}"
    end, seen = time.time() + 900, {}
    while time.time() < end:
        for j in _auto_jobs(p, type_):
            if j["id"] not in old:
                seen.setdefault(j["kind"], j["id"])
        if "revise" in seen:
            break
        time.sleep(4)
    _auto_off(p)
    probs = []
    if "survey" not in seen:
        return ["no survey job"], f"survey {type_} · {agent} {m}"
    probs += [f"survey: {x}" for x in verdict(p, seen["survey"], agent, m)]
    if "revise" not in seen:
        probs.append("no revise after the survey in 15 min")
    else:
        sv = p.call("GET", f"/api/auto?type={type_}")[1].get("survey") or {}
        first = ((sv.get("order") or [{}])[0]).get("card")
        got = p.job(seen["revise"]).get("card")
        if first and got != first:
            probs.append(f"AUTO revised {got}, the order's first is {first}")
        p.wait(seen["revise"])
        probs += [f"revise: {x}" for x in verdict(p, seen["revise"], agent, m)]
    return probs, f"survey {type_} · {agent} {m} → order → revise"


def c_cap(p, M, agent="antigravity"):
    """A session cap below the pool's use holds the job without running it (no tokens): c+g's model against a cap
    under c+g's 5h use; the same cap lets a gemini model run."""
    use, end = {}, time.time() + 90
    while not use.get("windows") and time.time() < end:      # a new picker's first reading takes a moment
        use = p.call("GET", "/api/usage/all", timeout=120)[1].get("sources", {}).get("agy", {})
        time.sleep(0 if use.get("windows") else 5)
    cg = next((w["used_pct"] for w in use.get("windows", []) if w["key"].startswith("claude_and_gpt") and
               w["key"].endswith(":5h")), None)
    gem = next((w["used_pct"] for w in use.get("windows", []) if w["key"].startswith("gemini_models") and
                w["key"].endswith(":5h")), None)
    caps = [c for c in (50, 60, 70, 80, 90) if gem is not None and cg is not None and gem < c <= cg]
    if not caps:
        return [], f"cap: skipped (gemini {gem}, c+g {cg}: no cap between them)"
    cap = caps[0]
    p.call("PUT", f"/api/agents/{agent}", {"session_cap": cap})
    cmodel = next((m for m in M[agent]["models"] if m.startswith(("claude-", "gpt-"))), None)
    probs = []
    if cmodel:
        jid = enqueue(p, type="visual", kind="seed", text="held by the cap", backend=agent, model=cmodel)
        j = p.wait(jid, until=("waiting", "done", "failed"), timeout=120)
        if j.get("status") != "waiting" or started(p, jid):
            probs.append(f"c+g at {cg}% under cap {cap}: {j.get('status')}, started={bool(started(p, jid))}")
        p.call("POST", f"/api/queue/{jid}/pause", {})
    m = M[agent]["cheap"]
    jid = enqueue(p, type="visual", kind="seed", text="let through by the cap", backend=agent, model=m)
    p.wait(jid)
    probs += verdict(p, jid, agent, m)
    p.call("PUT", f"/api/agents/{agent}", {"session_cap": 100})
    return probs, f"cap {cap}: {cmodel} held (c+g {cg}%), {m} runs (gemini {gem}%)"


def c_ping(p, M, agents):
    code, d = p.call("POST", "/api/agents/check", {"types": ["visual"], "agents": agents})
    if code != 202:
        return [f"check: {code} {d}"], "wiring check"
    end = time.time() + 600
    while time.time() < end:
        s = p.call("GET", f"/api/agents/check/{d['group']}")[1]
        if s.get("done"):
            break
        time.sleep(4)
    rows = s.get("rows") or []
    bad = [f"{r.get('agent') or r.get('backend')}: {r.get('status')} {str(r.get('issue') or '')[:160]}"
           for r in rows if r.get("status") != "done"
           and not (not p.unrestricted and (r.get("agent") or r.get("backend")) == "antigravity")]
    return bad, f"wiring check {', '.join(agents)}: " + ", ".join(f"{r.get('agent') or r.get('backend')} {r.get('status')}" for r in rows)


def plan(agents: list[str]) -> list[tuple]:
    have = lambda a: a in agents            # noqa: E731
    R = [("R1", c_seed, "claude"), ("R2", c_revise, "codex"), ("R3", c_choice, "claude"),
         ("R4", c_refused_then_retry, "codex"), ("R5", c_pause_resume, "codex"), ("R6", c_auto, "claude"),
         ("R7", c_survey, "codex"), ("R8", c_ping, None)]
    U = [("U1", c_seed, "antigravity"), ("U2", c_revise, "antigravity", "music"), ("U3", c_cap, "antigravity"),
         ("U4", c_revise, "codex", "visual", "other"), ("U5", c_survey, "antigravity"), ("U6", c_ping, None)]
    return [(False, c) for c in R if c[2] is None or have(c[2])] + \
           [(True, c) for c in U if c[2] is None or have(c[2])]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--agents", default="claude,codex,antigravity")
    ap.add_argument("--only", default="")
    ap.add_argument("--keep", action="store_true")
    a = ap.parse_args()
    agents = a.agents.split(",")
    only = set(filter(None, a.only.split(",")))
    stamp = time.strftime("%Y%m%d-%H%M%S")
    work = OUT / stamp
    work.mkdir(parents=True)
    report, failed = [], False
    for unrestricted in (False, True):
        cases = [c for u, c in plan(agents) if u == unrestricted and (not only or c[0] in only)]
        if not cases:
            continue
        p = Picker(work / ("unrestricted" if unrestricted else "restricted"), unrestricted)
        print(f"== {p.root.name}: preparing", flush=True)
        p.prepare()
        p.start()
        try:
            M = pick_models(p, agents)
            print("   models: " + "; ".join(f"{k} {v['cheap']} / {v['other']}" for k, v in M.items()), flush=True)
            for cid, fn, agent, *more in cases:
                t0 = time.time()
                try:
                    bad, note = fn(p, M, agents if agent is None else agent, *more)
                except Exception as e:  # a case that breaks is a finding, not the end of the run
                    bad, note = [f"{type(e).__name__}: {e}"], fn.__name__
                failed |= bool(bad)
                row = {"case": cid, "mode": p.root.name, "note": note, "ok": not bad, "problems": bad,
                       "seconds": round(time.time() - t0)}
                report.append(row)
                print(f"{'ok ' if not bad else 'BAD'} {cid} {note} ({row['seconds']} s)" +
                      "".join(f"\n      - {b}" for b in bad), flush=True)
                (work / "report.json").write_text(json.dumps(report, indent=1))
        finally:
            _auto_off(p)
            p.stop()
    print(f"\n{sum(r['ok'] for r in report)}/{len(report)} ok · {work / 'report.json'}")
    if not (a.keep or failed):
        for d in ("restricted", "unrestricted"):
            shutil.rmtree(work / d, ignore_errors=True)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
