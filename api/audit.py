"""Join existing card/signal/queue/trace records by tokens; keep per-job output separate."""
import json
from pathlib import Path

from flask import Blueprint, abort, jsonify

from api.cards import read_card
from api.queue import _log_path
from core import queue as Q
from core import stores as ST
from core import trace as T

bp = Blueprint("audit", __name__)

LOG_MAX = 2 * 1024 * 1024


def _signals(cid: str) -> list[dict]:
    p = ST.card_dir(cid) / "signals.jsonl"
    out = []
    if p.is_file():
        for line in p.read_text(errors="replace").splitlines():
            try:
                out.append(json.loads(line))
            except json.JSONDecodeError:
                pass
    return out


def _say(rec: dict, skip=("ts", "src", "ev", "event", "id", "job", "card", "type")) -> str:
    """Retain every non-envelope field in the one-line rendering."""
    parts = []
    for k, v in rec.items():
        if k in skip or v in (None, "", [], {}):
            continue
        if isinstance(v, (dict, list)):
            v = json.dumps(v, ensure_ascii=False)
        parts.append(f"{k}={v}")
    return "  ".join(parts)


def _read_log(p: Path) -> dict:
    size = p.stat().st_size
    with open(p, "rb") as f:
        if size > LOG_MAX:
            f.seek(-LOG_MAX, 2)
        text = f.read().decode("utf-8", "replace")
    return {"path": str(p.relative_to(Q.ROOT) if p.is_relative_to(Q.ROOT) else p), "bytes": size,
            "cut": size > LOG_MAX, "text": text}


@bp.get("/api/cards/<cid>/audit")
def audit(cid):
    if not (ST.card_dir(cid) / "card.json").is_file():
        abort(404, description=f"no card {cid!r}")
    card = read_card(cid)
    jobs = [j for j in Q.jobs() if j["kind"] != "ping"
            and (j.get("result") == cid or j.get("card") == cid)]
    ids = {j["id"] for j in jobs}
    e = []

    lin = card.get("lineage") or {}
    e.append({"ts": card.get("created"), "src": "card", "ev": "created", "card": cid,
              "text": _say({"from": card.get("created_from"), "parent": lin.get("parent"),
                            "why": lin.get("why"), "origin": card.get("origin")})})
    for v in card.get("versions") or []:
        e.append({"ts": v.get("created"), "src": "card", "ev": f"v{v.get('n')}",
                  "card": cid, "text": _say({
                      "agent": v.get("agent"), "model": v.get("model"),
                      "parts": [p.get("id") for p in v.get("parts") or []],
                      "rationale": v.get("rationale")})})

    for s in _signals(cid):
        e.append({"ts": s.get("ts"), "src": "operator", "ev": s.get("kind"), "card": cid,
                  "text": _say(s, skip=("ts", "kind"))})

    for j in jobs:
        rel = "made it" if j.get("result") == cid else f"acted on it → {j.get('result')}"
        # Records without timestamps inherit the last known time and are marked approximate, not sorted at the epoch.
        last = j.get("created")
        for ev in Q.history(j["id"]):
            ts, approx = ev.get("ts"), False
            if ts is None:
                ts, approx = last, True
            last = ts
            e.append({"ts": ts, "approx": approx, "src": "queue", "ev": ev.get("event"),
                      "job": j["id"], "type": j["type"],
                      "text": (_say(ev, skip=("ts", "event", "id", "created", "type"))
                               + (f"  ({rel})" if ev.get("event") == "enqueue" else ""))})

    logs_seen = set()
    for t in T.read():
        if t.get("job") in ids or t.get("card") == cid:
            e.append({"ts": t.get("ts"), "src": t.get("src"), "ev": t.get("ev"),
                      "job": t.get("job"), "type": t.get("type"), "text": _say(t)})
            if t.get("ev") == "agent.start" and t.get("log"):
                logs_seen.add((t.get("job"), t["log"]))

    e.sort(key=lambda x: x.get("ts") or 0)

    # The agent's own words, per job: the conventional per-job log, plus any log a
    # trace line says an agent actually wrote to.
    logs = []
    for j in jobs:
        paths = [_log_path(j)] + [Path(p) for jid, p in logs_seen if jid == j["id"]]
        for p in dict.fromkeys(x for x in paths if x):
            if p.is_file():
                logs.append({"job": j["id"], "kind": j["kind"], "status": j["status"],
                             **_read_log(p)})

    return jsonify({
        "card": {"id": cid, "label": card.get("label"), "type": card.get("type")},
        "jobs": [{k: j.get(k) for k in ("id", "kind", "status", "card", "result",
                                        "text", "backend", "researcher", "why",
                                        "started", "ended")} for j in jobs],
        "entries": e,
        "logs": logs,
        "note": None if jobs else
            "made before the queue existed — no job, no agent log; what is known is "
            "the card's own record and what you did to it",
    })
