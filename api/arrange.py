"""Validate refs on write and resolve on read; missing stored clips remain visible."""
from flask import Blueprint, abort, jsonify, request

from core import arrange as A
from core import config as C

bp = Blueprint("arrange", __name__)

MAX_NAME = 80
# A lane count, not a limit on ambition: the voice block draws eight rows, so a clip
# on track 12 would be placed somewhere nothing renders.
TRACKS = A.TRACKS


def _num(v, default=None):
    try:
        return float(v)
    except (TypeError, ValueError):
        return default


def _dress(a: dict) -> dict:
    out = {**a, "clips": []}
    for c in a["clips"]:
        got = A.resolve(c.get("ref") or {})
        row = {**c}
        if got:
            row["audio"] = got["audio"]
            row["label"] = c.get("label") or got["label"]
            row["name"] = got.get("name")
            row["archived"] = got["archived"]
        else:
            row["missing"] = True
            row["label"] = c.get("label") or "(no longer in the store)"
        out["clips"].append(row)
    return out


@bp.get("/api/arrangements")
def list_arrangements():
    t = request.args.get("type")
    return jsonify({"arrangements": [_dress(a) for a in A.arrangements(type=t)]})


@bp.post("/api/arrangements")
def create():
    body = request.get_json(silent=True) or {}
    t = body.get("type")
    if not t:
        abort(400, description="type is required")
    # Only manifests declaring timeline capability may create arrangements.
    if not C.capability(t, "timeline"):
        abort(400, description=f"{t} has no timeline (its manifest's capabilities.timeline)")
    name = str(body.get("name") or "")[:MAX_NAME]
    return jsonify(_dress({**A.create(type=t, name=name), "clips": [], "length": 0}))


@bp.get("/api/arrangements/<aid>")
def one(aid):
    a = A.get(aid)
    if a is None:
        abort(404)
    return jsonify(_dress(a))


@bp.patch("/api/arrangements/<aid>")
def patch(aid):
    if A.get(aid) is None:
        abort(404)
    name = (request.get_json(silent=True) or {}).get("name")
    if name is None:
        abort(400, description="name is required")
    A.rename(aid, str(name)[:MAX_NAME])
    return jsonify(_dress(A.get(aid)))


@bp.delete("/api/arrangements/<aid>")
def remove(aid):
    if A.get(aid) is None:
        abort(404)
    A.delete(aid)
    return jsonify({"deleted": aid})


@bp.put("/api/arrangements/<aid>/clips")
def put_clip(aid):
    """Require a resolvable store ref even on moves; reject invalid parts before they become missing clips."""
    if A.get(aid) is None:
        abort(404)
    body = request.get_json(silent=True) or {}
    ref = body.get("ref") or {}
    if not ref.get("card") or not ref.get("part"):
        abort(400, description="ref needs card and part")
    got = A.resolve(ref)
    if not got:
        abort(400, description=f"no such part: {ref}")

    fields = {}
    for k in ("start", "len", "offset", "gain", "fadeIn", "fadeOut", "src_len"):
        v = _num(body.get(k))
        if v is not None:
            fields[k] = v
    track = _num(body.get("track"), 0)
    fields["track"] = int(max(0, min(TRACKS - 1, track)))
    # No clip length means play the entire source, not a zero-length clip.
    if "len" not in fields:
        fields["len"] = fields.get("src_len") or 0
    fields["label"] = str(body.get("label") or got["label"])[:MAX_NAME]

    cid = A.put_clip(aid, ref=ref, clip=body.get("clip"), **fields)
    return jsonify({**_dress(A.get(aid)), "clip": cid})


# Source-length rendering belongs to the type plugin, not generic arrangement routes.


@bp.delete("/api/arrangements/<aid>/clips/<cid>")
def del_clip(aid, cid):
    if A.get(aid) is None:
        abort(404)
    A.unclip(aid, cid)
    return jsonify(_dress(A.get(aid)))
