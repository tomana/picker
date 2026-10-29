"""Block starts and claims while preserving queued work.
Closing takes the claim lock so an idle check cannot miss a crossing claim."""
from __future__ import annotations

import json
import os
import time
from pathlib import Path

from . import config as C

STATE = C.get().state                    # the config's `state` (not the store: the gate is the picker's, not a card's)


def _path(root: Path | None = None) -> Path:
    return (Path(root) if root else STATE) / "gate.json"


def state(root: Path | None = None) -> dict | None:
    """Missing/unreadable gate state means open; the writer is responsible for reporting write failures."""
    try:
        d = json.loads(_path(root).read_text())
    except (OSError, ValueError):
        return None
    return d if isinstance(d, dict) and d.get("closed") else None


def closed(root: Path | None = None) -> bool:
    return state(root) is not None


def close(why: str = "", root: Path | None = None) -> dict:
    """Close under the claim lock: a claim is either visible before close or blocked after it."""
    from . import queue as Q
    p = _path(root)
    p.parent.mkdir(parents=True, exist_ok=True)
    d = {"closed": True, "since": time.time(), "why": str(why)[:300]}
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps(d))
    with Q._locked(root):
        os.replace(tmp, p)
    return d


def open_(root: Path | None = None) -> None:
    try:
        _path(root).unlink()
    except FileNotFoundError:
        pass
