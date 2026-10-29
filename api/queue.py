"""Validate HTTP shapes here; core owns transitions and locking.
Cancel appends an event and never removes the job record."""
import json
import re
import time
from pathlib import Path

from flask import Blueprint, abort, jsonify, request, send_file

from core import agents as A
from core import config as CONFIG
from core import queue as Q
from core import stores as ST
# ONE decoder and one size cap for every image a browser sends, whether it lands on a
# card or on a request; a second copy here would be a second rule to keep in step.
from api.cards import ATTACH_MAX, _decode_data_url, _safe

bp = Blueprint("queue", __name__)

ROOT = CONFIG.get().research
DATA = CONFIG.get().data

# A draft can be edited and cancelled; anything a researcher has already taken cannot.
EDITABLE = ("queued",)


def _registry() -> list[dict]:
    """Route from manifests, not existing cards; a type with no cards must still have a runner."""
    try:
        return CONFIG.types()
    except Exception:
        return []


def _job_or_404(jid: str) -> dict:
    job = Q.get(jid)
    if job is None:
        abort(404, description=f"no job {jid!r}")
    return job


def _default_agent(type_: str) -> str:
    """The agent a job without one goes to: its runner's --agent, else the tab's first listed agent."""
    t = next((t for t in _registry() if t["type"] == type_), {}) or {}
    argv = t.get("start") or []
    return argv[argv.index("--agent") + 1] if "--agent" in argv[:-1] else (t.get("agents") or ["claude"])[0]


def _run_of(job: dict) -> dict | None:
    """Started jobs use traced model/effort; unstarted jobs use the current saved choice."""
    from core import agents as A, trace as T
    if job["status"] in ("queued", "waiting"):
        agent = job.get("backend") or _default_agent(job["type"])
        try:
            c = A.choice(agent)
        except Exception:
            return None
        return {"agent": agent, "model": job.get("model") or c.get("model"), "effort": c.get("effort"),
                "planned": True}
    r = T.agent_runs().get(job["id"])
    return {**r, "planned": False} if r else None


def _out(job: dict) -> dict:
    """Convert stored image names into URLs and use the shared issue shape for waits and failures."""
    names = job.get("attachments") or []
    out = {**job, "attachments": [f"/media/queue/{job['id']}/{n}" for n in names]}
    out["run"] = _run_of(job)
    w = job.get("waiting")
    if job["status"] == "waiting" and w:
        back = time.strftime("%H:%M", time.localtime(w.get("until") or 0))
        out["issue"] = {"level": "limited", "short": f"waiting for {w.get('agent')} · {back}",
                        "detail": w.get("why") or "",
                        "fix": f"tries again at {back} by itself — or hand it to another agent"}
    elif job["status"] == "failed":
        from core import agents as A
        stages = [e.get("text") for e in Q.history(job["id"]) if e.get("event") == "phase"]
        agent = job.get("backend") or (job.get("researcher") or ":").split(":")[-1]
        e = A.explain(job.get("why"), stages, agent)
        # Quota exhaustion or capacity warns rather than indicates broken wiring.
        limited = e["short"].startswith(("until ", "out of usage", "model busy"))
        out["issue"] = {"level": "limited" if limited else "failed", **e}
    return out


@bp.get("/api/queue")
def list_queue():
    """`?live=1` for what is still queued or running; what the header field draws.
    `?type=` to scope it, which is what a researcher asks before claiming."""
    live = request.args.get("live") in ("1", "true", "yes")
    # `open`: what is still the user's business; live, plus FAILED jobs until
    # they are retried or dismissed. The strip asks for this; failed is not finished.
    open_ = request.args.get("open") in ("1", "true", "yes")
    return jsonify({"queue": [_out(j) for j in
                              Q.jobs(type=request.args.get("type"), live_only=live,
                                     open_only=open_)]})


MAX_COUNT = 8          # results per press (the open card's spinner), one session


