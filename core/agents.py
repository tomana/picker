"""One registry, invocation builder and failure policy for all types.
Type-specific differences belong in the supplied brief."""
from __future__ import annotations

import contextlib
import errno
import json
import os
import re
import subprocess
import sys
import time
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

from . import config as C
from . import proc as P
from . import trace as T
from . import worker as W
from . import agy as AG

REGISTRY = C.get().agents                     # the config's `agents` (agents.json)
CODEX_CACHE = Path.home() / ".codex" / "models_cache.json"
# Settings refresh writes discovery; sends, AUTO and queue validation use only this stored catalogue.
MODELS_CACHE = C.get().data / "agent_models.json"

# Remove inherited nested-session markers so child CLIs do not refuse to start.
NESTED_ENV = ("CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_AGENT_SDK_VERSION",
              "CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING")

# Credentials and cloud selectors must not override subscription logins.
API_ENV = ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_AWS_API_KEY",
           "ANTHROPIC_FOUNDRY_API_KEY", "ANTHROPIC_FOUNDRY_AUTH_TOKEN", "AWS_BEARER_TOKEN_BEDROCK",
           "OPENAI_API_KEY", "CODEX_API_KEY", "AZURE_OPENAI_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY",
           "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY",
           "CLAUDE_CODE_USE_ANTHROPIC_AWS", "CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD",
           "CLAUDE_CODE_USE_GATEWAY", "CLAUDE_CODE_USE_MANTLE")

# Search common CLI install directories after inherited PATH and pass them to children too.
# Launchers may lack the interactive shell's PATH.
EXTRA_PATH = [str(Path.home() / d) for d in (".npm-global/bin", ".local/bin", "bin")] + \
             ["/usr/local/bin"]


def agent_env() -> dict:
    """Keep subscription logins and CLI paths, not API credentials or nested-session markers."""
    env = {k: v for k, v in os.environ.items() if k not in NESTED_ENV and k not in API_ENV}
    have = env.get("PATH", "").split(os.pathsep)
    env["PATH"] = os.pathsep.join(have + [d for d in EXTRA_PATH if d not in have])
    return env


def api_env_vars() -> list[str]:
    """Report names only; never expose credential values to the page or trace."""
    return sorted(k for k in API_ENV if k in os.environ)


def binary(cli: str, reg: dict | None = None) -> str | None:
    if cli == "fake":
        return sys.executable
    import shutil
    exe = (reg or load()).get("binaries", {}).get(cli, cli)
    return shutil.which(exe, path=agent_env()["PATH"])


# Read quota through the installed CLI without model calls or direct credential access.
_CLAUDE_USAGE_RE = re.compile(
    r"^Current (session|week \(all models\)): (\d+(?:\.\d+)?)% used(?: · resets (.+?))?\s*$", re.M)
_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]


def claude_reset(text: str | None, now: float) -> str | None:
    """Parse the CLI's local reset to an ISO timestamp; None means unknown, never resetting now."""
    m = re.fullmatch(r"(?:([A-Z][a-z]{2}) (\d{1,2}), )?(\d{1,2})(?::(\d{2}))?([ap]m) \(([^)]+)\)",
                     (text or "").strip())
    if not m or (m[1] and m[1] not in _MONTHS):
        return None
    mon, day, hh, mm, ap, zone = m.groups()
    try:
        tz = ZoneInfo(zone)
    except Exception:
        return None
    here = datetime.fromtimestamp(now, tz)
    hour = int(hh) % 12 + (12 if ap == "pm" else 0)
    if mon:
        at = datetime(here.year, _MONTHS.index(mon) + 1, int(day), hour, int(mm or 0), tzinfo=tz)
        if at < here - timedelta(days=180):          # Roll month/day-only resets into the next year when needed.
            at = at.replace(year=here.year + 1)
    else:
        at = here.replace(hour=hour, minute=int(mm or 0), second=0, microsecond=0)
        if at < here:
            at += timedelta(days=1)
    return at.isoformat()


class CLIMissing(FileNotFoundError):
    """The CLI a reading comes from is not installed: the bars warn instead of guessing."""


