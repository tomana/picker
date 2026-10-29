"""Generate deterministic loops without a model or network."""
import hashlib
import json
import random
import re
import sys
from pathlib import Path

SCALES = {"minor": [0, 3, 5, 7, 10], "major": [0, 2, 4, 7, 9], "dorian": [0, 2, 3, 5, 7, 9, 10],
          "whole": [0, 2, 4, 6, 8, 10]}
WORDS = ["night", "tide", "glass", "dust", "wire", "low", "slow", "bright", "hollow", "warm"]


def _line(rnd, root: int, scale: list, density: float, octave: int) -> list:
    return [root + 12 * octave + rnd.choice(scale) if rnd.random() < density else None for _ in range(16)]


def make(words: str, base: dict | None, seed: str) -> dict:
    rnd = random.Random(hashlib.sha256(seed.encode()).hexdigest())
    w = words.lower()
    if base is None:
        scale_name = next((s for s in SCALES if s in w), rnd.choice(list(SCALES)))
        sc, root = SCALES[scale_name], rnd.choice([36, 38, 41, 43])
        voices = [{"name": "bass", "wave": rnd.choice(["sine", "saw"]), "notes": _line(rnd, root, sc[:3], 0.4, 0),
                   "decay": 0.25, "level": 0.9},
                  {"name": "lead", "wave": rnd.choice(["square", "saw", "sine"]), "notes": _line(rnd, root, sc, 0.5, 2),
                   "decay": 0.15, "level": 0.5}]
        if rnd.random() < 0.7:
            voices.append({"name": "click", "wave": "noise", "notes": [60 if i % 4 == 0 else None for i in range(16)],
                           "decay": 0.03, "level": 0.4})
        return {"name": words.strip()[:40] or f"{rnd.choice(WORDS)} {scale_name}", "tempo": rnd.choice([70, 90, 110, 128]),
                "voices": voices, "why": f"a new loop in {scale_name}" + (f", from \"{words.strip()}\"" if words.strip() else "")}
    p = json.loads(json.dumps(base))
    v = rnd.choice([x for x in p["voices"] if x["wave"] != "noise"] or p["voices"])
    what = rnd.choice(["notes", "wave", "decay"])
    if what == "notes":
        held = [n for n in v["notes"] if n is not None] or [48]
        v["notes"] = [rnd.choice(held) if rnd.random() < 0.5 else None for _ in range(16)]
    elif what == "wave":
        v["wave"] = rnd.choice([x for x in ("sine", "saw", "square") if x != v["wave"]])
    else:
        v["decay"] = round(max(0.03, min(2, v["decay"] * rnd.choice([0.5, 2]))), 3)
    p["why"] = f"changed the {v['name']}'s {what}" + (f", for \"{words.strip()}\"" if words.strip() else "")
    return p


def main() -> int:
    brief = sys.argv[1]
    target = re.search(r"write ONE file, (\S+?)\s", brief).group(1)
    base = re.search(r"Build from: (\S+)", brief)
    words = re.search(r'The operator wrote: "(.*)"', brief)
    # the paths come from the brief's text: only this example's runs/ is read or written
    runs = (Path(__file__).resolve().parent / "runs").resolve()
    for path in [target] + ([base.group(1)] if base else []):
        if not Path(path).resolve().is_relative_to(runs):
            print(f"refused: {path} is outside {runs}")
            return 1
    p = make(words.group(1) if words else "", json.loads(Path(base.group(1)).read_text()) if base else None,
             target + (words.group(1) if words else ""))
    recording = re.search(r"Recording: (.+)\nUse seconds ([\d.]+) to ([\d.]+)", brief)
    if recording:
        p["why"] += f", over {Path(recording[1]).parts[-3]} at {recording[2]}-{recording[3]} s"
    Path(target).parent.mkdir(parents=True, exist_ok=True)
    Path(target).write_text(json.dumps(p, indent=1))
    print(f"wrote {target}: {p['why']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
