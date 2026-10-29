"""Lock every transition and claim; outcomes apply only to their live attempt.
Pause/cancel survives late outcomes, and a new attempt waits until its predecessor ends."""
import contextlib
import fcntl
import json
import os
import threading
import time
import uuid
from pathlib import Path

from . import config as C

# Keep queue files beside stores, not among card directories where readers would mistake them for cards.
ROOT = C.get().research
DATA = C.get().data                               # the queue, the logs (the config's `data`)
QUEUE = DATA / "queue.jsonl"
# Request images have one home beside the queue; both queue rows and resulting cards read them there.
QUEUE_MEDIA = DATA / "queue_media"

# Kinds are a closed work vocabulary; seed has no parent, survey makes an order rather than a card.
KINDS = {"inspire", "revise", "seed", "ping", "survey"}

# Pings make nothing and take priority so wiring checks cannot wait behind long renders.

LIVE = ("queued", "running", "waiting")

# Version freezes the displayed base; recording identifies source material and trim selects seconds within it.
_FIELDS = ("id", "created", "type", "kind", "card", "text", "backend", "group",
           "attachments", "version", "item", "source", "recording", "trim", "count", "method", "model", "keep")


def _path(root: Path | None = None) -> Path:
    return (Path(root) / "queue.jsonl") if root else QUEUE


_held = threading.local()


@contextlib.contextmanager
def _locked(root: Path | None = None):
    """One cross-process lock covers writes and claims; thread reentrancy keeps fold-and-append atomic."""
    if getattr(_held, "depth", 0):
        _held.depth += 1
        try:
            yield
        finally:
            _held.depth -= 1
        return
    p = _path(root)
    p.parent.mkdir(parents=True, exist_ok=True)
    with open(p.with_suffix(".lock"), "w") as lf:
        fcntl.flock(lf, fcntl.LOCK_EX)
        _held.depth = 1
        try:
            yield
        finally:
            _held.depth = 0


# What a crash may not lose: these are on the disk before the append returns. A phase or a usage sample is not.
_FSYNC = {"enqueue", "claim", "made", "done", "failed", "stopped", "wait", "defer", "cancel", "pause", "resume", "requeue",
          "orphan", "dismiss"}


def _append(rec: dict, root: Path | None = None) -> None:
    """Timestamp every event and close torn final lines first so they cannot swallow a new record."""
    rec = {**rec, "ts": time.time()}
    p = _path(root)
    with _locked(root):
        torn = False
        try:
            with open(p, "rb") as r:
                r.seek(-1, os.SEEK_END)
                torn = r.read(1) != b"\n"
        except OSError:                    # no log yet, or an empty one
            pass
        with open(p, "a") as f:
            f.write(("\n" if torn else "") + json.dumps(rec, ensure_ascii=False) + "\n")
            f.flush()
            if rec.get("event") in _FSYNC:
                os.fsync(f.fileno())


def media_dir(job_id: str, root: Path | None = None) -> Path:
    """Where a job's images live. Relative to `root` in tests, like the log."""
    return (Path(root) / "queue_media" if root else QUEUE_MEDIA) / job_id


