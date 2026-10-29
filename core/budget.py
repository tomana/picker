"""Admit new work from one server-owned usage cache; never interrupt work already admitted."""
import contextlib
import json
import math
import os
import threading
import time
import urllib.parse
import urllib.request
from datetime import datetime

from . import agents as A
from . import prefs as P
from . import queue as Q
from . import agy as AG

CAPS = (100, 90, 80, 70, 60, 50)
PREFIX = "session cap: "
RESTRICTED = "agent restricted: "
MIN_S, MAX_S = 30.0, 600.0
_reader = None
_samples = {}
_lock = threading.RLock()


def configure(reader):
    global _reader
    _reader = reader


def agent_of(job, manifest=None):
    if job.get("backend"):
        return job["backend"]
    if job.get("researcher") and ":" in job["researcher"]:
        return job["researcher"].split(":", 1)[1].split("@", 1)[0]
    if manifest is None:
        from . import config as C
        manifest = C.manifest(job.get("type"))
    argv = manifest.get("start") or []
    return (argv[argv.index("--agent") + 1] if "--agent" in argv[:-1]
            else next(iter(manifest.get("agents") or []), "claude"))


def cap(name, prefs=None):
    try:
        return A.choice(name, prefs=prefs)["session_cap"]
    except ValueError:
        return 100


def interval(rate):
    return min(MAX_S, max(MIN_S, 1 / rate)) if rate > 0 else MAX_S


def _unknown(name, limit, now, error="usage reader unavailable"):
    return {"allowed": False, "cap": limit, "used_pct": None, "until": now + MIN_S,
            "why": PREFIX + f"{name} session usage unknown, cap {limit}% - {error}"}


def _decision(name, limit, sample, model, now):
    source = sample.get("source") or {}
    cli = A.spec(name)["cli"]
    if cli == "agy":
        window = AG.window(source, model or A.choice(name).get("model"))
        key = window.get("key")
    else:
        key = "session"
        window = next((w for w in source.get("windows") or [] if w.get("key") == key), {})
    used = window.get("used_pct")
    if (not source.get("available") or source.get("stale") or source.get("error")
            or isinstance(used, bool) or not isinstance(used, (int, float)) or not math.isfinite(used)):
        d = _unknown(name, limit, now, source.get("error") or "no fresh session reading")
        d["until"] = sample.get("next", now + MIN_S)
        d["window"] = key
        return d
    blocked = used >= limit
    return {"allowed": not blocked, "cap": limit, "used_pct": used, "window": key,
            "until": sample.get("next", now + MIN_S),
            "why": PREFIX + f"{name} at {used:g}% of its session, cap {limit}%" if blocked else ""}


