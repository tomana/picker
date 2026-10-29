"""Share work-selection state through a last-write-wins log; device presentation stays local."""
import fcntl
import json
import time
from pathlib import Path

from . import config as C

DATA = C.get().data                               # the picker's own logs (the config's `data`)
LOG = DATA / "prefs.jsonl"

# Keep preference keys closed so arbitrary caller state cannot accumulate here.
KEYS = {"filters", "panels", "agents", "auto", "tab_order"}

# Keys with dedicated validation routes must not bypass them through generic PATCH.
ROUTED = {"agents", "auto"}

# Panel decisions are shared per surface/type, not device-local presentation.

# Unlisted tabs follow explicit tab_order in configured order; share ordering across devices.

MAX_BYTES = 4096


def _path(root: Path | None = None) -> Path:
    return (Path(root) / "prefs.jsonl") if root else LOG


def set(key: str, value, *, root: Path | None = None) -> None:     # noqa: A001
    if key not in KEYS:
        raise ValueError(f"key must be one of {sorted(KEYS)}")
    rec = {"ts": time.time(), "key": key, "value": value}
    line = json.dumps(rec, ensure_ascii=False)
    if len(line) > MAX_BYTES:
        raise ValueError("value too large")
    p = _path(root)
    p.parent.mkdir(parents=True, exist_ok=True)
    with open(p, "a") as f:
        fcntl.flock(f, fcntl.LOCK_EX)
        f.write(line + "\n")
        f.flush()
        fcntl.flock(f, fcntl.LOCK_UN)


def fold(root: Path | None = None) -> dict:
    """Apply last-write-wins and skip unknown/malformed records; bad preferences must not break reads."""
    out: dict = {}
    p = _path(root)
    if not p.exists():
        return out
    for line in p.read_text().splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            rec = json.loads(line)
        except json.JSONDecodeError:
            continue
        k = rec.get("key")
        if k in KEYS:
            out[k] = rec.get("value")
    return out
