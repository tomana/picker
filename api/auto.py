"""Update only supplied settings under the decision lock; tab edits must not overwrite other tabs."""
import time

from flask import Blueprint, jsonify, request

from api.researchers import _types
from core import agents as A
from core import auto as AU
from core import prefs as P

bp = Blueprint("auto", __name__)


def _survey(s: dict, type_: str | None = None) -> dict | None:
    """Use the requested tab's latest survey and active job, or the first active tab if unspecified."""
    from core import queue as Q
    from core import survey as SV
    from api.cards import read_card
    if not type_ and not s.get("types"):
        return None
    t = type_ or s["types"][0]
    jobs = list(Q.fold().values())
    running = next((j for j in jobs if j.get("group") == AU.GROUP and j.get("kind") == "survey"
                    and j.get("type") == t and j["status"] in ("queued", "running", "waiting")),
                   None)
    sv = SV.latest(t)
    out = {"type": t, "running": running and {"job": running["id"], "status": running["status"],
                                              "phase": running.get("phase")}}
    if sv:
        asked = sv.get("asked") or sv["ts"]
        had = AU.had(t, jobs)                  # Mark cards already taken since this order was requested.
        order = []
        for o in sv.get("order") or []:
            c = read_card(o["card"]) or {}
            order.append({**o, "label": c.get("label") or o["card"], "name": c.get("name"),
                          "revised": had.get(o["card"], 0) >= asked})
        out.update(criterion=sv.get("criterion"), ts=sv.get("ts"), job=sv.get("job"),
                   order=order, report=sv.get("report") or "")
    return out


def _auto_types() -> list:
    """Offer only types with a runner and a model agent; tool-only types cannot launch AUTO model work."""
    models = set(A.names())
    return [t["type"] for t in _types() if t.get("start") and models & set(t.get("agents") or [])]


def _body(type_: str | None = None):
    s = AU.settings()
    mine = type_ if type_ in _auto_types() else None
    return {"settings": s, "state": AU.state, "agents": A.names(),
            "types": _auto_types(),
            "survey": _survey(s, mine),
            # Expose the same per-kind lead text that queued briefs receive.
            **({"lead": {k: AU._lead(mine, k) for k in AU.KINDS}} if mine else {})}


@bp.get("/api/auto")
def get_auto():
    return jsonify(_body(request.args.get("type") or None))


@bp.put("/api/auto")
def put_auto():
    # Serialize preference changes with scheduler decisions so a decision cannot land against replaced settings.
    with AU.settings_lock:
        return _put_auto(request.get_json(silent=True) or {})


def _put_auto(body: dict):
    s = AU.settings()
    new = {**s, **{k: body[k] for k in AU.DEFAULTS if k in body and k != "tabs"}}
    if new["agent"] not in A.names():
        return jsonify({"ok": False, "err": f"agent is one of {A.names()}"}), 400
    if "agent" in body and body["agent"] != s["agent"] and "model" not in body:
        new["model"] = None                                    # another agent: its own model unless one is named
    if new["model"] is not None:
        why = A.validate(new["agent"], new["model"], None, cat=A.cached_catalogue(new["agent"]))
        if why:
            return jsonify({"ok": False, "err": why}), 400
    own = {k: body[k] for k in AU.TAB if k in body}
    if own:
        t = body.get("for")
        if not isinstance(t, str) or t not in _auto_types():
            return jsonify({"ok": False, "err": f"a tab's own settings need `for`, one of {_auto_types()}"}), 400
        if "kinds" in own and not (isinstance(own["kinds"], list) and set(own["kinds"]) <= set(AU.KINDS)):
            return jsonify({"ok": False, "err": f"kinds are from {list(AU.KINDS)}"}), 400
        for k in ("keep",):
            if k in own and not isinstance(own[k], bool):
                return jsonify({"ok": False, "err": f"{k} is true or false"}), 400
        for k in ("comment", "criterion"):
            if k in own and not isinstance(own[k], str):
                return jsonify({"ok": False, "err": f"{k} is text"}), 400
        # A new pass makes every tab card due again from this moment; a comment alone only changes AUTO's words.
        fresh = {} if set(own) == {"comment"} else {"since": time.time()}
        new["tabs"] = {**s["tabs"], t: AU.clean_tab({**AU.tab(s, t), **own, **fresh})}
    known = set(_auto_types())
    if not isinstance(new["types"], list) or not set(new["types"]) <= known:
        return jsonify({"ok": False, "err": f"types are from {sorted(known)}"}), 400
    new["on"] = bool(new["on"])
    P.set("auto", new)
    if new["on"] and (not s["on"] or set(new["types"]) - set(s["types"])):
        AU.kick()                       # the first job now, not at the next minute
    return jsonify({"ok": True, **_body(body.get("for") if isinstance(body.get("for"), str) else None)})


