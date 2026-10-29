"""Partial updates leave unsupplied keys unchanged; core owns log folding."""
from flask import Blueprint, abort, jsonify, request

from core import prefs as P

bp = Blueprint("prefs", __name__)


@bp.get("/api/prefs")
def read():
    return jsonify(P.fold())


@bp.patch("/api/prefs")
def write():
    body = request.get_json(silent=True)
    if not isinstance(body, dict) or not body:
        abort(400, description="a JSON object of {key: value}")
    bad = [k for k in body if k not in P.KEYS]
    if bad:
        abort(400, description=f"unknown key(s) {bad}; one of {sorted(P.KEYS)}")
    routed = [k for k in body if k in P.ROUTED]
    if routed:
        abort(400, description=f"{routed} are written through their own route "
                               f"(PUT /api/agents/<name>, …), which validate them")
    for k, v in body.items():
        try:
            P.set(k, v)
        except ValueError as e:
            abort(400, description=str(e))
    return jsonify(P.fold())
