"""Bind job/card/type tokens per call chain; readers join existing records by those tokens.
Trace writes never fail the work they describe."""
from __future__ import annotations

import contextlib
import contextvars
import fcntl
import json
import os
import threading
import time
from pathlib import Path

from . import config as C

DATA = C.get().data                               # the picker's own logs (the config's `data`)
LOG = DATA / "trace.jsonl"


def _path(root: Path | None) -> Path:
    """Where lines go. `PICKER_TRACE` redirects the whole process; the Python tests
    set it, so exercising a runner never writes into the user's trail."""
    if root:
        return Path(root) / "trace.jsonl"
    return Path(os.environ.get("PICKER_TRACE") or LOG)


TOKENS = ("job", "card", "type")

_ctx: contextvars.ContextVar[dict] = contextvars.ContextVar("trace_ctx", default={})


@contextlib.contextmanager
def bound(**tokens):
    """Every `emit` inside carries these tokens (unless it names its own)."""
    t = _ctx.set({**_ctx.get(), **{k: v for k, v in tokens.items() if v is not None}})
    try:
        yield
    finally:
        _ctx.reset(t)


def token(name: str):
    """The bound value of one token (`job`, `card`, `type`), or None."""
    return _ctx.get().get(name)


def emit(src: str, ev: str, *, root: Path | None = None, **fields) -> None:
    rec = {"ts": time.time(), "src": src, "ev": ev}
    ctx = _ctx.get()
    for k in TOKENS:
        v = fields.pop(k, None) or ctx.get(k)
        if v:
            rec[k] = v
    rec.update(fields)
    try:
        line = json.dumps(rec, ensure_ascii=False, default=str)
        with open(_path(root), "a") as f:
            fcntl.flock(f, fcntl.LOCK_EX)
            f.write(line + "\n")
            fcntl.flock(f, fcntl.LOCK_UN)
    except Exception:
        pass


def read(*, root: Path | None = None, **match) -> list[dict]:
    """Lines whose tokens match every given one (a list value matches any of it)."""
    p = _path(root)
    if not p.is_file():
        return []
    want = {k: (set(v) if isinstance(v, (list, set, tuple)) else {v})
            for k, v in match.items() if v}
    out = []
    for line in p.read_text(errors="replace").splitlines():
        try:
            rec = json.loads(line)
        except json.JSONDecodeError:
            continue
        if all(rec.get(k) in vs for k, vs in want.items()):
            out.append(rec)
    return out


# Read only appended trace bytes for actual invocation settings; reset the index if the file shrinks.
_RUNS: dict = {"path": None, "off": 0, "by_job": {}}
# Serialize offset updates so concurrent queue reads cannot double-advance past EOF.
_RUNS_LOCK = threading.Lock()


def agent_runs(root: Path | None = None) -> dict:
    """{job: {agent, model, effort, ts}}; each job's LATEST agent start."""
    with _RUNS_LOCK:
        return _agent_runs(_path(root))


def _agent_runs(p: Path) -> dict:
    st = _RUNS
    if st["path"] != p:
        st.update(path=p, off=0, by_job={})
    try:
        size = p.stat().st_size
    except OSError:
        return st["by_job"]
    if size < st["off"]:
        st.update(off=0, by_job={})
    if size > st["off"]:
        with open(p, "rb") as f:
            f.seek(st["off"])
            chunk = f.read(size - st["off"])
        cut = chunk.rfind(b"\n") + 1                 # whole lines only
        for line in chunk[:cut].splitlines():
            if b'"agent.start"' not in line:
                continue
            try:
                r = json.loads(line)
            except json.JSONDecodeError:
                continue
            if r.get("job"):
                st["by_job"][r["job"]] = {k: r.get(k) for k in ("agent", "model", "effort", "ts")}
        st["off"] += cut
    return st["by_job"]