def claude_usage(now: float, cwd: Path | None = None) -> dict:
    """Read session/weekly usage without a model call; use the cache directory to avoid project-context growth."""
    exe = binary("claude")
    if not exe:
        raise CLIMissing("claude CLI not installed")
    cwd = cwd or C.get().cache
    cwd.mkdir(parents=True, exist_ok=True)
    r = subprocess.run([exe, "-p", "/usage", "--output-format", "json", "--no-session-persistence"],
                       cwd=str(cwd), env=agent_env(), stdin=subprocess.DEVNULL,
                       capture_output=True, text=True, timeout=45)
    try:
        text = json.loads(r.stdout).get("result") or ""
    except (ValueError, AttributeError):
        text = ""
    found = {k: (float(pct), claude_reset(at, now)) for k, pct, at in _CLAUDE_USAGE_RE.findall(text)}
    if "session" not in found and "week (all models)" not in found:
        tail = (text or r.stderr or r.stdout or "").strip().splitlines()[-1:] or ["no answer"]
        raise RuntimeError(f"claude /usage: {tail[0][:100]}")
    s, w = found.get("session"), found.get("week (all models)")
    return {"session": s and {"pct": s[0], "resets_at": s[1]},
            "weekly": w and {"pct": w[0], "resets_at": w[1]}}


# A reply proves startup, executable discovery, model/effort acceptance and working-directory access.
PING = "This is a wiring check, not a task. Do nothing else. Reply with exactly one word: READY"
# A reply alone cannot prove sandbox write access; the file probe exercises that separately.
PING_WRITE = ("This is a wiring check, not a task. Do nothing else. Using your file "
              "tools, create the file {path} (relative to your working directory) "
              "containing exactly the word READY. Then reply with exactly one word: READY")



def load(path: Path | None = None) -> dict:
    return json.loads(Path(path or REGISTRY).read_text())


def names(reg: dict | None = None) -> list[str]:
    """Expose named-only registry entries only when a type manifest requests them."""
    reg = reg or load()
    used = None
    out = []
    for n, s in reg["agents"].items():
        if s.get("named_only"):
            if used is None:
                used = {a for t in C.manifests() for a in t.get("agents") or []}
            if n not in used:
                continue
        out.append(n)
    return out


def spec(name: str, reg: dict | None = None) -> dict:
    agents = (reg or load())["agents"]
    if name not in agents:
        raise ValueError(f"unknown agent {name!r} — one of {sorted(agents)}")
    return agents[name]


def chosen(prefs: dict | None = None) -> dict:
    if prefs is None:
        from . import prefs as P
        prefs = P.fold()
    got = prefs.get("agents")
    return got if isinstance(got, dict) else {}


def choice(name: str, *, reg: dict | None = None, prefs: dict | None = None) -> dict:
    """Overlay saved choices on registry defaults at each call so edits apply without restart."""
    s = spec(name, reg)
    mine = chosen(prefs).get(name) or {}
    out = {"model": s.get("model"), "effort": s.get("effort"), "session_cap": 100, "set_by": "default"}
    for k in ("model", "effort"):
        if k in mine:
            out[k] = mine[k] or None
            out["set_by"] = "operator"
    if mine.get("session_cap") in (50, 60, 70, 80, 90, 100):
        out["session_cap"] = mine["session_cap"]
        if out["session_cap"] != 100:
            out["set_by"] = "operator"
    return out



_agy_cache: dict = {"at": 0.0, "models": None, "err": None}


def codex_models(cache: Path = CODEX_CACHE) -> list[dict]:
    """Use the CLI-maintained catalogue and supported efforts, excluding hidden models."""
    try:
        data = json.loads(Path(cache).read_text())
    except Exception:
        return []
    out = []
    for m in data.get("models", []):
        if m.get("visibility") != "list":
            continue
        out.append({"id": m["slug"], "label": m.get("display_name") or m["slug"],
                    "efforts": [e["effort"] for e in m.get("supported_reasoning_levels", [])],
                    "default_effort": m.get("default_reasoning_level")})
    return out


def agy_models(run=subprocess.run, ttl: float = 600) -> list[dict]:
    """Cache model discovery for ten minutes because it requires a network round trip."""
    now = time.time()
    if _agy_cache["models"] is not None and now - _agy_cache["at"] < ttl:
        return _agy_cache["models"]
    exe = binary("agy")
    if not exe:                                  # not installed: nothing to ask (and nothing is started)
        _agy_cache.update(at=now, models=[], err="agy CLI not installed")
        return _agy_cache["models"]
    try:
        r = run([exe, "models"], capture_output=True, text=True, timeout=30, env=agent_env())
        models = []
        for line in (r.stdout or "").splitlines():
            parts = line.split("\t")
            if len(parts) == 2 and parts[0].strip() and " " not in parts[0].strip():
                models.append({"id": parts[0].strip(), "label": parts[1].strip()})
        _agy_cache.update(at=now, models=models, err=None if models else
                          (r.stderr or r.stdout or "no models listed").strip()[-200:])
    except Exception as e:                       # a missing CLI is a fact, not a crash
        _agy_cache.update(at=now, models=[], err=str(e))
    return _agy_cache["models"]


