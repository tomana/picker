"""Idle requires no live attempt or lane runner, even when a job already says paused."""
from __future__ import annotations

from flask import Blueprint, jsonify, request

from core import gate as G
from core import queue as Q

bp = Blueprint("gate", __name__)


def idle() -> dict:
    from api.researchers import _types, alive
    # A paused job can still own a live attempt until its process stops.
    running = [j["id"] for j in Q.jobs() if j.get("live") is not None]
    lanes = (None, *Q.AGENT_LANES)
    runners = [f"{t['type']}{'@' + lane if lane else ''}" for t in _types() for lane in lanes if alive(t, lane)]
    return {"idle": not running and not runners, "running": running, "runners": runners}


@bp.get("/api/gate")
def get_gate():
    return jsonify({"closed": G.state(), "idle": idle()})


@bp.post("/api/gate")
def post_gate():
    body = request.get_json(silent=True) or {}
    if not isinstance(body.get("closed"), bool):
        return jsonify({"ok": False, "err": "closed is true or false"}), 400
    if body["closed"]:
        G.close(str(body.get("why") or ""))
    else:
        G.open_()
        # the doors open: whatever queued meanwhile is started now, not at the scheduler's next minute
        try:
            from core import auto as AU
            from api.researchers import _types, start_runner
            AU.wake(_types(), lambda t, lane: start_runner(t, lane=lane))
        except Exception as e:                              # the scheduler starts them at its next look anyway
            print(f"[gate] open: the wake failed ({e}); the scheduler starts them at its next look", flush=True)
    return jsonify({"ok": True, "closed": G.state(), "idle": idle()})
