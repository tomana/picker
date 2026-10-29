"""Append per-store AUTO outcomes and plugin playback events, each naming its type."""
from __future__ import annotations

import fcntl
import json
import threading
import time
from pathlib import Path

from . import stores as ST

NAME = "auto.jsonl"
changed = threading.Condition()     # a line was logged: wakes a long-poll (the phone app's events)


def path(type_: str, root: Path | None = None) -> Path:
    return ST.log(NAME, type_=type_, root=root)


def append(type_: str, rec: dict, root: Path | None = None) -> dict:
    rec = {"ts": time.time(), "type": type_, **rec}
    p = path(type_, root)
    p.parent.mkdir(parents=True, exist_ok=True)
    with open(p, "a") as f:
        fcntl.flock(f, fcntl.LOCK_EX)
        f.write(json.dumps(rec, ensure_ascii=False) + "\n")
        fcntl.flock(f, fcntl.LOCK_UN)
    with changed:
        changed.notify_all()
    return rec


def read(type_: str, root: Path | None = None) -> list[dict]:
    """The tab's lines: a line names its tab (`type`); older lines that don't are the file's own tab's."""
    p = path(type_, root)
    out = []
    if p.is_file():
        for line in p.read_text().splitlines():
            try:
                e = json.loads(line)
            except json.JSONDecodeError:
                continue
            if e.get("type") in (None, type_):
                out.append(e)
    return out
