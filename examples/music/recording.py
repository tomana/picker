"""Recordings share one decoded format for lanes, trims and loop backing."""
import base64
import json
import math
import subprocess
import wave
from pathlib import Path

import numpy as np

RATE = 22050
FORMATS = {".wav", ".mp3", ".m4a", ".flac"}


def _wav(path: Path, x: np.ndarray) -> None:
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes((np.clip(x, -1, 1) * 32767).astype("<i2").tobytes())


def _peaks(x: np.ndarray, n: int = 200) -> str:
    b = np.array_split(np.abs(x), n)
    top = max(1e-9, float(np.abs(x).max()))
    return base64.b64encode(bytes(int(255 * float(c.max(initial=0)) / top) for c in b)).decode()


def read(path: Path) -> np.ndarray:
    with wave.open(str(path), "rb") as w:
        if (w.getnchannels(), w.getsampwidth(), w.getframerate()) != (1, 2, RATE):
            raise ValueError("recordings must be mono 22050 Hz PCM WAV")
        x = np.frombuffer(w.readframes(w.getnframes()), dtype="<i2").astype(np.float32) / 32768
    if not len(x):
        raise ValueError("the recording has no audio")
    return x


MAX_SECONDS = 20 * 60          # a longer recording is cut here: it is decoded whole into memory


def decode(source: Path, target: Path) -> np.ndarray:
    got = subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-y", "-i", str(source), "-vn", "-t", str(MAX_SECONDS),
                          "-ac", "1", "-ar", str(RATE), "-c:a", "pcm_s16le", str(target)],
                         capture_output=True, timeout=120)
    if got.returncode:
        raise ValueError("could not decode this audio file")
    return read(target)


def write_recording(home: Path, label: str, x: np.ndarray, created: float, why: str = "") -> None:
    out = home / "v1"
    out.mkdir(parents=True, exist_ok=True)
    _wav(out / "rec.wav", x)
    (out / "version.json").write_text(json.dumps({
        "n": 1, "id": "v1", "created": created, "agent": None, "model": None, "effort": None,
        "rationale": why or label, "duration": len(x) / RATE, "media": {"audio": "rec.wav"},
        "parts": [{"kind": "voice", "id": "rec", "label": "recording", "enabled": True, "group": 0,
                   "src": "rec.wav", "audio": "rec.wav", "peaks": _peaks(x)}]}))
    tmp = home / "meta.json.tmp"
    tmp.write_text(json.dumps({"label": label, "created": created, "kind": "recording"}))
    tmp.replace(home / "meta.json")


def select_span(duration: float, trim: dict | None = None) -> dict:
    start = float(trim["start"]) if trim else 0.0
    end = float(trim["end"]) if trim else min(duration, 8 * 60 / 110)
    if not math.isfinite(start) or not math.isfinite(end):
        raise ValueError("recording bounds must be finite")
    start, end = max(0.0, start), min(duration, end)
    if end <= start:
        raise ValueError("the selected stretch is outside the recording")
    return {"start": start, "dur": end - start}


def stretch(path: Path, span: dict, samples: int) -> np.ndarray:
    x = read(path)
    a = max(0, round(span["start"] * RATE))
    b = min(len(x), round((span["start"] + span["dur"]) * RATE))
    if b <= a:
        raise ValueError("the selected stretch has no audio")
    return np.resize(x[a:b], samples)
