#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy"]
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
TYPE = "music"
RUNS = HERE / "runs"


def cwd() -> Path:
    return HERE


def recording_source(job: dict) -> tuple[Path, dict] | None:
    from recording import select_span
    cid, span = job.get("recording") or job.get("card"), None
    for _ in range(6):
        meta = RUNS / str(cid) / "meta.json"
        if not cid or not meta.is_file():
            return None
        m = json.loads(meta.read_text())
        span = span or m.get("span")
        if m.get("kind") == "recording":
            source = meta.parent / "v1"
            duration = json.loads((source / "version.json").read_text())["duration"]
            trim = job.get("trim") if cid in (job.get("card"), job.get("recording")) else None
            if span and trim is None:
                trim = {"start": span["start"], "end": span["start"] + span["dur"]}
            return source / "rec.wav", select_span(duration, trim)
        cid = m.get("parent")
    return None


def _plan(job: dict) -> tuple[str, int, Path, Path | None]:
    """The card, the new version's number, the file the agent writes, the loop it builds from."""
    meta = RUNS / str(job.get("card")) / "meta.json"
    is_recording = meta.is_file() and json.loads(meta.read_text()).get("kind") == "recording"
    cid = job["card"] if job["kind"] == "revise" and not is_recording else f"mus{job['id'][:8]}"
    have = [int(p.name[1:]) for p in (RUNS / cid).glob("v*") if p.name[1:].isdigit()]
    n = max(have, default=0) + 1
    base = None
    if job.get("card"):
        _, b = sdk.version_votes(job)                 # the one on screen, else the newest not voted down
        vid = (b or {}).get("id") or f"v{max([int(p.name[1:]) for p in (RUNS / job['card']).glob('v*') if p.name[1:].isdigit()], default=1)}"
        f = RUNS / job["card"] / vid / "loop.json"
        base = f if f.is_file() else None
    return cid, n, RUNS / cid / f"v{n}" / "loop.json", base


def brief(job: dict, agent: str) -> str:
    cid, n, target, base = _plan(job)
    rel = lambda p: str(p.relative_to(HERE))                # noqa: E731
    source = recording_source(job)
    recording = ""
    if source:
        path, span = source
        recording = (f"\nRecording: {rel(path)}\n"
                     f"Use seconds {span['start']:.3f} to {span['start'] + span['dur']:.3f}. "
                     "Make notes that work with this stretch. The runner adds it as the rec lane; do not write audio.\n")
    return (f"You make cards for the picker's `{TYPE}` tab. Read program.md first: what a loop is, and its ranges.\n\n"
            + sdk.note_line(job["kind"], job.get("text") or "")
            + sdk.version_note(job)
            + f"\nYour job: write ONE file, {rel(target)} — a loop as program.md describes it. Write nothing else.\n"
            + (f"Build from: {rel(base)}\n" if base else "Start from nothing: a new loop.\n") + recording)


def work(job: dict, report) -> list:
    from synth import play
    agent = sdk.agent_for(job, ARGS.agent)
    cid, n, target, _ = _plan(job)
    report(f"asking {agent}")
    res = sdk.run_job(agent, brief(job, agent), HERE, HERE / "logs" / f"queue_{job['id']}.log",
                      model=job.get("model"))
    if not target.is_file():
        raise RuntimeError(f"{agent} did not write {target.relative_to(HERE)}")
    loop = json.loads(target.read_text())
    report("playing")
    source = recording_source(job)
    got = play(loop, target.parent, *(source or ()))
    meta = RUNS / cid / "meta.json"
    if not meta.is_file():
        meta.write_text(json.dumps({"label": loop.get("name") or cid, "created": time.time(), "job": job["id"],
                                    "parent": job.get("card") if cid != job.get("card") else None,
                                    **({"span": source[1]} if source else {})}))
    (target.parent / "version.json").write_text(json.dumps({
        "n": n, "id": f"v{n}", "created": time.time(), "agent": agent, "model": res.model, "effort": res.effort,
        "rationale": loop.get("why", ""), "params": {"tempo": loop.get("tempo")}, **got}))
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
