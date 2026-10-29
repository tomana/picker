"""Project research versions into the store using relative media links."""
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
TYPE = "visual"


def project(runs: Path, store: Path, type_: str = TYPE) -> int:
    """Every runs/<card>/ with a meta.json into store/<card>/card.json; returns how many versions were new."""
    from picker import links
    made = 0
    for meta_f in sorted(Path(runs).glob("*/meta.json")):
        cdir, meta = meta_f.parent, json.loads(meta_f.read_text())
        home = Path(store) / cdir.name
        versions = []
        for vf in sorted(cdir.glob("v*/version.json"), key=lambda p: int(p.parent.name[1:])):
            v = json.loads(vf.read_text())
            media = {}
            (home / "media").mkdir(parents=True, exist_ok=True)
            for k, name in v["media"].items():
                links.place(home / "media" / f"{v['id']}__{name}", vf.parent / name)
                media[k] = f"media/{v['id']}__{name}"
            versions.append({**v, "media": media})
        if not versions:
            continue
        old = home / "card.json"
        was = json.loads(old.read_text()) if old.is_file() else {}
        made += len(versions) - len(was.get("versions") or [])
        card = {"id": cdir.name, "type": type_, "label": meta["label"], "created": meta["created"],
                "agent": versions[0].get("agent"), "model": None, "effort": None,
                "narrative": {"rationale": versions[0].get("rationale", "")},
                "lineage": {"parent": meta.get("parent"), "refs": [], "why": None},
                "origin": {"source": f"runs/{cdir.name}", "job": meta.get("job")},
                "versions": versions, "media": versions[-1]["media"]}
        if card != was:
            home.mkdir(parents=True, exist_ok=True)
            tmp = home / "card.json.tmp"
            tmp.write_text(json.dumps(card, indent=1))
            tmp.replace(old)
    return made


if __name__ == "__main__":
    from picker import sdk
    print(f"[sync] {project(HERE / 'runs', sdk.store(TYPE))} new version(s) — OK")
    sys.exit(0)
