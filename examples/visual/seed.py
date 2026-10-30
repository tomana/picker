# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy", "pillow"]
# ///
"""Runs-only mode leaves store projection to the caller."""
import json
import sys
from pathlib import Path

from draw import draw
from fake_agent import make

HERE = Path(__file__).resolve().parent
IDEAS = ["slow rings", "tide bands", "ember bands", "moss rings", "glass bands", "dune bands", "frost rings",
         "silk bands", "smoke rings", "slate rings", "fern bands", "kiln bands"]


def seed(runs: Path, n: int = 8, t0: float = 1790000000) -> list[str]:
    made = []
    for i in range(n):
        cid = f"vis{i + 1:02d}"
        base = None
        for k in range(1 + i % 3):                       # one, two or three versions
            p = make(IDEAS[i % len(IDEAS)] if base is None else "", base, f"{cid}/v{k + 1}")
            out = Path(runs) / cid / f"v{k + 1}"
            out.mkdir(parents=True, exist_ok=True)
            (out / "pattern.json").write_text(json.dumps(p, indent=1))
            media = draw(p, out)
            (out / "version.json").write_text(json.dumps({
                "n": k + 1, "id": f"v{k + 1}", "created": t0 + i * 3600 + k * 600, "agent": "fake", "model": None,
                "effort": None, "rationale": p["why"], "params": {x: p[x] for x in ("shape", "count", "twist", "warp", "speed")},
                "media": media, "parts": []}))
            base = p
        (Path(runs) / cid / "meta.json").write_text(json.dumps({"label": IDEAS[i % len(IDEAS)], "created": t0 + i * 3600}))
        made.append(cid)
    return made


if __name__ == "__main__":
    made = seed(HERE / "runs", int(sys.argv[1]) if len(sys.argv) > 1 and sys.argv[1].isdigit() else 8)
    if "--runs-only" not in sys.argv:
        sys.path.insert(0, str(HERE.parents[1]))           # the picker's own tree: its link helper
        from sync import project
        project(HERE / "runs", HERE / "cards")
    print(" ".join(made))