def check(name, *, model=None, now=None, prefs=None, permissions=True, root=None):
    now = time.time() if now is None else now
    try:
        if permissions:
            mode = A.execution(name)
            if not mode["allowed"]:
                return {"allowed": False, "until": now + MAX_S, "why": RESTRICTED + mode["reason"]}
        limit = cap(name, prefs)
    except ValueError:
        limit = 100
    with contextlib.suppress(ValueError):
        model = model or A.choice(name, prefs=prefs).get("model")
    if limit == 100:
        return {"allowed": True, "cap": 100, "why": ""}
    if _reader is None:
        url = os.environ.get("PICKER_URL")
        if not url:
            return _unknown(name, limit, now, "PICKER_URL is not set")
        query = urllib.parse.urlencode({"model": model or "", "permissions": int(permissions)})
        try:
            with urllib.request.urlopen(url.rstrip("/") + f"/api/agents/{urllib.parse.quote(name)}/budget?{query}", timeout=30) as r:
                return json.load(r)
        except (OSError, ValueError) as e:
            return _unknown(name, limit, now, str(e)[:120])
    with _lock:
        sample = _samples.get(name) or {}
        if now >= sample.get("next", 0):
            try:
                source = _reader(name)
            except Exception as e:
                source = {"available": False, "error": str(e)[:120], "windows": []}
            rates = {}
            previous = {w.get("key"): w for w in (sample.get("source") or {}).get("windows") or []}
            for w in source.get("windows") or []:
                old, value = previous.get(w.get("key"), {}), w.get("used_pct")
                if (isinstance(value, (int, float)) and isinstance(old.get("used_pct"), (int, float))
                        and w.get("resets_at") == old.get("resets_at") and now > sample.get("at", now)):
                    rate = max(0.0, value - old["used_pct"]) / (now - sample["at"])
                    rates[w["key"]] = max(rate, (sample.get("rates") or {}).get(w["key"], 0) / 2)
            delay = interval(max(rates.values(), default=1 / 60))
            if source.get("error") or not source.get("available"):
                delay = MIN_S
            next_at = now + delay
            for w in source.get("windows") or []:
                try:
                    reset = datetime.fromisoformat(str(w.get("resets_at") or "").replace("Z", "+00:00")).timestamp()
                    if reset > now:
                        next_at = min(next_at, reset)
                except (KeyError, TypeError, ValueError):
                    pass
            sample = _samples[name] = {"at": now, "next": next_at, "source": source, "rates": rates}
        return _decision(name, limit, sample, model, now)


def park(job, decision, *, root=None):
    if decision["allowed"]:
        return False
    waiting = job.get("waiting") or {}
    if waiting.get("why") != decision["why"] or waiting.get("until", 0) <= time.time():
        Q.defer(job["id"], agent=agent_of(job), until=decision["until"], why=decision["why"], root=root,
                quota_group=decision.get("quota_group"))
    return True


def release(name, *, root=None):
    """Only admission holds are ours to release; real provider limits keep their deadlines."""
    for j in Q.jobs(root=root):
        if (j["status"] == "waiting" and agent_of(j) == name
                and (j.get("waiting") or {}).get("why", "").startswith((PREFIX, RESTRICTED))):
            Q.requeue(j["id"], root=root, waiting_for=j["waiting"]["why"])


def poll(*, root=None):
    jobs = [j for j in Q.jobs(root=root) if j["status"] in ("queued", "running", "waiting")]
    prefs = P.fold(root)
    for name in {agent_of(j) for j in jobs}:
        if cap(name, prefs) == 100:
            # Turning a cap off must not leave its old wait blocking unrelated work.
            if any((j.get("waiting") or {}).get("why", "").startswith(PREFIX) for j in jobs if agent_of(j) == name):
                release(name, root=root)
            continue
        for j in (j for j in jobs if agent_of(j) == name):
            d = check(name, model=j.get("model"), prefs=prefs, root=root)
            if j["status"] == "waiting" and (j.get("waiting") or {}).get("why", "").startswith((PREFIX, RESTRICTED)):
                if d["allowed"]:
                    Q.requeue(j["id"], root=root, waiting_for=j["waiting"]["why"])


def delay():
    now = time.time()
    with _lock:
        return max(1.0, min([60.0, *[s["next"] - now for s in _samples.values() if s["next"] > now]]))


def bar_source(cli):
    """Capped idle agents display their last snapshot, never trigger display-only polling."""
    names = [n for n in A.names() if A.spec(n)["cli"] == cli and cap(n) < 100]
    if not names:
        return None
    with _lock:
        sample = _samples.get(names[0]) or {}
        d = _decision(names[0], cap(names[0]), sample, None, time.time())
        source = dict(sample.get("source") or {"available": False, "stale": True, "windows": []})
        if sample:
            source["age_seconds"] = int(max(0, time.time() - sample["at"]))
            source["stale"] = bool(source.get("stale") or time.time() >= sample["next"])
        if not d["allowed"]:
            source["cap_note"] = d["why"]
            source["session_cap"] = cap(names[0])
            source["cap_window"] = d.get("window")
        return source
