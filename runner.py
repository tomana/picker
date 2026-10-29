"""Status files are observational; only lifetime lane locks prove ownership.
Cleanup checks start times to avoid killing recycled PIDs."""
import atexit
import contextlib
import json
import os
import time
from pathlib import Path

_FILENAME = "runner.json"

# PICKER_RUNNER_LANE selects a separate state file so concurrent lanes cannot overwrite each other's PID.
LANE_ENV = "PICKER_RUNNER_LANE"


def _path(root: Path, lane: str | None = None) -> Path:
    lane = lane or os.environ.get(LANE_ENV) or None
    return Path(root) / (f"runner.{lane}.json" if lane else _FILENAME)


def _atomic_write(target: Path, data: dict) -> None:
    """Write-temp-then-rename so a crash mid-write can't leave a
    half-written JSON file."""
    target.parent.mkdir(parents=True, exist_ok=True)
    tmp = target.with_suffix(target.suffix + ".tmp")
    with tmp.open("w") as f:
        json.dump(data, f)
        f.flush()
        os.fsync(f.fileno())
    tmp.replace(target)


def write(root: Path, *, agent: str | None,
          session: str | None = None,
          model: str | None = None,
          effort: str | None = None,
          log: str | None = None,
          phase: str = "starting") -> None:
    """Register clean-exit status updates while preserving run context; each lane needs its own state file.
    This observational status is not a lock."""
    root = Path(root)
    started_at = time.time()
    state = {
        "running":    True,
        "agent":      agent,
        "pid":        os.getpid(),
        "started_at": started_at,
        "session":    session,
        "model":      model,
        "effort":     effort,
        "phase":      phase,
        "log":        log,
        "error":      None,
        "exit_code":  None,
        "ended_at":   None,
    }
    _atomic_write(_path(root), state)

    def _cleanup():
        try:
            current = json.loads(_path(root).read_text())
            # Do not overwrite richer terminal state already recorded by an explicit finish or stop.
            if current.get("pid") != os.getpid() or not current.get("running"):
                return
            current.update({
                "running": False,
                "phase": "finished",
                "ended_at": time.time(),
                "exit_code": 0,
            })
            _atomic_write(_path(root), current)
        except Exception:
            pass        # exit-time best-effort; never crash on exit

    atexit.register(_cleanup)


def update(root: Path, **changes) -> None:
    path = _path(Path(root))
    try:
        state = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError):
        return
    if state.get("pid") != os.getpid():
        return
    state.update(changes)
    _atomic_write(path, state)


def finish(root: Path, *, error: str | None = None,
           exit_code: int = 0, phase: str | None = None) -> None:
    """Persist a terminal result without losing model/session/log context."""
    update(root,
           running=False,
           phase=phase or ("failed" if error else "finished"),
           error=error,
           exit_code=exit_code,
           ended_at=time.time())


# Hold the lane lock for the runner's lifetime; kernel release makes death observable.
# Record active groups so recovery stops abandoned writers before retrying their job.
_lane = None                     # this process's lock, while it holds one
_groups: set = set()             # the process groups it is running now: (group id, its leader's start time)
_mark = None                     # their lock (core/proc runs them from several threads)


def _lock_path(root: Path, lane: str | None = None) -> Path:
    lane = lane or os.environ.get(LANE_ENV) or None
    return Path(root) / (f"runner.{lane}.lock" if lane else "runner.lock")


def _take(root: Path, lane: str | None = None):
    """The lane's lock, if no runner holds it: (its file, the process groups its last holder left), else None."""
    import fcntl
    p = _lock_path(root, lane)
    p.parent.mkdir(parents=True, exist_ok=True)
    f = open(p, "a+")
    try:
        fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        f.close()
        return None
    f.seek(0)
    try:
        left = [tuple(g) for g in json.loads(f.read() or "{}").get("groups") or [] if isinstance(g, list)]
    except (ValueError, AttributeError, TypeError):
        left = []
    return f, left


def hold(root: Path) -> list | None:
    """Hold the lane for this process lifetime; None means another runner owns it.
    Keep inherited groups recorded until cleanup completes so interrupted handover remains recoverable."""
    global _lane
    got = _take(root)
    if got is None:
        return None
    _lane, left = got
    _groups.update(left)
    _write()
    return left


@contextlib.contextmanager
def taken(root: Path, lane: str | None = None):
    """Hold the free lane during cleanup and persist remaining abandoned groups on exit.
    Yield None while a live runner owns the lane."""
    got = _take(root, lane)
    if got is None:
        yield None
        return
    f, left = got
    try:
        yield left
    finally:
        f.seek(0)
        f.truncate()
        f.write(json.dumps({"pid": None, "groups": sorted(list(g) for g in left)}))
        f.close()


