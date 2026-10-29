"""Use copied stores and throwaway runner overlays only; sync refusal still proves the sync was reached."""
import json
import os
import subprocess
import sys
import time
from pathlib import Path

PICKER = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(PICKER))

from core import config as C  # noqa: E402

ROOT = C.require([]).research                    # Use only research paths from the sandbox config.
from core import queue as Q  # noqa: E402

# a job each type takes: a seed, unless the suite's fixture.py says another (DRY_JOBS: {type: (kind, card)} — a revise
# or an inspire on a made-up card of its own; a type whose revise reads research the made-up card hasn't, a seed)
import os                                     # noqa: E402
import runpy                                  # noqa: E402
JOBS = runpy.run_path(os.environ["FIXTURE_SUITE"] + "/fixture.py").get("DRY_JOBS", {}) if os.environ.get("FIXTURE_SUITE") else {}
# a sync's own last word: its refusal on a store with no research behind it is the answer that proves it ran
VERDICT = ("LOST DATA", "MISMATCH", "no run dirs", "broken", "OK")
BROKEN = ("Traceback", "ModuleNotFoundError", "No such file", "can't open file", "ImportError")


def main() -> int:
    cfg = C.require([])                  # the sandbox's PICKER_CONFIG, never a fallback
    types = C.types(cfg)
    bad = 0
    for t in types:
        kind, card = JOBS.get(t["type"], ("seed", None))
        job = Q.enqueue(type=t["type"], kind=kind, card=card, text="a dry run")
        mark = len((cfg.data / "trace.jsonl").read_text().splitlines())
        home = ROOT / Path(t["researcher"]).parent
        argv = C.expand([*t["start"], "--dry-run"])     # {picker}: the runner imports picker.sdk from this tree
        if "--agent" in argv:
            argv[argv.index("--agent") + 1] = (t.get("agents") or ["claude"])[0]
        t0 = time.time()
        r = subprocess.run(argv, cwd=home, capture_output=True, text=True, timeout=240,
                           env={**os.environ, "PICKER_URL": "http://127.0.0.1:9",
                                "PICKER_DRY_RUN": "the harness"})       # a dry run only here (core/researcher.drain)
        j = Q.get(job["id"])
        new = [json.loads(x) for x in (cfg.data / "trace.jsonl").read_text().splitlines()[mark:] if x.strip()]
        up = any(e.get("ev") == "runner.up" for e in new)
        sync = next((e for e in new if e.get("src") == "researcher" and e.get("ev") == "sync"), None)
        why = (j.get("why") or "").strip()
        words = (sync or {}).get("stderr") or why
        broken = [b for b in BROKEN if b in words and "SystemExit" not in words]
        ok = up and j["status"] in ("done", "failed") and sync is not None and not broken
        bad += not ok
        print(f"{'ok ' if ok else 'BAD'} {t['type']:<12} exit {r.returncode} · {time.time() - t0:4.1f} s · "
              f"{'up' if up else 'NOT UP'} · claimed by {j.get('researcher') or '—'} · "
              f"sync {'exit ' + str(sync.get('exit')) if sync else 'NONE'} via {(sync or {}).get('script', '—')} · "
              f"{j['status']}{(': ' + why[:110]) if why else ''}")
        if sync and sync.get("exit"):
            # the trace keeps the sync's last two lines; its verdict may be above them — ask it once more
            s = t["sync"]
            m = subprocess.run(C.expand(s["argv"]), cwd=ROOT / s.get("cwd", "."), capture_output=True, text=True,
                               timeout=240, env={**os.environ, "PYTHONPATH": str(PICKER)})
            said = [ln for ln in (m.stdout + m.stderr).splitlines() if ln.startswith(VERDICT) or "no run dirs" in ln]
            print(f"    its sync says: {(said or ['(no verdict line)'])[-1][:160]}")
        if not ok:
            print("    " + "\n    ".join(((r.stderr or r.stdout).strip().splitlines() or ["(no output)"])[-6:]))
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