@bp.post("/api/queue")
def post_queue():
    body = request.get_json(silent=True) or {}
    type_, kind = body.get("type"), body.get("kind")
    known = {t["type"] for t in _registry()}
    if type_ not in known:
        abort(400, description=f"type must be one of {sorted(known)}")
    if kind not in Q.KINDS:
        abort(400, description=f"kind must be one of {sorted(Q.KINDS)}")
    # A ping is the wiring check's, enqueued by /api/agents/check with the runner it
    # starts in pings-only mode; one posted here would sit in the real queue.
    if kind == "ping":
        abort(400, description="pings come from POST /api/agents/check")
    # A kind that acts on a card needs one; a seed is the idea that has no parent yet.
    card = body.get("card")
    if kind != "seed" and not card:
        abort(400, description=f"{kind} needs a card")
    if card and not (ST.card_dir(str(card)) / "card.json").is_file():
        abort(404, description=f"no card {card!r}")
    # Validate every image before writing anything so one bad file rejects the entire request.
    raw = body.get("attachments") or []
    if not isinstance(raw, list) or len(raw) > 8:
        abort(400, description="attachments: a list of at most 8 data URLs")
    files = []
    for url in raw:
        blob, ext = _decode_data_url(str(url))
        if not blob:
            abort(400, description="empty attachment")
        if len(blob) > ATTACH_MAX:
            abort(413, description=f"at most {ATTACH_MAX // (1024 * 1024)}MB each")
        files.append((blob, ext))
    # Validate the displayed version by its actual number, including held tries, not by version count.
    version = body.get("version")
    if version is not None:
        try:
            version = int(version)
            vs = json.loads((ST.card_dir(str(card)) / "card.json").read_text()).get("versions") or []
            ns = {int(v.get("n") or i + 1) for i, v in enumerate(vs)}
        except (TypeError, ValueError, OSError):
            abort(400, description="version is a number")
        if not card or version not in (ns or {1}):
            abort(400, description=f"{card} has no version {version}")
    # Freeze the displayed bundle item, not merely its version.
    item = body.get("item")
    if item is not None and (not isinstance(item, str) or not re.fullmatch(r"[\w.-]{1,40}", item) or version is None):
        abort(400, description="item is an item id, sent with its version")
    # The part of a recording that was selected (a recording card's trim editor).
    try:
        trim = Q.clean_trim(body.get("trim"))
    except ValueError as e:
        abort(400, description=str(e))
    # Request count results in one shared session, not isolated jobs that cannot see each other's work.
    try:
        count = 1 if body.get("count") is None else int(body["count"])
    except (TypeError, ValueError):
        abort(400, description="count is a number")
    if not 1 <= count <= MAX_COUNT:
        abort(400, description=f"count is 1–{MAX_COUNT}")
    # Only manifest-declared methods may override the default work path.
    method = body.get("method")
    if method is not None:
        reg = next((t for t in _registry() if t.get("type") == type_), {})
        allowed = {m.get("id") for m in reg.get("methods") or []}
        if str(method) not in allowed:
            abort(400, description=f"method must be one of {sorted(allowed) or 'none for ' + str(type_)}")
    # Validate agent/model choices from stored discovery; never invoke discovery while enqueueing.
    from core import agents as A
    backend, model = body.get("backend") or None, body.get("model") or None
    if backend is not None and backend not in A.names():
        abort(400, description=f"backend must be one of {A.names()}")
    if model is not None:
        if not isinstance(model, str) or not re.fullmatch(r"[A-Za-z0-9._:-]{1,80}", model):
            abort(400, description="a model id is letters, digits and . _ : -")
        who = backend or _default_agent(type_)
        ids = {m.get("id") for m in A.cached_catalogue(who).get("models", [])}
        if ids and model not in ids and model != A.choice(who).get("model"):
            abort(400, description=f"{who} offers no model {model!r} (as ⚙ last found)")
    # Freeze the plugin's source interpretation at send time; refuse a version/item with nothing usable to hear.
    source = None
    if card and kind in ("revise", "inspire"):
        try:
            source = _hears(type_, card, {"card": card, "kind": kind, "version": version, "item": item, "trim": trim})
        except LookupError as e:
            abort(400, description=str(e))
    job = Q.enqueue(type=type_, kind=kind, card=card,
                    text=str(body.get("text") or ""),
                    backend=backend, group=body.get("group"),
                    attachments=files, version=version, item=item, source=source, trim=trim, count=count,
                    method=str(method) if method else None, model=model)
    return jsonify(_out(job)), 201