def catalogue(name: str, *, reg: dict | None = None, discover: bool = True) -> dict:
    """Discover models where the CLI exposes them; otherwise use the registry, not an invented list."""
    reg = reg or load()
    s = spec(name, reg)
    cli = s["cli"]
    efforts = reg.get("efforts", {}).get(cli, [])
    if cli == "codex":
        models = codex_models() if discover else []
    elif cli == "agy":
        models = agy_models() if discover else []
    else:
        models = [{"id": m, "label": m} for m in s.get("models", [])]
    for m in models:
        m.setdefault("efforts", efforts)
    err = _agy_cache["err"] if cli == "agy" else None
    return {"cli": cli, "models": models, "efforts": efforts,
            "cli_default": cli_default(cli),
            **({"error": err} if err else {})}


def remember(cats: dict, path: Path | None = None) -> None:
    """Replace discovered catalogues atomically so readers cannot see a partial write."""
    path = Path(path or MODELS_CACHE)
    path.parent.mkdir(parents=True, exist_ok=True)     # a fresh install's data folder doesn't exist yet
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps({"at": time.time(), "agents": cats}, indent=1))
    tmp.replace(path)


def cached_catalogue(name: str, *, reg: dict | None = None, path: Path | None = None) -> dict:
    """Use stored discovery or registry fallback without invoking a CLI."""
    try:
        got = json.loads(Path(path or MODELS_CACHE).read_text()).get("agents", {}).get(name)
        if isinstance(got, dict) and isinstance(got.get("models"), list):
            return got
    except (OSError, ValueError):
        pass
    return catalogue(name, reg=reg, discover=False)


_EFFORT_SUFFIX = re.compile(r"-(low|medium|high)$")


def _version(mid: str) -> tuple:
    """x-6.1-y -> (6, 1); x-5-5-high -> (5, 5); a date stamp is not a version."""
    return tuple(int(x) for x in re.findall(r"\d+", _EFFORT_SUFFIX.sub("", mid)) if len(x) < 8)


def menu(name: str, *, reg: dict | None = None, cat: dict | None = None) -> list[dict]:
    """Choose the newest matching model per registry slot, at its highest embedded effort.
    Omit unmatched slots; absent menu permits the full catalogue. Never start discovery."""
    reg = reg or load()
    models = (cat or cached_catalogue(name, reg=reg)).get("models", [])
    rank = lambda mid: ({"high": 3, "medium": 2, "low": 1}[m.group(1)]
                        if (m := _EFFORT_SUFFIX.search(mid)) else 3)
    out = []
    for slot in spec(name, reg).get("menu") or []:
        for pat in slot.get("match") or []:
            hits = [m for m in models if re.search(pat, m["id"])]
            if not hits:
                continue
            best = max(hits, key=lambda m: (_version(m["id"]), rank(m["id"])))
            if all(o["id"] != best["id"] for o in out):
                label = best.get("label") or best["id"]
                if label == best["id"] and (c := re.fullmatch(r"claude-([a-z]+)-(\d+)-(\d+)", label)):
                    label = f"{c.group(1)} {c.group(2)}.{c.group(3)}"
                out.append({"id": best["id"], "label": label, "slot": slot.get("slot")})
            break
    return out


def cli_default(cli: str) -> dict:
    """Read the CLI's configured default; a null override does not mean no effort."""
    if cli != "codex":
        return {}
    try:
        import tomllib
        cfg = tomllib.loads((Path.home() / ".codex/config.toml").read_text())
    except Exception:
        return {}
    return {k: cfg[v] for k, v in (("model", "model"), ("effort", "model_reasoning_effort"))
            if isinstance(cfg.get(v), str)}


def validate(name: str, model, effort, *, reg: dict | None = None,
             cat: dict | None = None) -> str | None:
    """Validate before saving, not while claiming; None delegates to CLI defaults."""
    cat = cat or catalogue(name, reg=reg)
    ids = {m["id"]: m for m in cat["models"]}
    if model is not None:
        if not isinstance(model, str) or not re.fullmatch(r"[A-Za-z0-9._:-]{1,80}", model):
            return "a model id is letters, digits and . _ : -"
        if ids and model not in ids:
            return f"{name} offers no model {model!r}"
        if not ids and spec(name, reg)["cli"] in ("codex", "agy"):
            return f"could not list {name}'s models — {cat.get('error') or 'try again'}"
    if effort is not None:
        allowed = (ids.get(model) or {}).get("efforts") or cat["efforts"]
        if effort not in allowed:
            return (f"{name} takes no effort setting" if not allowed
                    else f"effort must be one of {allowed}")
    return None



