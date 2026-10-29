"""Store structural part refs, never media URLs; resolve at the read boundary.
Times are seconds; clip events upsert positions."""
import fcntl
import json
import time
import uuid
from pathlib import Path

from . import stores as ST

NAME = "arrangements.jsonl"                       # each type's, beside its cards (core/stores.py)

# A clip's own fields, beyond `ref`. `track` is the lane; `start`/`len` place it;
# `offset` is where playback starts INSIDE the source; the rest shape it.
CLIP_FIELDS = ("track", "start", "len", "offset", "gain", "fadeIn", "fadeOut",
               "src_len", "label")
TRACKS = 8          # the lane count the voice block already draws


def _append(rec: dict, root: Path | None = None, *, type_: str | None = None) -> None:
    """A timeline's line: its `create` to its type's log, the rest where its `create` went."""
    rec = {**rec, "ts": time.time()}
    p = ST.log(NAME, type_=type_, id_=rec.get("id"), root=root)
    p.parent.mkdir(parents=True, exist_ok=True)
    with open(p, "a") as f:
        fcntl.flock(f, fcntl.LOCK_EX)
        f.write(json.dumps(rec, ensure_ascii=False) + "\n")
        f.flush()
        fcntl.flock(f, fcntl.LOCK_UN)


def _num(v, default=0.0):
    try:
        return float(v)
    except (TypeError, ValueError):
        return default


def create(*, type: str, name: str = "", root: Path | None = None) -> dict:
    a = {"id": uuid.uuid4().hex[:12], "created": time.time(),
         "type": type, "name": name or "arrangement"}
    _append({"event": "create", **a}, root, type_=type)
    return {**a, "clips": []}


def rename(aid: str, name: str, *, root: Path | None = None) -> None:
    _append({"event": "rename", "id": aid, "name": name}, root)


def put_clip(aid: str, *, ref: dict, clip: str | None = None,
             root: Path | None = None, **fields) -> str:
    """Require a structural ref on both add and move so each event remains independently replayable."""
    for k in ("card", "part"):
        if not ref.get(k):
            raise ValueError(f"ref needs {k}")
    cid = clip or uuid.uuid4().hex[:8]
    rec = {"event": "clip", "id": aid, "clip": cid,
           "ref": {"card": ref["card"], "version": ref.get("version"),
                   "part": ref["part"]}}
    for k in CLIP_FIELDS:
        if k in fields and fields[k] is not None:
            rec[k] = fields[k]
    _append(rec, root)
    return cid


def unclip(aid: str, clip: str, *, root: Path | None = None) -> None:
    _append({"event": "unclip", "id": aid, "clip": clip}, root)


def delete(aid: str, *, root: Path | None = None) -> None:
    _append({"event": "delete", "id": aid}, root)


def _lines(root: Path | None):
    """Every type's log, one after another: a timeline's lines are all in one."""
    for p in ST.logs(NAME, root):
        if p.exists():
            for line in p.read_text().splitlines():
                if line.strip():
                    yield line


def fold(root: Path | None = None) -> dict:
    """Skip unknown/malformed records rather than letting one record break reads."""
    out: dict[str, dict] = {}
    for line in _lines(root):
        try:
            rec = json.loads(line)
        except json.JSONDecodeError:
            continue
        aid, ev = rec.get("id"), rec.get("event")
        if not aid:
            continue
        if ev == "create":
            out[aid] = {"id": aid, "created": rec.get("created", rec.get("ts")),
                        "type": rec.get("type"), "name": rec.get("name", ""),
                        "clips": {}}
            continue
        a = out.get(aid)
        if a is None:            # an event for something never created, or deleted
            continue
        if ev == "rename":
            a["name"] = rec.get("name", a["name"])
        elif ev == "clip":
            c = a["clips"].setdefault(rec["clip"], {"id": rec["clip"]})
            c["ref"] = rec.get("ref") or c.get("ref")
            for k in CLIP_FIELDS:
                if k in rec:
                    c[k] = rec[k]
        elif ev == "unclip":
            a["clips"].pop(rec.get("clip"), None)
        elif ev == "delete":
            out.pop(aid, None)
    for a in out.values():
        a["clips"] = sorted(a["clips"].values(),
                            key=lambda c: (_num(c.get("track")), _num(c.get("start"))))
        a["length"] = round(max([0.0] + [_num(c.get("start")) + _num(c.get("len"))
                                         for c in a["clips"]]), 3)
    return out


def get(aid: str, *, root: Path | None = None) -> dict | None:
    return fold(root).get(aid)


def arrangements(*, type: str | None = None, root: Path | None = None) -> list[dict]:
    rows = [a for a in fold(root).values() if type is None or a["type"] == type]
    return sorted(rows, key=lambda a: a.get("created") or 0)


def resolve(ref: dict, *, store: Path | None = None) -> dict | None:
    """Return None for unresolved refs; convert stored media paths only at this boundary."""
    cid = str(ref.get("card", ""))
    d = store / cid if store else ST.card_dir(cid)
    cj = d / "card.json"
    if not cj.is_file():
        return None
    try:
        card = json.loads(cj.read_text())
    except Exception:
        return None
    versions = card.get("versions") or []
    want = ref.get("version")
    ver = None
    if want is not None:
        ver = next((v for v in versions
                    if v.get("id") == f"v{want}" or v.get("n") == want), None)
    ver = ver or (versions[-1] if versions else None)
    if not ver:
        return None
    part = next((p for p in (ver.get("parts") or [])
                 if p.get("id") == ref.get("part")), None)
    if not part:
        return None
    url = part.get("audio")
    if isinstance(url, str) and not url.startswith(("/", "http")):
        url = f"/media/{card['id']}/{url.split('/')[-1]}"
    return {"card": card["id"], "card_label": card.get("label") or card["id"], "name": card.get("name"),
            "version": ver.get("id"), "part": part.get("id"),
            "label": f"{card.get('label') or card['id']} · {part.get('label') or part.get('id')}",
            "audio": url, "enabled": part.get("enabled", True),
            "archived": bool(part.get("archived")),
            # Keep the source path relative to the card so export and source-length rendering can resolve it.
            "src": part.get("src")}
