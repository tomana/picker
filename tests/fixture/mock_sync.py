"""Preserve job stamps during projection; failure markers exercise retry and interrupted-sync handling."""
import json
import os
import sys
from pathlib import Path

HERE = Path(os.environ["MOCK_HOME"])
STORE = Path(os.environ["MOCK_STORE"])

die = HERE / "die_in_sync"                  # the die-in-sync case: kill the runner that started this sync
if die.exists():
    die.unlink()
    os.kill(os.getppid(), 9)
    sys.exit(0)
fail = HERE / "sync_fail"
if fail.exists():
    fail.unlink()
    sys.exit("mock sync: the store is busy (failing once)")
for d in sorted(p for p in (HERE / "runs").iterdir() if p.is_dir()):
    vs = sorted((json.loads(f.read_text()) for f in d.glob("v*.json")), key=lambda v: v["n"])
    card = {"id": d.name, "type": "mock", "label": d.name, "created": vs[0]["created"] if vs else 0,
            "versions": vs, "media": {}}
    out = STORE / d.name
    out.mkdir(parents=True, exist_ok=True)
    tmp = out / "card.json.tmp"
    tmp.write_text(json.dumps(card))
    os.replace(tmp, out / "card.json")