def enqueue(*, type: str, kind: str, card: str | None = None, text: str = "",
            backend: str | None = None, group: str | None = None,
            attachments: list[tuple[bytes, str]] | None = None,
            version: int | None = None, item: str | None = None, source: dict | None = None,
            recording: str | None = None,
            trim: dict | None = None, count: int | None = None,
            method: str | None = None, model: str | None = None, keep: bool = False,
            root: Path | None = None) -> dict:
    """Persist validated attachment bytes before enqueue; log names, never bytes.
    No reader may see a job whose images have not been written."""
    if kind not in KINDS:
        raise ValueError(f"kind must be one of {sorted(KINDS)}")
    jid = uuid.uuid4().hex[:12]
    names = []
    if attachments:
        d = media_dir(jid, root)
        d.mkdir(parents=True, exist_ok=True)
        for i, (blob, ext) in enumerate(attachments, start=1):
            name = f"att_{i}.{ext}"
            with open(d / name, "xb") as f:     # a fresh job id: nothing to overwrite
                f.write(blob)
            names.append(name)
    job = {"id": jid, "created": time.time(), "type": type,
           "kind": kind, "card": card, "text": text, "backend": backend,
           "group": group, "attachments": names,
           **({"version": int(version)} if version else {}),
           # The displayed item determines what work hears or changes, not necessarily the version's face.
           **({"item": item} if item else {}),
           # Freeze the plugin source at send time so later cuts or versions do not alter queued work.
           **({"source": source} if source else {}),
           **({"recording": recording} if recording else {}),
           **({"trim": trim} if trim else {}),
           # Count results within one shared session.
           **({"count": int(count)} if count and int(count) > 1 else {}),
           # Method selects a manifest-declared work path; absence uses the type's default agent path.
           **({"method": str(method)} if method else {}),
           # A missing model uses the saved choice for this backend.
           **({"model": str(model)} if model else {}),
           # Freeze keep on the enqueue event so a crash cannot separate work from its admission policy.
           **({"keep": True} if keep else {})}
    _append({"event": "enqueue", **job}, root)
    return {**job, "status": "queued", "phase": None, "result": None}


def fold(root: Path | None = None) -> dict:
    """Ignore unknown/malformed events; new writer verbs must not break existing readers."""
    jobs: dict[str, dict] = {}
    p = _path(root)
    if not p.is_file():
        return jobs
    for line in p.read_text().splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            rec = json.loads(line)
        except Exception:
            continue
        jid, ev = rec.get("id"), rec.get("event")
        if not jid:
            continue
        if ev == "enqueue":
            jobs[jid] = {k: rec.get(k) for k in _FIELDS}
            jobs[jid].update(status="queued", phase=None, result=None,
                             researcher=None, why=None, started=None, ended=None,
                             dismissed=False,
                             attempts=0, live=None, stopping=None, refs=None, first_claim=None,
                             waiting=None)
        elif jid not in jobs:
            continue                       # an event for a job we never saw enqueued
        elif ev == "claim":
            j = jobs[jid]
            j["status"] = "running"
            j["attempts"] = j["live"] = rec.get("attempt")
            j["started"] = rec.get("ts")
            j["first_claim"] = j["first_claim"] or rec.get("ts")
            j["waiting"] = None
            j["researcher"] = rec.get("researcher")
        elif ev in ("made", "done", "failed", "wait", "stopped"):
            # Only the live attempt's outcome can affect its state.
            j = jobs[jid]
            if rec.get("attempt") != j["live"]:
                continue
            if ev == "made":
                j["refs"] = rec.get("refs")
                continue
            j["live"] = None
            if ev == "done":
                if j["status"] != "cancelled":
                    j.update(status="done", ended=rec.get("ts"))
                    for k in ("result", "why", "made"):
                        if rec.get(k) is not None:
                            j[k] = rec[k]
            elif ev == "failed":
                if j["status"] == "running":
                    j.update(status="failed", ended=rec.get("ts"), why=rec.get("why"))
            elif ev == "wait":
                if j["status"] == "running":
                    j["status"] = "waiting"
                    j["waiting"] = {"agent": rec.get("agent"), "until": rec.get("until"),
                                    "why": rec.get("why"), "since": rec.get("ts"),
                                    **({"quota_group": rec["quota_group"]} if rec.get("quota_group") else {})}
                    j["phase"] = None
        elif ev == "cancel":
            j = jobs[jid]
            j.update(status="cancelled", ended=rec.get("ts"), stopping=j["live"])
        elif ev == "phase":
            jobs[jid]["phase"] = rec.get("text")
        elif ev == "requeue":
            j = jobs[jid]
            if j["status"] in ("waiting", "failed", "cancelled"):
                j["status"] = "queued"
                j["waiting"] = None
                j["why"] = None
                # Clear prior-attempt phase text before another attempt starts.
                j["phase"] = None
                j["dismissed"] = False
                if rec.get("backend"):
                    if rec["backend"] != j.get("backend"):
                        j.pop("model", None)    # Changing agent also resets the model override to that agent's saved choice.
                    j["backend"] = rec["backend"]
                if "model" in rec:              # a model named with it; null is the agent's own
                    if rec["model"]:
                        j["model"] = rec["model"]
                    else:
                        j.pop("model", None)
        elif ev == "orphan":
            # End only the named live attempt; only a running orphan returns to queued.
            # A retry receives the abandoned attempt's context.
            j = jobs[jid]
            if rec.get("attempt") is not None and rec["attempt"] != j["live"]:
                continue
            j["live"] = None
            if j["status"] == "running":
                j["status"] = "queued"
                j["phase"] = None
        elif ev == "pause":
            j = jobs[jid]
            if j["status"] in ("queued", "waiting", "running"):
                j["paused_from"] = j["status"]
                j["status"] = "paused"
                j["phase"] = None
                # A resume cannot undo a stop already requested for this attempt.
                j["stopping"] = j["live"]
        elif ev == "resume":
            j = jobs[jid]
            if j["status"] == "paused":
                j["status"] = "queued"
                j["waiting"] = None
                j.pop("paused_from", None)
                if rec.get("backend"):
                    if rec["backend"] != j.get("backend"):
                        j.pop("model", None)
                    j["backend"] = rec["backend"]
                if "model" in rec:
                    if rec["model"]:
                        j["model"] = rec["model"]
                    else:
                        j.pop("model", None)
                    j["why"] = None
        elif ev == "defer":
            j = jobs[jid]
            if j["live"] is None and j["status"] in ("queued", "waiting"):
                j.update(status="waiting", phase=rec.get("why"),
                         waiting={"agent": rec.get("agent"), "until": rec.get("until"),
                                  "why": rec.get("why"), "since": rec.get("ts"),
                                  **({"quota_group": rec["quota_group"]} if rec.get("quota_group") else {})})
        elif ev == "dismiss":
            jobs[jid]["dismissed"] = True
        elif ev == "edit":
            # Only drafts accept edits; claimed text must remain the text actually run.
            if jobs[jid]["status"] == "queued":
                jobs[jid]["text"] = rec.get("text", "")
        elif ev == "attach":
            # images added to a draft (older logs): like `edit`, only before the claim
            if jobs[jid]["status"] == "queued":
                jobs[jid]["attachments"] = (list(jobs[jid].get("attachments") or [])
                                            + list(rec.get("names") or []))
    return jobs