def execution(name: str, reg: dict | None = None) -> dict:
    cli = spec(name, reg)["cli"]
    unrestricted = C.get().unrestricted_agents
    allowed = unrestricted or cli in ("claude", "codex", "fake")
    return {"mode": "unrestricted" if unrestricted else "restricted", "allowed": allowed,
            "reason": None if allowed else f"{name} needs unrestricted_agents: no verified restricted unattended mode"}


def argv(name: str, prompt: str, cwd: Path, *, model: str | None, effort: str | None,
         reg: dict | None = None) -> list[str]:
    """Only explicit config opt-in enables permission bypass flags."""
    reg = reg or load()
    s = spec(name, reg)
    cli = s["cli"]
    mode = execution(name, reg)
    if not mode["allowed"]:
        raise ValueError(mode["reason"])
    exe = reg.get("binaries", {}).get(cli, cli)
    # A bare name is resolved here, against the agent's PATH, so the argv names the
    # file that will actually run; a path in the registry (a test's fake) is kept.
    if cli == "fake":
        # The stand-in handles checks and delegates real briefs to the project's fake agent without login requirements.
        return [sys.executable, str(C.PICKER / "tools" / "fake_agent.py"), prompt]
    if os.sep not in exe:
        exe = binary(cli, reg) or exe
    if cli == "claude":
        cmd = [exe, "--output-format", "stream-json", "--verbose"]
        if not C.get().unrestricted_agents:
            cmd += ["--restricted", "--strict-mcp-config", "--permission-mode", "acceptEdits",
                    "--permission-prompts", "none"]
        if model:
            cmd += ["--model", model]
        if effort:
            cmd += ["--effort", effort]
        return cmd + ["-p", prompt]
    if cli == "codex":
        cmd = [exe, "exec"]
        if model:
            cmd += ["-m", model]
        if effort:
            cmd += ["-c", f"model_reasoning_effort={effort}"]
        policy = (["--dangerously-bypass-approvals-and-sandbox"] if C.get().unrestricted_agents
                  else ["--sandbox", "workspace-write", "-c", 'approval_policy="never"',
                        "-c", "sandbox_workspace_write.network_access=false", "--skip-git-repo-check"])
        return cmd + ["-C", str(cwd), *policy, prompt]
    if cli == "agy":
        cmd = [exe, "--dangerously-skip-permissions"]
        if model:
            cmd += ["--model", model]
        if effort:
            cmd += ["--effort", effort]
        return cmd + ["--add-dir", str(cwd), "--print", prompt]
    raise ValueError(f"no argv for cli {cli!r}")



@dataclass
class AgentResult:
    agent: str
    model: str | None
    effort: str | None
    exit: int | None
    text: str = ""
    shown: list = field(default_factory=list)
    seconds: float = 0.0
    timed_out: bool = False
    cancelled: bool = False

    @property
    def ok(self) -> bool:
        return self.exit == 0 and not self.timed_out and not self.cancelled

    def tail(self, n: int = 2) -> str:
        """Prefer the last error-bearing line over trailing stack frames; otherwise use the last n lines."""
        lines = [ln.strip() for ln in self.shown if ln.strip()]
        errs = [ln for ln in lines[-40:] if re.search(
            r"error|denied|unauthori[sz]ed|not found|no such|not supported|invalid",
            ln, re.IGNORECASE) and not ln.startswith("at ")]
        return errs[-1] if errs else " / ".join(lines[-n:])

    @property
    def rate_limited_until(self):
        return parse_rate_limit(self.text)


class AgentFailed(RuntimeError):
    def __init__(self, result: AgentResult):
        self.result = result
        why = "timed out" if result.timed_out else f"exited {result.exit}"
        tail = result.tail()
        who = f"{result.agent} ({result.model})" if result.model else result.agent    # which model it ran with, said
        super().__init__(f"{who} {why}" + (f": {tail}"[:240] if tail else ""))


class AgentLimited(AgentFailed):
    """Quota exhaustion and provider capacity are retryable, not broken wiring; queue a wait instead of failure."""
    def __init__(self, result: AgentResult, until=None, busy: bool = False):
        self.result, self.until = result, until
        self.quota_group = None
        with contextlib.suppress(ValueError):
            if not busy and spec(result.agent)["cli"] == "agy":
                self.quota_group = AG.family(result.model)
        when = f" until {until.astimezone().strftime('%H:%M')}" if until else ""
        what = "'s model is at capacity" if busy else " is out of usage"
        RuntimeError.__init__(self, f"{result.agent}{what}{when}: {result.tail()}"[:240])


# Provider capacity is transient: wait BUSY_WAIT and retry, not a quota failure.
BUSY = r"model is at capacity|overloaded_error"
BUSY_WAIT = 5 * 60