@bp.patch("/api/queue/<jid>")
def patch_queue(jid):
    """Reject late edits with 409; the core fold also ignores edits after claim."""
    job = _job_or_404(jid)
    if job["status"] not in EDITABLE:
        abort(409, description=f"job is {job['status']}, only {EDITABLE[0]} can be edited")
    body = request.get_json(silent=True) or {}
    if "text" not in body:
        abort(400, description="send {text}")
    Q.edit(jid, str(body["text"]))
    return jsonify(_out(Q.get(jid)))


@bp.delete("/api/queue/<jid>")
def delete_queue(jid):
    """Cancel. Appends an event; nothing is removed from the log."""
    job = _job_or_404(jid)
    if job["status"] not in ("queued", "running", "waiting", "paused"):
        abort(409, description=f"job is already {job['status']}")
    Q.cancel(jid)
    return jsonify(_out(Q.get(jid)))


# How many lines of the agent's own output a row's console shows. Enough to read what
# it is doing without shipping a multi-megabyte session transcript to a phone.
LOG_TAIL = 400


def _log_path(job: dict) -> Path | None:
    """Derive the job log from runner directory and job id; do not persist movable filesystem paths."""
    for t in _registry():
        if t["type"] == job["type"]:
            return (ROOT / t["researcher"]).parent / "logs" / f"queue_{job['id']}.log"
    return None


@bp.get("/api/queue/<jid>")
def get_job(jid):
    job = _job_or_404(jid)
    events = Q.history(jid)
    return jsonify({**_out(job), "events": events,
                    "stages": [{"text": e.get("text"), "ts": e.get("ts")}
                               for e in events if e.get("event") == "phase"]})


@bp.get("/api/queue/<jid>/log")
def job_log(jid):
    """Return a bounded tail with byte count and truncation status, not an unbounded transcript."""
    job = _job_or_404(jid)
    p = _log_path(job)
    if p is None or not p.is_file():
        return jsonify({"lines": [], "bytes": 0, "truncated": False,
                        "note": "no trace yet"})
    size = p.stat().st_size
    # Read the tail only. A long agent session is megabytes and the phone wants the end.
    with open(p, "rb") as f:
        if size > 256 * 1024:
            f.seek(-256 * 1024, 2)
            f.readline()                       # drop the partial first line
        chunk = f.read().decode("utf-8", "replace")
    lines = [l.rstrip() for l in chunk.splitlines()]
    return jsonify({"lines": lines[-LOG_TAIL:], "bytes": size,
                    "truncated": len(lines) > LOG_TAIL or size > 256 * 1024})


@bp.get("/media/queue/<jid>/<name>")
def job_media(jid, name):
    p = Q.media_dir(_safe(jid)) / _safe(name)
    if not p.is_file():
        abort(404)
    return send_file(p)


def _hears(type_: str, card: str, job: dict) -> dict | None:
    from api.cards import read_card
    from core import plugins as PG
    fn = PG.call(type_, "hears") if CONFIG.capability(type_, "hears") else None
    return fn(read_card(card, detail=True), job, PG.services()) if fn else None


@bp.get("/api/cards/<cid>/source")
def card_source(cid):
    """Interpret version/item/trim through the type plugin for each send.
    No capability returns null; an unusable source returns an error."""
    from api.cards import read_card
    card = read_card(_safe(cid))
    if card is None:
        abort(404)
    a = request.args
    try:
        version = int(a["version"]) if a.get("version") else None
        trim = Q.clean_trim({"start": float(a["start"]), "end": float(a["end"])}) if a.get("end") else None
    except (KeyError, TypeError, ValueError) as e:
        abort(400, description=f"version, start and end are numbers ({e})")
    item = a.get("item") or None
    if item is not None and not re.fullmatch(r"[\w.-]{1,40}", item):
        abort(400, description="item is an item id")
    out = {}
    for kind in ("inspire", "revise"):
        try:
            out[kind] = _hears(card.get("type"), cid, {"card": cid, "kind": kind, "version": version,
                                                         "item": item, "trim": trim})
        except LookupError as e:
            out[kind] = {"error": str(e)}
    return jsonify(out)


