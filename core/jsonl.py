"""Skip malformed records without losing subsequent JSONL entries."""
import json
import time
from pathlib import Path


def append_jsonl(path: Path, rec: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    rec = {"ts": time.time(), **rec}
    with path.open("a") as f:
        f.write(json.dumps(rec) + "\n")