def is_open(j: dict) -> bool:
    """Paused and failed jobs remain open until explicitly retried, dismissed or cancelled."""
    if j["status"] in LIVE or j["status"] == "paused":
        return True
    return j["status"] == "failed" and not j.get("dismissed") and j.get("kind") != "ping"


# Only types declaring by-agent lanes get parallel runners; shared build/GPU types keep one lane.
CODEX_LANE = "codex"
# Non-default model agents get separate lanes; unspecified and tool-only backends stay in the default lane.
AGENT_LANES = (CODEX_LANE, "antigravity")


def lane_for(job: dict) -> str | None:
    if job.get("backend") in AGENT_LANES and C.manifest(job.get("type")).get("lanes") == "by_agent":
        return job["backend"]
    return None


def _agent_lane(lane: str | None) -> str | None:
    """The agent lane a runner or job belongs to; None is the default lane."""
    return lane if lane in AGENT_LANES else None


def due(j: dict, now: float | None = None) -> bool:
    w = j.get("waiting") or {}
    return j["status"] == "waiting" and (w.get("until") or 0) <= (now or time.time())


def wait(job_id: str, *, agent: str, until: float, why: str = "", attempt: int, root: Path | None = None,
         quota_group: str | None = None) -> None:
    _append({"event": "wait", "id": job_id, "agent": agent, "until": until, "why": why[:400], "attempt": attempt,
             **({"quota_group": quota_group} if quota_group else {})}, root)