@bp.get("/api/types")
def list_types():
    """Use manifests for routing and the index for counts, including declared types with no cards."""
    from api.cards import type_counts
    counts = type_counts()
    out = [{**t, "cards": counts.pop(t["type"], 0)} for t in _registry()]
    # A type in the store that no manifest declares is a real problem; a card
    # nothing can fulfil; so it is reported rather than hidden.
    out += [{"type": t, "label": t, "researcher": None, "cards": n,
             "unregistered": True} for t, n in sorted(counts.items())]
    return jsonify({"types": out})


def _picked_model(job: dict, agent: str | None, body: dict):
    """The model a resume or retry names (Q.KEEP when none), and why it can't be used, if it can't."""
    if "model" not in body:
        return Q.KEEP, None
    model = body["model"]
    name = agent or job.get("backend") or (job.get("researcher") or ":").split(":")[-1].split("@")[-1]
    return model, (A.validate(name, model, None, cat=A.cached_catalogue(name)) if model is not None else None)


@bp.post("/api/queue/<jid>/retry")
def retry(jid):
    """Retry the same job immediately, optionally with another agent; preserve prior-attempt context."""
    job = _job_or_404(jid)
    if job["status"] not in ("waiting", "failed"):
        return jsonify({"ok": False, "err": f"a {job['status']} job is not retried"}), 409
    agent = (request.get_json(silent=True) or {}).get("agent")
    t = next((t for t in _registry() if t["type"] == job["type"]), None)
    if agent and agent not in ((t or {}).get("agents") or []):
        return jsonify({"ok": False, "err": f"{job['type']} does not run {agent!r}"}), 400
    model, why = _picked_model(job, agent, request.get_json(silent=True) or {})
    if why:
        return jsonify({"ok": False, "err": why}), 400
    Q.requeue(jid, backend=agent, model=model)
    from api.researchers import start_for
    body, code = start_for(t, job) if t else ({"ok": False, "err": "no such type"}, 404)
    runner = ("started" if code == 202 else
              "the running researcher takes it within 30 s" if code == 409 else
              body.get("err"))
    return jsonify({"ok": True, "job": _out(Q.get(jid)), "runner": runner})


@bp.post("/api/queue/<jid>/pause")
def pause(jid):
    """Prevent claims and stop running work through cancellation polling; resume starts a new attempt."""
    job = _job_or_404(jid)
    if job["status"] not in ("queued", "waiting", "running"):
        return jsonify({"ok": False, "err": f"a {job['status']} job is not paused"}), 409
    Q.pause(jid)
    return jsonify({"ok": True, "job": _out(Q.get(jid))})


@bp.post("/api/queue/<jid>/resume")
def resume(jid):
    """Requeue and wake the owning lane, optionally with another supported agent."""
    job = _job_or_404(jid)
    if job["status"] != "paused":
        return jsonify({"ok": False, "err": f"a {job['status']} job is not paused"}), 409
    agent = (request.get_json(silent=True) or {}).get("agent")
    t = next((t for t in _registry() if t["type"] == job["type"]), None)
    if agent and agent not in ((t or {}).get("agents") or []):
        return jsonify({"ok": False, "err": f"{job['type']} does not run {agent!r}"}), 400
    model, why = _picked_model(job, agent, request.get_json(silent=True) or {})
    if why:
        return jsonify({"ok": False, "err": why}), 400
    Q.resume(jid, backend=agent, model=model)
    if t:
        from api.researchers import start_for
        start_for(t, Q.get(jid))
    return jsonify({"ok": True, "job": _out(Q.get(jid))})


@bp.post("/api/queue/<jid>/dismiss")
def dismiss(jid):
    """Put a failed job away. It stays in the log, and in the card's audit trail."""
    job = _job_or_404(jid)
    if job["status"] != "failed":
        return jsonify({"ok": False, "err": "only a failed job is dismissed"}), 409
    Q.dismiss(jid)
    return jsonify({"ok": True})
