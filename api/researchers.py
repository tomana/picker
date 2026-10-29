"""Share the runner start path; status remains runner-owned.
A missing manifest start command is unsupported, not inferred from stored cards."""
import os
import shutil
import subprocess
from pathlib import Path

from flask import Blueprint, abort, jsonify

import runner as R
from core import agents as A
from core import config as CONFIG
from core import lanes as L
from core import queue as Q
from core import trace as T

bp = Blueprint("researchers", __name__)

# Which agents a TYPE accepts is its `agents` list in its manifest; every name there but `sweep` (a type's own
# parametric path, no model) is in picker/agents.json.

ROOT = CONFIG.get().research


def _types() -> list[dict]:
    try:
        return CONFIG.types()
    except Exception:
        return []


def _one(type_: str) -> dict:
    for t in _types():
        if t["type"] == type_:
            return t
    abort(404, description=f"no type {type_!r}")


def _home(t: dict) -> Path:
    return (ROOT / t["researcher"]).parent


lane_for = Q.lane_for


def alive(t: dict, lane: str | None = None) -> bool:
    """Liveness means holding this lane's lock, not claiming to run in a status file."""
    return L.alive(t, lane)


def _detach(argv: list[str]) -> list[str]:
    """A new session stays in the service cgroup; use an independent scope under a service.
    Outside a service, a new session suffices."""
    if os.environ.get("INVOCATION_ID") and shutil.which("systemd-run"):
        return ["systemd-run", "--user", "--scope", "--quiet", "--collect", "--", *argv]
    return argv


def start_runner(t: dict, kinds: list[str] | None = None, lane: str | None = None):
    """Share starts between scheduler and checks; kinds restricts claims to ping-only work.
    Concurrent starts are safe because only one runner can acquire the lifetime lane lock."""
    return _start_runner(t, kinds, lane)


def _claimable(t: dict, kinds: list[str] | None) -> dict:
    """What a runner started now would find: queued or waiting work it may claim,
    and the failed jobs it may not."""
    mine = [j for j in Q.jobs(type=t["type"]) if not kinds or j["kind"] in kinds]
    queued = [j for j in mine if j["status"] in ("queued", "waiting")]
    failed = [j for j in mine if j["status"] == "failed" and not j.get("dismissed")
              and j["kind"] != "ping"]
    counts = {"queued": sum(j["status"] == "queued" for j in queued),
              "waiting": sum(j["status"] == "waiting" for j in queued),
              "failed": len(failed)}
    why = sorted({(j.get("why") or "").split(":", 1)[0] or "failed" for j in failed})
    if queued:
        msg = None
    elif failed:
        msg = (f"nothing queued for {t['type']} — {len(failed)} failed "
               f"({', '.join(why)}); ↻ on a row tries it again, → hands it to another agent")
    else:
        msg = f"nothing queued for {t['type']}"
    return {"claimable": len(queued), "counts": counts, "message": msg}


def start_for(t: dict, job: dict):
    return start_runner(t, lane=lane_for(job))


def _admitted(t, kinds, lane):
    from core import budget as B
    ready = False
    for j in Q.jobs(type=t["type"]):
        if ((j["status"] == "queued" or Q.due(j)) and j.get("live") is None
                and (not kinds or j["kind"] in kinds) and lane_for(j) == lane):
            d = B.check(B.agent_of(j, t), model=j.get("model"))
            if not B.park(j, d):
                ready = True
    return ready


def _start_runner(t: dict, kinds: list[str] | None,
                  lane: str | None = None):
    type_ = t["type"]
    from core import gate
    if gate.closed():                      # a switch under way (core/gate.py): the job stays queued, nothing starts
        return ({"ok": False, "err": "the gate is closed for maintenance — the job waits in the queue",
                 "gate": gate.state()}, 503)
    argv = t.get("start")
    if not argv:
        return ({"ok": False, "err": f"{type_} has no queue-driven researcher yet",
                 "detail": "its manifest has no `start`"}, 501)

    home = _home(t)
    if L.alive(t, lane):
        state = R.read(home, lane)
        T.emit("api", "runner.refused", type=type_, why="already running", holder=state.get("agent"))
        return ({"ok": False, "err": "already running", "state": state}, 409)

    if kinds:
        bad = [k for k in kinds if k not in Q.KINDS]
        if bad:
            return ({"ok": False, "err": f"unknown kinds {bad}"}, 400)
        argv = list(argv) + ["--kinds", ",".join(kinds)]

    # Nothing is alive in this lane now, so a live attempt is a dead predecessor's: ended, its job back in line
    L.release(t, lane)

    # Do not start an empty lane or report it as working; failed jobs require explicit retry.
    work = _claimable(t, kinds)
    if not work["claimable"]:
        T.emit("api", "runner.idle", type=type_, lane=lane, **work["counts"])
        return ({"ok": True, "idle": True, "type": type_, **work}, 200)

    if not _admitted(t, kinds, lane):
        return ({"ok": True, "waiting": True, "message": "jobs wait for their agent's admission settings"}, 200)

    logdir = home / "logs"
    logdir.mkdir(parents=True, exist_ok=True)
    log = logdir / (f"queue_runner.{lane}.log" if lane else "queue_runner.log")
    # Detached, so it outlives a picker restart (see _detach). It ends by itself
    # when the queue empties, which is why there is no budget to pass it.
    with open(log, "a") as lf:
        proc = subprocess.Popen(
            _detach(CONFIG.expand(argv)),          # {picker}: the runner imports picker.sdk from this tree
            cwd=str(home), stdout=lf, stderr=subprocess.STDOUT,
            start_new_session=True,
            env={**A.agent_env(), **({R.LANE_ENV: lane} if lane else {})})   # PICKER_CONFIG among them (core/config.py)
    T.emit("api", "runner.start", type=type_, kinds=kinds, lane=lane,
           pid=proc.pid,
           argv=argv)
    return ({"ok": True, "type": type_, "pid": proc.pid,
             "log": str(log.relative_to(ROOT) if log.is_relative_to(ROOT) else log)}, 202)


@bp.post("/api/researchers/<type_>/stop")
def stop(type_):
    home = _home(_one(type_))
    if not R.read(home).get("running"):
        return jsonify({"ok": False, "err": "not running"}), 409
    return jsonify({"ok": True, **R.force_stop(home)})