def held(root: Path, lane: str | None = None) -> bool:
    import fcntl
    p = _lock_path(root, lane)
    try:
        fd = os.open(p, os.O_RDONLY)
    except OSError:
        return False                            # no runner has ever held it
    try:
        fcntl.flock(fd, fcntl.LOCK_SH | fcntl.LOCK_NB)
        return False
    except BlockingIOError:
        return True
    finally:
        os.close(fd)                            # closing drops the shared lock a free lane gave


def started(pid: int) -> int | None:
    """Pair PID with start ticks; a recycled PID is not the abandoned process."""
    try:
        stat = Path(f"/proc/{int(pid)}/stat").read_text()
        return int(stat[stat.rindex(")") + 2:].split()[19])
    except (OSError, ValueError, IndexError):
        return None


def child(pgid: int, running: bool = True) -> None:
    """A process group this runner starts (`running`) or has seen end (core/proc), in its lock file."""
    global _mark
    if _lane is None:
        return
    import threading
    _mark = _mark or threading.Lock()
    with _mark:
        if running:
            _groups.add((pgid, started(pgid)))
        else:
            _groups.difference_update({g for g in _groups if g[0] == pgid})
        _write()


def _write() -> None:
    _lane.seek(0)
    _lane.truncate()
    _lane.write(json.dumps({"pid": os.getpid(), "groups": sorted(list(g) for g in _groups)}))
    _lane.flush()


def _pid_alive(pid: int) -> bool:
    """Check existence only; this status probe does not establish runner ownership."""
    try:
        return Path(f"/proc/{int(pid)}").exists()
    except (TypeError, ValueError):
        return False


def read(root: Path, lane: str | None = None) -> dict:
    """Picker-side: the JSON, with `stale` when it says running but its pid is gone (a crash before its atexit)."""
    keys = ("agent", "pid", "started_at", "session", "model", "effort", "phase", "log", "error", "exit_code",
            "ended_at")
    p = _path(root, lane)
    try:
        data = json.loads(p.read_text()) if p.exists() else {}
        broken = False
    except (OSError, json.JSONDecodeError):
        data, broken = {}, True
    stale = broken or bool(data.get("running") and data.get("pid") and not _pid_alive(data["pid"]))
    if stale:
        data["running"] = False
    return {"running": bool(data.get("running")), **{k: data.get(k) for k in keys}, "stale": stale}


def kill_pid_tree(pid: int, timeout_secs: float = 4.0) -> dict:
    """Terminate the group and escalate after the timeout; a missing PID counts as gone.
    Return signal/exit details without raising for an already-ended process."""
    import os as _os
    import signal as _signal

    if not _pid_alive(pid):
        return {"pid": pid, "pgid": None, "sigterm_ok": False,
                "sigkill_used": False, "gone": True}

    try:
        pgid = _os.getpgid(int(pid))
    except (ProcessLookupError, PermissionError, OSError):
        pgid = None

    target = -pgid if pgid else int(pid)
    sigterm_ok = False
    try:
        _os.kill(target, _signal.SIGTERM)
        sigterm_ok = True
    except (ProcessLookupError, PermissionError, OSError):
        pass

    # Escalate only if the PID still exists after the grace period.
    deadline = time.time() + timeout_secs
    while time.time() < deadline:
        if not _pid_alive(pid):
            return {"pid": pid, "pgid": pgid, "sigterm_ok": sigterm_ok,
                    "sigkill_used": False, "gone": True}
        time.sleep(0.5)

    sigkill_used = False
    try:
        _os.kill(target, _signal.SIGKILL)
        sigkill_used = True
    except (ProcessLookupError, PermissionError, OSError):
        pass
    # Give the kernel a tick to reap.
    time.sleep(0.3)
    gone = not _pid_alive(pid)
    return {"pid": pid, "pgid": pgid, "sigterm_ok": sigterm_ok,
            "sigkill_used": sigkill_used, "gone": gone}


def force_stop(root: Path, lane: str | None = None) -> dict:
    """Stop the recorded runner and persist non-running state; no recorded running PID is a no-op."""
    data = read(root, lane)
    pid = data.get("pid")
    if not data.get("running") or not pid:
        return {"pid": pid, "pgid": None, "sigterm_ok": False,
                "sigkill_used": False, "gone": True}
    report = kill_pid_tree(int(pid))
    # Persist stopped state even if cleanup could not confirm process exit.
    data.update({
        "running": False,
        "phase": "stopped",
        "ended_at": time.time(),
        "exit_code": -15,
    })
    _atomic_write(_path(root, lane), data)
    return report
