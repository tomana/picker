"""Serve captured inputs by stored hash, not current file contents."""
from flask import Blueprint, abort, jsonify

from core import receipts as R

bp = Blueprint("receipts", __name__)


@bp.get("/api/queue/<jid>/receipts")
def of_job(jid):
    if "/" in jid or ".." in jid:
        abort(404)
    return jsonify({"job": jid, "receipts": R.of_job(jid)})


@bp.get("/api/receipts/text/<sha>")
def text(sha):
    t = R.text(sha)
    if t is None:
        abort(404)
    return jsonify({"sha256": sha, "text": t})
