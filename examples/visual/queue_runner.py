#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy", "pillow"]
# ///
"""Revisions use the selected version; the fake agent requires no model or network."""
import argparse
import json
import sys
import time
from pathlib import Path

from picker import sdk

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
TYPE = "visual"
RUNS = HERE / "runs"
KNOBS = ("shape", "count", "twist", "warp", "speed", "colors")


def cwd() -> Path:
    return HERE


def _plan(job: dict) -> tuple[str, int, Path, Path | None]:
    """The card, the new version's number, the file the agent writes, the pattern it builds from."""
    cid = job["card"] if job["kind"] == "revise" else f"vis{job['id'][:8]}"
    have = [int(p.name[1:]) for p in (RUNS / cid).glob("v*") if p.name[1:].isdigit()]
    n = max(have, default=0) + 1
    base = None
    if job.get("card"):
        _, b = sdk.version_votes(job)                 # the one on screen, else the newest not voted down
        vid = (b or {}).get("id") or f"v{max([int(p.name[1:]) for p in (RUNS / job['card']).glob('v*') if p.name[1:].isdigit()], default=1)}"
        f = RUNS / job["card"] / vid / "pattern.json"
        base = f if f.is_file() else None
    return cid, n, RUNS / cid / f"v{n}" / "pattern.json", base


def brief(job: dict, agent: str) -> str:
    cid, n, target, base = _plan(job)
    rel = lambda p: str(p.relative_to(HERE))                # noqa: E731
    return (f"You make cards for the picker's `{TYPE}` tab. Read program.md first: what a pattern is, and its ranges.\n\n"
            + sdk.note_line(job["kind"], job.get("text") or "")
            + sdk.version_note(job)
            + f"\nYour job: write ONE file, {rel(target)} — a pattern as program.md describes it. Write nothing else.\n"
            + (f"Build from: {rel(base)}\n" if base else "Start from nothing: a new pattern.\n"))


def work(job: dict, report) -> list:
    from draw import draw
    agent = sdk.agent_for(job, ARGS.agent)
    cid, n, target, _ = _plan(job)
    report(f"asking {agent}")
    res = sdk.run_job(agent, brief(job, agent), HERE, HERE / "logs" / f"queue_{job['id']}.log",
                      model=job.get("model"))
    if not target.is_file():
        raise RuntimeError(f"{agent} did not write {target.relative_to(HERE)}")
    p = json.loads(target.read_text())
    report("drawing")
    media = draw(p, target.parent)
    meta = RUNS / cid / "meta.json"
    if not meta.is_file():
        meta.write_text(json.dumps({"label": p.get("name") or cid, "created": time.time(), "job": job["id"],
                                    "parent": job.get("card") if job["kind"] == "inspire" else None}))
    (target.parent / "version.json").write_text(json.dumps({
        "n": n, "id": f"v{n}", "created": time.time(), "agent": agent, "model": res.model, "effort": res.effort,
        "rationale": p.get("why", ""), "params": {k: p[k] for k in KNOBS if k in p and k != "colors"},
        "media": media, "parts": []}))
    return [{"card": cid, "version": f"v{n}"}]


def main() -> int:
    global ARGS
    ap = argparse.ArgumentParser()
    ap.add_argument("--agent", default="fake")
    ap.add_argument("--kinds")
    ARGS = ap.parse_args()
    sdk.drain(TYPE, ARGS.agent, work, HERE, kinds=set(ARGS.kinds.split(",")) if ARGS.kinds else None, brief=brief)
    return 0


ARGS = argparse.Namespace(agent="fake")

if __name__ == "__main__":
    sys.exit(main())