def failure(res: AgentResult, cli: str) -> AgentFailed:
    """Classify only this invocation's output; unrelated recent runs must not turn a bad invocation into a quota wait."""
    until = res.rate_limited_until
    # Inspect only this run's tail; routine structured limit reports are not evidence of rejection.
    said = "\n".join(ln for ln in [*res.text.splitlines()[-TAIL:], *res.shown[-TAIL:]] if "rate_limit_event" not in ln)
    if until or re.search(r"usage limit|out of credits|insufficient (credits|quota)|"
                          r"rate.?limit", said, re.IGNORECASE):
        return AgentLimited(res, until)
    if re.search(BUSY, said, re.IGNORECASE):
        return AgentLimited(res, datetime.now().astimezone() + timedelta(seconds=BUSY_WAIT), busy=True)
    return AgentFailed(res)


def _readable(cli: str, line: str) -> str | None:
    """Extract text/tool calls from structured output; skip bookkeeping and retain plain output."""
    if cli != "claude":
        return line
    try:
        ev = json.loads(line)
    except json.JSONDecodeError:
        return line
    t = ev.get("type")
    if t == "assistant":
        out = []
        for b in ev.get("message", {}).get("content", []):
            if b.get("type") == "text":
                out.append(b["text"])
            elif b.get("type") == "tool_use":
                inp = b.get("input", {})
                tool = b.get("name", "?")
                desc = (inp.get("command", "")[:80] if tool == "Bash"
                        else inp.get("file_path", "")[-50:] if tool in ("Edit", "Write", "Read")
                        else str(inp)[:60])
                out.append(f"[tool: {tool}] {desc}")
        return "\n".join(out) or None
    if t == "result" and ev.get("is_error"):
        return f"error: {ev.get('result') or ev.get('subtype')}"
    return None


# Poll job cancellation and stop the entire process group so descendants cannot keep working.
CANCEL_POLL = 10.0


DRAIN_S = 10                      # seconds to read what an agent left in its pipe once it has stopped


class AgentCancelled(Exception):
    """The user cancelled the job while its agent ran; the agent was stopped."""


ONE_ARG = 128 * 1024                           # MAX_ARG_STRLEN, with its NUL


def run(name: str, prompt: str, cwd: Path, logfile: Path, *, model=..., effort=...,
        prefix: list[str] = (), deadline: float | None = None,
        reg: dict | None = None) -> AgentResult:
    """Stream one invocation; return nonzero exits for run_job to classify, but raise startup failures.
    Apply saved defaults and optional command wrappers here."""
    reg = reg or load()
    c = choice(name, reg=reg)
    model = c["model"] if model is ... else model
    effort = c["effort"] if effort is ... else effort
    cli = spec(name, reg)["cli"]
    # The brief is one Linux argument, capped at 128 KiB including NUL; explain oversize before spawning.
    size = len(prompt.encode())
    if size >= ONE_ARG:
        raise OSError(errno.E2BIG, f"the brief is {size // 1024} KiB and one argument holds {ONE_ARG // 1024} KiB — "
                                   f"put the long part in a file the brief points at")
    cmd = list(prefix) + argv(name, prompt, cwd, model=model, effort=effort, reg=reg)
    res = AgentResult(agent=name, model=model, effort=effort, exit=None)
    full = []
    t0 = time.time()
    # The argv exactly as run, with the prompt replaced by its size: the prompt is in
    # the brief, and a 40 KB string in every trace line would bury the rest.
    T.emit("agents", "agent.start", agent=name, model=model, effort=effort,
           cwd=str(cwd), log=str(logfile), prompt_chars=len(prompt),
           argv=[f"<prompt: {len(prompt)} chars>" if a == prompt else a for a in cmd])
    Path(logfile).parent.mkdir(parents=True, exist_ok=True)
    # Line buffering keeps the live console from withholding output until a large buffer fills.
    with open(logfile, "a", buffering=1) as log:
        log.write(f"\n{'=' * 60}\nTimestamp: {datetime.now().isoformat()}\n"
                  f"agent: {name}  model: {model or 'CLI default'}  "
                  f"effort: {effort or 'CLI default'}\n\n")

        def take(line):
            line = line.strip()
            if not line:
                return
            full.append(line)
            shown = _readable(cli, line)
            if shown:
                res.shown.extend(shown.splitlines())
                log.write(shown + "\n")
                print(f"  {shown}", flush=True)
        # Use the tracked process-group path so pause/deadline stops descendants; bound final pipe draining.
        try:
            done = P.run(cmd, cwd=cwd, env=agent_env(), deadline=deadline, on_line=take, poll=CANCEL_POLL,
                         drain=DRAIN_S)
            if P.job_stop():                # paused or cancelled after the last poll: the work isn't this job's now
                res.cancelled = True
                log.write("\n[cancelled or paused in the picker as the agent finished — its work is dropped]\n")
        except W.Stopped as e:
            res.cancelled, done = True, e.done
            log.write("\n[cancelled or paused in the picker — agent stopped]\n")
        except P.TimedOut as e:
            res.timed_out, done = True, e.done
            log.write("\n[the job's time ran out — agent stopped]\n")
    res.exit = done.exit
    res.text = "\n".join(full)
    res.seconds = time.time() - t0
    T.emit("agents", "agent.end", agent=name, model=model, exit=res.exit,
           seconds=round(res.seconds, 1), timed_out=res.timed_out, lines=len(full),
           **({"tail": res.tail()} if not res.ok else {}))
    return res


