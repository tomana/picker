"""Locks prove lane ownership; recovery stops abandoned groups before ending their attempts.
Recover on every scheduler look, not only startup."""
from __future__ import annotations

from pathlib import Path

import runner as R

from . import config as C
from . import proc as P
from . import queue as Q
from . import trace as T

LANES = (None, *Q.AGENT_LANES)


def home(t: dict) -> Path:
    """Where a type's runner lives (its runner.json, its lane locks): beside its entry point."""
    return (C.get().research / t["researcher"]).parent


def alive(t: dict, lane: str | None = None) -> bool:
    return R.held(home(t), lane)


def held_by(j: dict, lane: str | None) -> bool:
    """Which lane claimed a job: lane runners sign `type:agent@lane`."""
    who = j.get("researcher") or ""
    return who.endswith(f"@{lane}") if lane else "@" not in who


def handover(type_: str, lane: str | None, groups: list, *, root: Path | None = None) -> list[str]:
    """Under the lane lock, stop abandoned groups before ending their exact attempts.
    Keep attempts live until all processes stop so retries cannot write beside a predecessor."""
    for g in list(groups):
        pg, start = g
        # gone, or its id now someone else's (its leader started at another time): nothing of ours to stop
        if (R.started(pg) not in (None, start)) or P.stop_group(pg):
            groups.remove(g)
    if groups:
        T.emit("lanes", "lane.busy", type=type_, lane=lane, groups=groups)
        return []
    out = []
    for j in Q.jobs(type=type_, root=root):
        if j.get("live") is not None and held_by(j, lane) and Q.orphan(j["id"], attempt=j["live"], root=root):
            T.emit("lanes", "job.orphaned", job=j["id"], type=type_, lane=lane, attempt=j["live"], phase=j.get("phase"))
            out.append(j["id"])
    return out


def release(t: dict, lane: str | None = None, *, root: Path | None = None) -> list[str]:
    """Clean abandoned attempts only while holding the free lane; a live owner makes this a no-op.
    Return ended ids; the lock excludes starts and concurrent cleanup."""
    with R.taken(home(t), lane) as groups:
        return [] if groups is None else handover(t["type"], lane, groups, root=root)


def recover(types: list[dict] | None = None, *, root: Path | None = None) -> list[str]:
    """Every lane's dead runner's attempts, ended (the minute's first look). Returns the ids."""
    live = [j for j in Q.jobs(root=root) if j.get("live") is not None]
    out = []
    for t in (C.types() if types is None else types):
        if not t.get("researcher"):
            continue
        for lane in LANES:
            if any(j["type"] == t["type"] and held_by(j, lane) for j in live):
                out += release(t, lane, root=root)
    return out
