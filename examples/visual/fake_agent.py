"""Generate deterministic patterns without a model or network."""
import hashlib
import json
import random
import re
import sys
from pathlib import Path

SHAPES = ["rings", "bands"]       # no spirals: draw.py still draws one an older card asks for
# Mostly black and white, and "orig01", a hue wheel. A palette is colours from dark to light, or "orig01".
PALETTES = [["#000000", "#ffffff"], ["#050505", "#4a4a4a", "#f0f0f0"], ["#000000", "#1d1d1d", "#d9d9d9"],
            ["#000000", "#f5f2ea"], "orig01", "orig01"]
WORDS = ["tide", "ember", "moss", "glass", "dune", "frost", "smoke", "silk", "slate", "fern", "kiln", "pollen"]


def make(words: str, base: dict | None, seed: str) -> dict:
    rnd = random.Random(hashlib.sha256(seed.encode()).hexdigest())
    if base is None:
        shape = next((s for s in SHAPES if s in words.lower()), rnd.choice(SHAPES))
        p = {"name": words.strip()[:40] or f"{rnd.choice(WORDS)} {shape}", "shape": shape,
             "count": rnd.randint(3, 10), "twist": round(rnd.uniform(-2, 2), 2), "warp": round(rnd.uniform(0, 0.8), 2),
             "speed": rnd.choice([0.5, 1, 1.5]), "colors": rnd.choice(PALETTES)}
        p["why"] = f"a new {shape} pattern" + (f", from \"{words.strip()}\"" if words.strip() else "")
        return p
    p = dict(base)
    knob = rnd.choice(["count", "twist", "warp", "speed", "colors"])
    if knob == "count":
        p["count"] = max(2, min(14, p["count"] + rnd.choice([-2, -1, 1, 2])))
    elif knob == "twist":
        p["twist"] = round(max(-3, min(3, p["twist"] + rnd.uniform(-0.8, 0.8))), 2)
    elif knob == "warp":
        p["warp"] = round(max(0, min(1, p["warp"] + rnd.uniform(-0.3, 0.3))), 2)
    elif knob == "speed":
        p["speed"] = rnd.choice([s for s in (0.25, 0.5, 1, 1.5, 2) if s != p["speed"]])
    else:
        p["colors"] = rnd.choice([c for c in PALETTES if c != p["colors"]])
    p["why"] = f"changed its {knob}" + (f", for \"{words.strip()}\"" if words.strip() else "")
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
    Path(target).parent.mkdir(parents=True, exist_ok=True)
    Path(target).write_text(json.dumps(p, indent=1))
    print(f"wrote {target}: {p['why']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
