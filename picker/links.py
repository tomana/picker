"""Replace links atomically so concurrent syncs never see an unlink gap.
Broken-link checks are restricted to the owning type."""
import json
import os
from pathlib import Path


def place(link: Path, target: Path) -> None:
    """Point `link` at `target` (as a relative link), replacing it atomically."""
    link = Path(link)
    rel = os.path.relpath(target, link.parent)
    if link.is_symlink() and os.readlink(link) == rel:
        return
    tmp = link.with_name(f".{link.name}.{os.getpid()}.tmp")
    if tmp.is_symlink() or tmp.exists():
        tmp.unlink()
    tmp.symlink_to(rel)
    os.replace(tmp, link)


def broken(store: Path, type_: str) -> list[str]:
    out = []
    for d in Path(store).iterdir():
        try:
            if json.loads((d / "card.json").read_text()).get("type") != type_:
                continue
        except Exception:
            continue
        out += [str(p) for p in (d / "media").glob("*")
                if p.is_symlink() and not p.exists()]
    return out