def limited_until(agent: str, now: float | None = None, *, model=None, root=None) -> float | None:
    """Reuse known agent wait deadlines instead of spending another invocation rediscovering the same limit."""
    from . import queue as Q
    now = now or time.time()
    is_agy = False
    with contextlib.suppress(ValueError):
        is_agy = spec(agent)["cli"] == "agy"
    group = AG.family(model or choice(agent).get("model")) if is_agy else None
    later = [w["until"] for j in Q.jobs(root=root) if j["status"] == "waiting"
             for w in [j.get("waiting") or {}] if w.get("agent") == agent and (w.get("until") or 0) > now
             and not (w.get("why") or "").startswith(("session cap: ", "agent restricted: "))
             and (not is_agy or not (w.get("quota_group") or AG.family(j.get("model")))
                  or (w.get("quota_group") or AG.family(j.get("model"))) == group)]
    return max(later) if later else None


def run_job(name: str, prompt: str, cwd: Path, logfile: Path, *, prefix: list[str] = (),
            deadline: float | None = None, reg: dict | None = None, model: str | None = None) -> AgentResult:
    """Raise AgentLimited for quota/capacity so the queue waits without blocking the runner; other failures raise AgentFailed.
    Per-job models override saved choices, with effort checked against cached discovery."""
    reg = reg or load()
    s = spec(name, reg)
    c = dict(choice(name, reg=reg))
    if model and model != c["model"]:
        c["model"] = model
        if c["effort"]:
            m = {x["id"]: x for x in cached_catalogue(name, reg=reg).get("models", [])}.get(model) or {}
            if m.get("efforts") is not None and c["effort"] not in m["efforts"]:
                c["effort"] = None             # the CLI's own default for that model
    back = limited_until(name, model=c["model"])
    if back:
        raise AgentLimited(AgentResult(agent=name, model=c["model"], effort=None, exit=None,
                                       text="another job found it out"),
                           until=datetime.fromtimestamp(back).astimezone())
    rec = _receipt(name, s, prompt, cwd, c["model"], c["effort"], prefix, reg)
    res = run(name, prompt, cwd, logfile, model=c["model"], effort=c["effort"], prefix=prefix, deadline=deadline,
              reg=reg)
    _receipt_end(rec, res)
    if res.ok:
        return res
    if res.cancelled:
        raise AgentCancelled(f"{name} stopped: the job was cancelled in the picker")
    raise failure(res, s["cli"])


def _receipt(name: str, s: dict, prompt: str, cwd: Path, model, effort, prefix, reg) -> dict | None:
    """The invocation's receipt (core/receipts.py), before it runs: the argv as run, the prompt and every file
    supplied, kept by hash. A receipt that can't be written is traced and the job goes on: it never fails one."""
    from . import instructions as I
    from . import queue as Q
    from . import receipts as R
    try:
        job, type_ = T.token("job"), T.token("type")
        h = R.keep(prompt)
        cmd = [f"<prompt sha256:{h[:12]}>" if a == prompt else a
               for a in list(prefix) + argv(name, prompt, cwd, model=model, effort=effort, reg=reg)]
        files = I.instruction_files(s["cli"], Path(cwd))["files"] + I.referenced(prompt, Path(cwd))
        manifest = next((m for m in C.get().types if _manifest_type(m) == type_), None) if type_ else None
        attempt = (Q.get(job) or {}).get("attempts") if job else None
        return R.start(job=job, attempt=attempt, type_=type_, agent=name, cli=s["cli"], model=model, effort=effort,
                       argv=cmd, cwd=Path(cwd), prompt=prompt, files=files, manifest=manifest)
    except Exception as e:                       # noqa: BLE001  a receipt must never fail the job
        with contextlib.suppress(Exception):     # nor its report (trace.emit never raises; this says so here too)
            T.emit("agents", "receipt.failed", agent=name, error=f"{type(e).__name__}: {e}"[:200])
        return None


