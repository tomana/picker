"""Plays a loop (program.md): each voice and the mix as WAV, each voice's waveform as the picker's lanes draw it, and
the loop's score — clash, how much the notes that sound together rub."""
from itertools import combinations
from pathlib import Path

import numpy as np

from recording import RATE, _peaks, _wav, stretch
RUB = {1: 1.0, 2: 0.5, 6: 0.7, 10: 0.4, 11: 0.9}          # an interval (in semitones, within an octave) → how it rubs


def _voice(v: dict, step: float, steps: int) -> np.ndarray:
    n, out = int(step * RATE), np.zeros(int(step * RATE * steps), np.float32)
    rnd = np.random.default_rng(len(v["name"]))
    for i, note in enumerate(v["notes"][:steps]):
        if note is None:
            continue
        ring = int(min(v["decay"] * 4, step * (steps - i)) * RATE)
        t = np.arange(ring) / RATE
        f = 440 * 2 ** ((note - 69) / 12)
        ph = 2 * np.pi * f * t
        x = {"sine": np.sin(ph), "saw": 2 * ((f * t) % 1) - 1, "square": np.sign(np.sin(ph)),
             "noise": rnd.uniform(-1, 1, ring)}[v["wave"]]
        x = x * np.exp(-t / v["decay"]) * np.minimum(1.0, 200 * t)          # a 5 ms attack: no click
        out[i * n:i * n + ring] += (x * v["level"] * 0.5).astype(np.float32)
    return out


def clash(loop: dict) -> float:
    """How much the notes that sound at the same step rub, per step with two or more notes: 0 (none) up."""
    steps, total, counted = 16, 0.0, 0
    for i in range(steps):
        held = [v["notes"][i] for v in loop["voices"] if v["wave"] != "noise" and i < len(v["notes"]) and v["notes"][i] is not None]
        if len(held) < 2:
            continue
        counted += 1
        total += sum(RUB.get(abs(a - b) % 12, 0) for a, b in combinations(held, 2))
    return round(total / counted, 3) if counted else 0.0


def play(loop: dict, out: Path, recording: Path | None = None, span: dict | None = None) -> dict:
    """voice WAVs, the mix and the parts into `out`; returns {duration, parts, media, score, measures, doubts}."""
    out, step = Path(out), 60 / loop["tempo"] / 2
    parts, mix = [], None
    for k, v in enumerate(loop["voices"]):
        x = _voice(v, step, 16)
        name = f"{k + 1}_{v['name']}.wav"
        _wav(out / name, x)
        parts.append({"kind": "voice", "id": f"{k + 1}_{v['name']}", "label": v["name"], "enabled": True, "group": 0,
                      "src": "loop.json", "audio": name, "peaks": _peaks(x)})
        mix = x if mix is None else mix + x
    if recording is not None:
        x = stretch(recording, span, len(mix)) * 0.35
        _wav(out / "rec.wav", x)
        parts.append({"kind": "voice", "id": "rec", "label": "recording", "enabled": True, "group": 0,
                      "src": "rec.wav", "audio": "rec.wav", "peaks": _peaks(x)})
        mix += x
    _wav(out / "mix.wav", mix / max(1.0, float(np.abs(mix).max()) / 0.9))
    c = clash(loop)
    notes = [n for v in loop["voices"] for n in v["notes"] if n is not None]
    span = (max(notes) - min(notes)) if notes else 0
    doubts = ["hardly any clash, but every note within a fifth: maybe dull"] if c < 0.1 and span <= 7 else []
    return {"duration": round(16 * step, 3), "parts": parts, "media": {"audio": "mix.wav"},
            "score": {"name": "clash", "value": c, "lower_is_better": True},
            "measures": {"notes": len(notes), "span": span}, "doubts": doubts}
