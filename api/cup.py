"""Judge folded visible cards without restoring or archiving them.
Inline only fields needed for current decisions."""
from flask import Blueprint, abort, jsonify, request

from api.cards import read_card
from core import catalog as CAT
from core import cup as C

bp = Blueprint("cup", __name__)


def _candidates(type: str) -> list[dict]:
    """Use folded cards from the index; raw card files lack the effective archive and vote state."""
    rows = [c for cid, d, st in CAT.cards() for c in [read_card(cid, d=d, stamp=st)]
            if c is not None and c.get("type") == type]
    rows.sort(key=lambda c: c.get("created") or 0)
    return rows


def _card(cid: str) -> dict:
    """Project bracket fields only; full signals and part trees would multiply the response size."""
    c = read_card(cid)
    if c is None:
        return {"id": cid, "label": cid, "missing": True}
    # Use the grid's visible version and mix so sound-only cards remain judgeable.
    vs = c.get("versions") or []
    shown = next((v for v in reversed(vs) if (v.get("vote") or 0) >= 0), vs[-1] if vs else {})
    # Keep the grid's stable short name after a card leaves the grid; trim versions to vote and first part.
    trim = [{"n": v.get("n"), "vote": v.get("vote") or 0,
             "parts": [{"id": p.get("id"), "kind": p.get("kind")} for p in (v.get("parts") or [])[:1]]}
            for v in vs]
    return {"id": c["id"], "label": c.get("label") or c["id"], "name": c.get("name"), "versions": trim,
            "type": c.get("type"), "vote": c.get("vote", 0),
            "archived": bool(c.get("archived")),
            "audio": (shown.get("media") or {}).get("audio") or (c.get("media") or {}).get("audio"),
            "pools": c.get("pools") or [],
            "media": c.get("media") or {},
            "why": (c.get("lineage") or {}).get("why") or ""}


def _inflate(st: dict) -> dict:
    ids = {cid for g in st.get("groups") or [] for cid in g}
    ids |= set(st.get("advancers") or [])
    if st.get("winner"):
        ids.add(st["winner"])
    return {**st, "cards": {cid: _card(cid) for cid in sorted(ids)}}


def _ranking(cup_id: str) -> list[dict]:
    """The finished cup's every card, best first (core/cup.ranking); a shared place by the card's vote,
    then its name."""
    st = C.state(cup_id) or {}
    rows = [{"place": p, "card": _card(cid)} for p, cid in
            C.ranking(st.get("groups") or [], st.get("advancers") or [], st.get("rounds") or [])]
    rows.sort(key=lambda r: (r["place"], -(r["card"].get("vote") or 0), r["card"].get("label") or ""))
    return rows


@bp.get("/api/cup")
def status():
    """Return the current or latest cup and candidate count even before any draw exists."""
    want = request.args.get("type")
    if not want:
        abort(400, description="type required")
    rows = C.cups(type=want)
    live = rows[0] if rows and not rows[0].get("winner") else None    # a newer cup supersedes an unfinished one
    last = next((r for r in rows if r.get("winner")), None)
    return jsonify({
        "type": want,
        "candidates": len(C.judgeable_of(_candidates(want))),
        "cup": _inflate(live) if live else None,
        "last": ({"id": last["id"], "winner": last["winner"],
                  "card": _card(last["winner"]), "ts": last.get("ts"),
                  "ranking": _ranking(last["id"])}
                 if last else None),
        "played": len(rows),
    })


@bp.post("/api/cup")
def open_cup():
    body = request.get_json(silent=True) or {}
    want = body.get("type")
    if not want:
        abort(400, description="type required")
    rows = _candidates(want)
    keep = set(C.judgeable_of(rows))
    members = [c for c in rows if c["id"] in keep]
    if len(members) < 2:
        abort(400, description=f"{want} has nothing to judge")
    cid = C.open_cup(type=want, groups=C.seed(members))
    return jsonify(_inflate(C.state(cid)))


@bp.get("/api/cup/<cid>")
def get_cup(cid):
    st = C.state(cid)
    if st is None:
        abort(404)
    return jsonify(_inflate(st))


@bp.post("/api/cup/<cid>/pick")
def post_pick(cid):
    st = C.state(cid)
    if st is None:
        abort(404)
    body = request.get_json(silent=True) or {}
    g, picks = body.get("group"), body.get("picks") or []
    if g is None or not isinstance(picks, list):
        abort(400, description="group and picks required")
    try:
        members = set(st["groups"][int(g)])
    except (IndexError, ValueError, TypeError):
        abort(400, description=f"no group {g!r}")
    # A pick that names a card outside its own group would put a stranger in the
    # knockout, and the bracket would replay it for ever.
    stray = [p for p in picks if p not in members]
    if stray:
        abort(400, description=f"not in group {g}: {stray}")
    C.pick(cid, int(g), picks)
    return jsonify(_inflate(C.state(cid)))


@bp.post("/api/cup/<cid>/duel")
def post_duel(cid):
    st = C.state(cid)
    if st is None:
        abort(404)
    body = request.get_json(silent=True) or {}
    a, b, w = body.get("a"), body.get("b"), body.get("winner")
    if not (a and b and w):
        abort(400, description="a, b and winner required")
    if w not in (a, b):
        abort(400, description="winner must be a or b")
    # Reject stale-tab answers for any duel other than the bracket's current one.
    want = (st.get("next") or {}).get("duel")
    if not want or {a, b} != {want["a"], want["b"]}:
        abort(409, description="that is not the current duel")
    C.duel(cid, a, b, w)
    return jsonify(_inflate(C.state(cid)))
