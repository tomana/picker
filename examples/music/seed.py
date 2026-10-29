# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy"]
# ///
"""Runs-only mode leaves store projection to the caller."""
import json
import sys
import tempfile
from pathlib import Path

import numpy as np

from fake_agent import make
from recording import FORMATS, RATE, decode, select_span, write_recording
from synth import play

HERE = Path(__file__).resolve().parent
IDEAS = ["night minor", "glass major", "hollow dorian", "wire whole", "slow minor", "bright major", "dust dorian",
         "warm minor", "tide whole", "low major"]


RECORDINGS = [("rec01", "whistled tune", 9.0, "eight whistled notes over room noise"),
              ("rec02", "kitchen hum", 12.0, "a mains hum that swells and fades"),
              ("rec03", "rain on a window", 10.0, "rain, and drops on the glass")]


def _recording(label: str, secs: float, seed: int) -> np.ndarray:
    """A made-up recording over room noise: a whistled tune, a mains hum, or rain."""
    rng = np.random.default_rng(seed)
    t = np.arange(int(secs * RATE)) / RATE
    if label == "whistled tune":
        notes = np.array([76, 79, 81, 79, 76, 74, 76, 72])
        f = 440 * 2 ** ((notes[np.minimum(len(notes) - 1, (t / secs * len(notes)).astype(int))] - 69) / 12)
        x = 0.35 * np.sin(2 * np.pi * np.cumsum(f * (1 + 0.006 * np.sin(2 * np.pi * 5.5 * t))) / RATE)
        x *= np.minimum(1, 6 * ((t * len(notes) / secs) % 1))
    elif label == "kitchen hum":
        x = (0.25 * np.sin(2 * np.pi * 50 * t) + 0.1 * np.sin(2 * np.pi * 100 * t)) * (1 + 0.3 * np.sin(2 * np.pi * 0.2 * t))
    else:
        x = 0.12 * rng.standard_normal(t.size) * (0.6 + 0.4 * np.sin(2 * np.pi * 0.15 * t))
        for at in rng.integers(0, t.size - RATE // 20, 90):
            k = np.arange(RATE // 20)
            x[at:at + k.size] += 0.5 * rng.uniform(0.3, 1) * np.exp(-k / 120) * rng.standard_normal(k.size)
    return (x + 0.02 * rng.standard_normal(t.size)) * np.minimum(1, np.minimum(t, secs - t) / 0.3)


def record(runs: Path, t0: float, recordings: Path | None = None) -> list[str]:
    files = sorted(p for p in (recordings or HERE / "recordings").glob("*")
                   if p.is_file() and p.suffix.lower() in FORMATS)
    made = []
    for j in range(max(len(files), len(RECORDINGS))):      # the files first; made-up ones fill up to three
        if j < len(files):
            cid, label = f"rec{j + 1:02d}", files[j].stem
            with tempfile.TemporaryDirectory() as tmp:
                x = decode(files[j], Path(tmp) / "rec.wav")
            why = f"{label}: imported recording"
        else:
            cid, label, secs, what = RECORDINGS[j]
            x = _recording(label, secs, j)
            why = f"{label}: a made-up recording, {what}"
        write_recording(Path(runs) / cid, label, x, t0 - 86400 + j * 600, why)
        made.append(cid)
    return made


def seed(runs: Path, n: int = 0, t0: float = 1790050000, recordings: Path | None = None) -> list[str]:
    made = record(runs, t0, recordings)
    for j, rec in enumerate(list(made)):
        cid = f"{rec}loop"
        source = Path(runs) / rec / "v1"
        duration = json.loads((source / "version.json").read_text())["duration"]
        label = json.loads((source.parent / "meta.json").read_text())["label"]
        given = (recordings or HERE / "recordings") / f"{label}.loop.json"      # a recording may bring its own loop
        p = json.loads(given.read_text()) if given.is_file() else make(IDEAS[j % len(IDEAS)], None, cid)
        span = select_span(duration, p.pop("span", None) or {"start": min(1, duration / 4), "end": min(duration, 5)})
        out = Path(runs) / cid / "v1"
        out.mkdir(parents=True, exist_ok=True)
        (out / "loop.json").write_text(json.dumps(p, indent=1))
        got = play(p, out, source / "rec.wav", span)
        (out / "version.json").write_text(json.dumps({
            "n": 1, "id": "v1", "created": t0 + j * 600, "agent": "fake", "model": None, "effort": None,
            "rationale": f"{p['why']}, over a stretch of the recording", "params": {"tempo": p["tempo"]}, **got}))
        (Path(runs) / cid / "meta.json").write_text(json.dumps({
            "label": f"{label} loop",
            "created": t0 + j * 600, "parent": rec, "span": span}))
        made.append(cid)
    for i in range(n):
        cid = f"mus{i + 1:02d}"
        base = None
        for k in range(1 + i % 3):                       # one, two or three versions
            p = make(IDEAS[i % len(IDEAS)] if base is None else "", base, f"{cid}/v{k + 1}")
            out = Path(runs) / cid / f"v{k + 1}"
            out.mkdir(parents=True, exist_ok=True)
            (out / "loop.json").write_text(json.dumps(p, indent=1))
            got = play(p, out)
            (out / "version.json").write_text(json.dumps({
                "n": k + 1, "id": f"v{k + 1}", "created": t0 + i * 3600 + k * 600, "agent": "fake", "model": None,
                "effort": None, "rationale": p["why"], "params": {"tempo": p["tempo"]}, **got}))
            base = p
        (Path(runs) / cid / "meta.json").write_text(json.dumps({"label": IDEAS[i % len(IDEAS)], "created": t0 + i * 3600}))
        made.append(cid)
    return made


if __name__ == "__main__":
    made = seed(HERE / "runs", int(sys.argv[1]) if len(sys.argv) > 1 and sys.argv[1].isdigit() else 0)
    if "--runs-only" not in sys.argv:
        sys.path.insert(0, str(HERE.parents[1]))           # the picker's own tree: its link helper
        from sync import project
        project(HERE / "runs", HERE / "cards")
    print(" ".join(made))