@bp.post("/api/auto/kick")
def kick():
    """An AUTO job ended (its runner says so): look for the next one now."""
    AU.kick()
    return jsonify({"ok": True})


@bp.post("/api/auto/survey")
def survey_again():
    """Begin a new pass, invalidating the old order and making the requested tabs' cards due again."""
    body = request.get_json(silent=True) or {}
    with AU.settings_lock:
        s = AU.settings()
        mine = [body["for"]] if isinstance(body.get("for"), str) and body["for"] in _auto_types() else s["types"]
        P.set("auto", {**s, "tabs": {**s["tabs"], **{t: {**AU.tab(s, t), "since": time.time()} for t in mine}}})
    return jsonify({"ok": True, **_body(body.get("for") if isinstance(body.get("for"), str) else None)})


@bp.get("/api/auto/made")
def made():
    from core import queue as Q
    from api.cards import read_card
    t = request.args.get("type") or ""
    try:
        limit = max(1, min(500, int(request.args.get("limit") or 24)))
    except ValueError:
        limit = 24
    from core import autolog as AL
    AU.reconcile(t)                                   # settle what has ended, on the look
    jobs = [j for j in Q.fold().values() if j.get("group") == AU.GROUP and j.get("type") == t
            and j.get("kind") in AU.KINDS]
    now = [{"job": j["id"], "card": j.get("card"), "kind": j.get("kind"), "status": j["status"],
            "phase": j.get("phase"), "agent": j.get("backend"), "started": j.get("started"),
            "created": j.get("created"),
            "label": (read_card(j["card"]) or {}).get("label") if j.get("card") else None}
           for j in jobs if j["status"] in ("queued", "running", "waiting")]
    by_job = {j["id"]: j for j in jobs}
    out = []
    ever = [e for e in AL.read(t) if e.get("event") == "made"]
    for e in reversed(ever):
        c = read_card(e["card"]) if e.get("card") else None
        if not c:
            continue
        v = next((x for x in [*(c.get("versions") or []), *(c.get("held") or [])] if x.get("n") == e.get("version")), None)
        m = (v or {}).get("media") or {}
        j = by_job.get(e.get("job")) or {}
        out.append({"job": e.get("job"), "card": e["card"], "label": c.get("label") or e["card"], "name": c.get("name"),
                    "n": e.get("version"), "vid": v and v.get("id"), "still": m.get("still") or m.get("poster"),
                    "audio": m.get("ab") or m.get("audio"),          # a version that sounds plays in its row: its A/B, else its mix
                    "vote": (v or {}).get("vote"), "held": bool(v) and v not in (c.get("versions") or []),
                    "kind": j.get("kind"), "agent": j.get("backend"), "ts": e.get("ts")})
        if len(out) >= limit:
            break
    # Total counts all outcomes, not just this response's limited page.
    return jsonify({"type": t, "making": now, "made": out, "total": len(ever),
                    "why": (AU.state.get("of") or {}).get(t) or AU.state.get("why")})