def _if(job_id: str, ok, rec: dict, root: Path | None) -> bool:
    """Check transition eligibility and append under one lock; return whether it was written."""
    with _locked(root):
        j = fold(root).get(job_id)
        if not j or not ok(j):
            return False
        _append(rec, root)
        return True


KEEP = object()          # a resume or retry that names no model keeps the job's


def _model_of(model) -> dict:
    return {} if model is KEEP else {"model": model}


def requeue(job_id: str, *, backend: str | None = None, model=KEEP,
            root: Path | None = None, waiting_for: str | None = None) -> bool:
    # Automatic releases must not resurrect a job cancelled after the caller read it.
    return _if(job_id, lambda j: (j["status"] == "waiting" and (j.get("waiting") or {}).get("why") == waiting_for)
               if waiting_for is not None else j["status"] in ("waiting", "failed", "cancelled"),
               {"event": "requeue", "id": job_id, **({"backend": backend} if backend else {}), **_model_of(model)}, root)


def defer(job_id: str, *, agent: str, until: float, why: str, root: Path | None = None,
          quota_group: str | None = None) -> bool:
    """Hold unclaimed work without inventing an attempt or crossing a running job."""
    return _if(job_id, lambda j: j["live"] is None and j["status"] in ("queued", "waiting"),
               {"event": "defer", "id": job_id, "agent": agent, "until": until, "why": why[:400],
                **({"quota_group": quota_group} if quota_group else {})}, root)


def jobs(*, type: str | None = None, live_only: bool = False, open_only: bool = False,
         root: Path | None = None) -> list[dict]:
    out = [j for j in fold(root).values()
           if (type is None or j["type"] == type)
           and (not live_only or j["status"] in LIVE)
           and (not open_only or is_open(j))]
    return sorted(out, key=lambda j: j["created"] or 0)


def orphan(job_id: str, *, attempt: int, root: Path | None = None) -> bool:
    """End only the named live attempt and requeue only if running.
    The caller proves death and holds the lane lock."""
    return _if(job_id, lambda j: j["live"] == attempt, {"event": "orphan", "id": job_id, "attempt": attempt}, root)


def dismiss(job_id: str, *, root: Path | None = None) -> bool:
    return _if(job_id, lambda j: j["status"] == "failed", {"event": "dismiss", "id": job_id}, root)


# The statuses that mean "stop working on this".
STOPPED = ("cancelled", "paused")


def stop_asked(job_id: str, attempt: int | None = None, *, root: Path | None = None) -> bool:
    """Whether the work on this attempt should stop: the job was cancelled, or paused or cancelled while this attempt
    ran (a resume after it doesn't undo that: resume is a new attempt). The poll of an agent and a tool (core/proc)."""
    j = fold(root).get(job_id)
    if not j:
        return False
    if j["status"] == "cancelled":
        return True
    return j["stopping"] is not None and j["stopping"] == (attempt if attempt is not None else j["live"])


def pause(job_id: str, *, root: Path | None = None) -> bool:
    return _if(job_id, lambda j: j["status"] in ("queued", "waiting", "running"), {"event": "pause", "id": job_id}, root)


def resume(job_id: str, *, backend: str | None = None, model=KEEP, root: Path | None = None) -> bool:
    """Requeue with an optional agent change; a new claim still waits for the current attempt to end."""
    return _if(job_id, lambda j: j["status"] == "paused",
               {"event": "resume", "id": job_id, **({"backend": backend} if backend else {}), **_model_of(model)}, root)


def get(job_id: str, *, root: Path | None = None) -> dict | None:
    return fold(root).get(job_id)


def history(job_id: str, *, root: Path | None = None) -> list[dict]:
    """Return all events, not just the fold's current phase."""
    out = []
    p = _path(root)
    if not p.is_file():
        return out
    for line in p.read_text().splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            rec = json.loads(line)
        except Exception:
            continue
        if rec.get("id") == job_id:
            out.append(rec)
    return out