def _receipt_end(rec: dict | None, res) -> None:
    if rec is None:
        return
    from . import receipts as R
    try:
        R.finish(rec, ok=res.ok, exit_code=getattr(res, "exit", None),
                 why=None if res.ok else ("cancelled" if res.cancelled else res.tail()))
    except Exception as e:                       # noqa: BLE001
        with contextlib.suppress(Exception):
            T.emit("agents", "receipt.failed", error=f"{type(e).__name__}: {e}"[:200])


def _manifest_type(path: Path) -> str | None:
    try:
        return json.loads(Path(path).read_text()).get("type")
    except (OSError, ValueError):
        return None


def ping(name: str, cwd: Path, logfile: Path, *, prefix: list[str] = (),
         reg: dict | None = None, probe: Path | None = None) -> AgentResult:
    """Probe in the real cwd/wrapper; an optional file write proves write access too.
    Limits raise AgentLimited, invocation failures AgentFailed, invalid replies/missing writes RuntimeError."""
    rel = os.path.relpath(probe, cwd) if probe else None
    if probe:
        Path(probe).parent.mkdir(parents=True, exist_ok=True)
        Path(probe).unlink(missing_ok=True)
    res = run(name, PING_WRITE.format(path=rel) if probe else PING, cwd, logfile,
              prefix=prefix, deadline=time.time() + 300, reg=reg)
    if not res.ok:
        raise failure(res, spec(name, reg)["cli"])
    if not re.search(r"\bREADY\b", res.text):
        raise RuntimeError(f"{name} answered, but not READY: {res.tail()}"[:240])
    if probe:
        wrote = Path(probe).is_file() and "READY" in Path(probe).read_text(errors="replace")
        Path(probe).unlink(missing_ok=True)
        if not wrote:
            raise RuntimeError(f"{name} answered READY but did not write {rel} in {cwd} "
                               f"— it cannot write where its work goes (permission mode?)")
    return res



# How each CLI is logged in again, for the fix line.
LOGIN = {"claude": "run `claude` in a terminal and /login",
         "codex": "run `codex login` in a terminal",
         "agy": "run `agy` in a terminal and sign in"}

_WARN = re.compile(r"^warn · (?P<scope>\w+) · (?P<name>.+?) — (?P<detail>.*?)"
                   r"(?: \| fix: (?P<fix>.*))?$")


def parse_warn(stage: str) -> dict | None:
    m = _WARN.match(stage or "")
    return m.groupdict() if m else None


def explain(why: str, stages: list[str] = (), agent: str | None = None) -> dict:
    """Map failure to short/detail/fix; preserve unmatched CLI output rather than guessing."""
    why = why or ""
    cls, _, msg = why.partition(": ")
    msg = msg or why
    cli = None
    try:
        cli = spec(agent)["cli"] if agent else None
    except ValueError:
        pass
    last = (list(stages) or [""])[-1]
    low = msg.lower()

    def out(short, detail, fix):
        return {"short": short, "detail": detail[:300], "fix": fix}

    if re.search(BUSY, low):                  # before the usage words: "is at capacity until 13:26" isn't out of usage
        m = re.search(r"until (\d\d:\d\d)", msg)
        return out("model busy" + (f" · {m.group(1)}" if m else ""), msg.split(": ", 1)[-1],
                   "the provider was full for a while, not broken: "
                   + ("it tries again by itself" if m else "send it again") + " — or choose another model above")
    if cls != "AgentLimited" and re.search(r"usage limit|rate.?limit|out of credits", low):
        cls = "AgentLimited"
    if cls == "AgentLimited":
        m = re.search(r"until (\d\d:\d\d)", msg)
        tail = msg.split(": ", 1)[-1]
        return out(f"until {m.group(1)}" if m else "out of usage", tail,
                   (f"resets {m.group(1)} — " if m else "") +
                   "or choose another model or agent above")
    if msg.startswith("preflight · "):
        head, _, fix = msg[len("preflight · "):].partition(" | fix: ")
        name, _, detail = head.partition(" — ")
        return out(name, detail, fix or None)
    if msg.startswith("sync failed"):
        return out("sync failed", msg,
                   "run the type's sync by hand, from its runner's folder: PYTHONPATH=<the picker> python3 sync.py")
    if msg.startswith("render failed") or "no candidate with a shader" in msg \
            or "no stack version with voices" in msg:
        return out("render failed", msg, "run the type's render tool by hand; its own "
                                         "words are in the detail")
    if "did not write" in msg:
        return out("can't write", msg, "its permission mode or sandbox blocks writing "
                                       "in its folder — see its settings")
    if "not READY" in msg:
        return out("odd answer", msg, "open the job's log (the cell) — the CLI said "
                                      "something else")
    if re.search(r"one argument holds|argument list too long", low):
        return out("brief too long", msg, "a brief is one argument, 128 KiB at most: the long part goes in a file "
                                          "the brief points at, as the survey's pool does")
    if cls == "FileNotFoundError" or "exited 127" in msg or "no such file or directory" in low:
        if last.startswith("asking") or cls == "FileNotFoundError" and "brief builds" in " ".join(stages):
            return out("CLI missing", msg, f"install {cli or 'the CLI'}, or put it in "
                                          f"~/.npm-global/bin or ~/.local/bin")
        return out("file missing", msg, "the detail names it")
    if re.search(r"not logged|unauthori[sz]ed|\b401\b|log ?in|authenticat|"
                 r"no longer supported", low):
        return out("not logged in", msg, LOGIN.get(cli, "log the CLI in again"))
    if re.search(r"model", low) and re.search(r"unknown|invalid|not (found|available|"
                                              r"supported)|does not exist", low):
        return out("model refused", msg, "choose another model above")
    if "timed out" in low:
        return out("timed out", msg, "the CLI ran 5 min without answering — run it by "
                                     "hand to see where it hangs")
    if cls == "NothingMade" or "no card came out" in low:
        return out("nothing made", msg, "the run ended without a card — open its log (the cell)")
    # Only when the trail is known: an empty `stages` is "no record", not "no brief".
    if stages and not any(t.startswith("brief builds") for t in stages) \
            and cls not in ("AgentFailed",) and not re.search(r"exited \d+", msg):
        return out("brief broken", msg, "the type's queue_runner.brief() raised — the "
                                        "detail says where")
    return out("failed", msg, None)



