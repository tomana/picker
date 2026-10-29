"""Install the guard first; project versions only into the fixture store with relative media links."""
import json
import os
import sys
from pathlib import Path

HERE = Path(sys.argv[1]).resolve()
PICKER = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(Path(__file__).resolve().parent))

import guard  # noqa: E402

guard.install(Path(os.environ["FIXTURE_LEAKS"]))

sys.path.insert(0, str(PICKER))
from core import stores as ST  # noqa: E402


def sync() -> int:
    made = 0
    for cdir in sorted(p for p in (HERE / "runs").glob("*") if (p / "meta.json").is_file()):
        meta = json.loads((cdir / "meta.json").read_text())
        home = ST.of_type(meta["type"]) / cdir.name
        if (home / "card.json").is_file():
            card = json.loads((home / "card.json").read_text())
        else:
            card = {"id": cdir.name, "type": meta["type"], "label": meta["label"], "created": meta["created"],
                    "created_from": "fake", "agent": "fake", "model": "none",
                    "narrative": {"rationale": "made up by a fake researcher"},
                    "lineage": {"parent": meta.get("parent"), "refs": [], "why": None},
                    "versions": [], "origin": {"job": meta["job"], "fake": True}}
        have = {v["id"] for v in card["versions"]}
        media = home / "media"
        for vfile in sorted(cdir.glob("v*/version.json"), key=lambda p: int(p.parent.name[1:])):
            v = json.loads(vfile.read_text())
            if v["id"] in have:
                continue
            media.mkdir(parents=True, exist_ok=True)

            def link(name: str) -> str:
                dst = media / f"{v['id']}__{name}"
                if not dst.is_symlink():
                    os.symlink(os.path.relpath(vfile.parent / name, media), dst)
                return f"media/{dst.name}"

            v["media"] = {k: link(n) for k, n in v["media"].items()}
            v["parts"] = [{**p, **{k: link(p[k]) for k in ("audio", "src") if p.get(k)}} for p in v["parts"]]
            card["versions"].append(v)
            made += 1
        if card["versions"]:
            card["media"] = card["versions"][-1]["media"]
            home.mkdir(parents=True, exist_ok=True)
            tmp = home / "card.json.tmp"
            tmp.write_text(json.dumps(card, indent=1))
            tmp.replace(home / "card.json")
    return made


if __name__ == "__main__":
    print(f"[fake_sync] {sync()} version(s) into the store")