def claim_next(researcher: str, *, types: list[str] | None = None,
               kinds=None, root: Path | None = None) -> dict | None:
    """Hold the lock across eligibility, fold and claim so workers cannot claim the same job."""
    from . import gate
    with _locked(root):
        # Read the gate under its close lock so closing cannot cross a claim; queued work keeps its place.
        if gate.closed(root):
            return None
        now = time.time()
        # an agent lane's jobs go to that lane's runner, and only those (AGENT_LANES above); a
        # lane runner signs its claims `type:agent@lane`
        mine = _agent_lane(researcher.rsplit("@", 1)[-1] if "@" in researcher else None)
        queued = [j for j in jobs(root=root)
                  if (j["status"] == "queued" or due(j, now))
                  and j["live"] is None                     # Do not claim until the prior attempt has ended.
                  and (types is None or j["type"] in types)
                  and (kinds is None or j["kind"] in kinds)
                  and _agent_lane(lane_for(j)) == mine]
        if not queued:
            return None
        # Pings first (seconds each), then work already begun; a job whose earlier
        # attempt ran out; then everything else, oldest first.
        job = (next((j for j in queued if j["kind"] == "ping"), None)
               or next((j for j in queued if j.get("attempts")), None)
               or queued[0])
        n = job["attempts"] + 1
        _append({"event": "claim", "id": job["id"], "researcher": researcher, "attempt": n}, root)
        return {**job, "status": "running", "researcher": researcher, "attempts": n, "attempt": n, "live": n}


def phase(job_id: str, text: str, *, root: Path | None = None) -> None:
    _append({"event": "phase", "id": job_id, "text": text}, root)


def edit(job_id: str, text: str, *, root: Path | None = None) -> None:
    _append({"event": "edit", "id": job_id, "text": text}, root)


def cancel(job_id: str, *, root: Path | None = None) -> bool:
    return _if(job_id, lambda j: j["status"] in (*LIVE, "paused"), {"event": "cancel", "id": job_id}, root)


def made(job_id: str, refs: list, *, attempt: int, root: Path | None = None) -> None:
    """Record returned refs before sync so a retry can resync without repeating completed work."""
    _append({"event": "made", "id": job_id, "refs": refs, "attempt": attempt}, root)


def done(job_id: str, result: str | None = None, *, made: list | None = None, why: str | None = None,
         attempt: int, root: Path | None = None) -> None:
    """Record result card, all made pairs and optional unchanged reason.
    Attempt identity prevents late outcomes from ending newer work."""
    _append({"event": "done", "id": job_id, "result": result, **({"made": made} if made else {}),
             **({"why": why[:400]} if why else {}), "attempt": attempt}, root)


def failed(job_id: str, why: str = "", *, attempt: int, root: Path | None = None) -> None:
    _append({"event": "failed", "id": job_id, "why": why, "attempt": attempt}, root)


def stopped(job_id: str, *, attempt: int, root: Path | None = None) -> None:
    """The attempt ended because the user paused or cancelled the job: its agent and tools were stopped."""
    _append({"event": "stopped", "id": job_id, "attempt": attempt}, root)


def clean_trim(v) -> dict | None:
    """Accept 0 <= start < end in seconds, rounded to milliseconds; None means no trim.
    Invalid input raises ValueError for the HTTP boundary to reject."""
    if v in (None, {}, ""):
        return None
    if not isinstance(v, dict):
        raise ValueError("trim is {start, end} in seconds")
    try:
        a, b = round(float(v["start"]), 3), round(float(v["end"]), 3)
    except (KeyError, TypeError, ValueError):
        raise ValueError("trim is {start, end} in seconds")
    if not (0 <= a < b) or b - a < 0.1:
        raise ValueError("trim: 0 <= start < end, at least 0.1 s")
    return {"start": a, "end": b}