TAIL = 40                                      # where a run says it hit a limit: its last lines


def _limit_events(output: str):
    """Only rejected structured events mean exhaustion; allowed and warning events also occur on successful runs."""
    for line in output.splitlines():
        if "rate_limit_event" not in line:
            continue
        try:
            o = json.loads(line)
            info = o.get("rate_limit_info") or o
            yield str(info.get("status") or ""), info.get("resetsAt")
        except (ValueError, AttributeError):
            st, at = re.search(r'"status"\s*:\s*"(\w+)"', line), re.search(r'"resetsAt"\s*:\s*(\d+)', line)
            yield (st.group(1) if st else ""), (int(at.group(1)) if at else None)


def parse_rate_limit(output: str):
    """Prefer rejected structured events with epoch resets; otherwise parse only the output tail.
    An earlier quoted limit message in tool output must not suspend a job."""
    rejected = [at for st, at in _limit_events(output) if st == "rejected" and at]
    if rejected:
        return datetime.fromtimestamp(int(rejected[-1]), tz=ZoneInfo("UTC"))
    output = "\n".join(output.splitlines()[-TAIL:])
    # Parse explicit local dates before bare times or a distant reset becomes repeated short retries.
    m = re.search(r"hit your\s+(?:\w+\s+)?limit.*?try again at\s+([A-Za-z]{3})[a-z]*\.?\s+"
                  r"(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4}),?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)",
                  output, re.IGNORECASE)
    if m:
        try:
            return datetime.strptime(f"{m.group(1).title()} {m.group(2)} {m.group(3)} {m.group(4)}:"
                                     f"{m.group(5) or '00'} {m.group(6).upper()}",
                                     "%b %d %Y %I:%M %p").astimezone()
        except ValueError:
            pass
    m = re.search(r"hit your\s+(?:\w+\s+)?limit.*resets?\s+"
                  r"(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*\(([^)]+)\)", output, re.IGNORECASE)
    if not m:
        # Bare reset times are local, not UTC.
        m = re.search(r"hit your\s+(?:\w+\s+)?limit.*?try again at\s+"
                      r"(\d{1,2})(?::(\d{2}))?\s*(am|pm)()", output, re.IGNORECASE)
    if not m:
        return None
    hour, minute = int(m.group(1)), int(m.group(2) or 0)
    ampm = m.group(3).lower()
    if ampm == "pm" and hour != 12:
        hour += 12
    elif ampm == "am" and hour == 12:
        hour = 0
    try:
        tz = ZoneInfo(m.group(4)) if m.group(4) else None
    except Exception:
        tz = None
    now = datetime.now(tz).astimezone() if tz is None else datetime.now(tz)
    reset = now.replace(hour=hour, minute=minute, second=0, microsecond=0)
    if reset <= now:
        reset += timedelta(days=1)
    return reset


if __name__ == "__main__":
    for n in names():
        print(n, choice(n), file=sys.stderr)
