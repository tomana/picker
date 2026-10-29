"""Researchers own card.json; this layer appends and folds signals.
Type behavior belongs in plugins; convert media paths only at the HTTP boundary."""
import json
import os
import re
from pathlib import Path

from flask import Blueprint, abort, jsonify, request, send_file

from core import catalog as CAT
from core import config as CONFIG
from core import signals as SIG
from core import jsonl as J
from core import queue as Q
from core import stores as ST

bp = Blueprint("cards", __name__)

ID_OK = set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-")

# Key cached cards by file mtimes in ns, never directory mtime; signal appends do not change the directory.
# Reuse index stamps when available to avoid restatting every card.
_cache: dict[str, tuple[int, dict]] = {}


def _stamp(d: Path) -> int:
    """The newest of the card's two files' mtimes, ns; 0 when it has no card.json (not a card)."""
    newest = 0
    for name in ("card.json", "signals.jsonl"):
        try:
            newest = max(newest, os.stat(d / name).st_mtime_ns)
        except OSError:
            if name == "card.json":
                return 0
    return newest


def _safe(part: str) -> str:
    if not part or part in (".", "..") or not set(part) <= ID_OK:
        abort(400, description=f"bad name {part!r}")
    return part


def _urls(card: dict, cid: str) -> None:
    """Convert only declared media fields; arbitrary nested strings are not paths.
    Stored paths stay relative so stores can move."""
    def fix(v):
        return f"/media/{cid}/{v.split('/')[-1]}" if isinstance(v, str) and not v.startswith(("/", "http")) else v
    def fix_media(d):
        for k, v in (d.get("media") or {}).items():
            if k == "views" and isinstance(v, list):
                # Render slug and face are labels, not media paths.
                for view in v:
                    for kk in ("still", "gif"):
                        if kk in view:
                            view[kk] = fix(view[kk])
            else:
                d["media"][k] = fix(v)
    fix_media(card)
    for ver in card.get("versions") or []:
        fix_media(ver)
        for part in ver.get("parts") or []:
            for k in ("src", "audio"):
                if k in part:
                    part[k] = fix(part[k])
        # Item media and parts use the same path rules as their enclosing version.
        for item in ver.get("items") or []:
            fix_media(item)
            for part in item.get("parts") or []:
                for k in ("src", "audio"):
                    if k in part:
                        part[k] = fix(part[k])


_fold = SIG.fold


def _cut_out(v: dict) -> tuple[list[dict], list[str]]:
    """Keep audible bands in source order and removed band ids in sorted order."""
    bands = [p for p in v.get("parts") or [] if p.get("kind") == "voice" and p.get("audio")]
    return ([p for p in bands if not p.get("archived")],
            sorted(p["id"] for p in bands if p.get("archived")))


def _cut_mix(v: dict, cid: str) -> None:
    """Use a cut-aware URL with cut list and content identity; preserve audio_full.
    All bands removed or a missing kept band makes audio unavailable, never silently incomplete."""
    m = v.get("media") or {}
    if not m.get("audio") or v.get("n") is None:
        return
    keep, cut = _cut_out(v)
    if not cut:
        return
    m["audio_full"] = m["audio"]
    m["audio"] = None
    if keep:
        files, missing, key = _mix_plan(cid, v["n"], keep)
        if missing:
            m["audio_missing"] = missing
        else:
            m["audio"] = f"/api/cards/{cid}/mix?version={v['n']}&cut={','.join(cut)}&k={key}"


def read_card(cid: str, *, detail: bool = False, d: Path | str | None = None, stamp: int | None = None) -> dict | None:
    # `d`: its folder, and `stamp` its files' (_stamp), when the caller has them (a walk of the index)
    d = Path(d) if d else ST.card_dir(cid)
    if stamp is None:
        stamp = _stamp(d)
    if not stamp:
        return None
    key = f"{cid}:{detail}"
    hit = _cache.get(key)
    if hit and hit[0] == stamp:
        return hit[1]
    try:
        card = json.loads((d / "card.json").read_text())
    except FileNotFoundError:
        return None
    _urls(card, cid)
    signals = []
    sp = d / "signals.jsonl"
    if sp.is_file():
        for line in sp.read_text().splitlines():
            line = line.strip()
            if line:
                try:
                    signals.append(json.loads(line))
                except json.JSONDecodeError:
                    continue
        signals.sort(key=lambda s: s.get("ts", 0))
    folded = _fold(signals)
    stack_vote = SIG.rating(folded, [v.get("n") for v in card.get("versions") or []])
    out_of_stack = SIG.hidden(folded)
    folded.pop("_held")
    folded.pop("_up")
    folded.pop("_vote_ts")
    folded.pop("_versions_ts")
    by_version = folded.pop("_versions")
    voices = {"_voices": folded.pop("_voices"), "_scoped": folded.pop("_scoped")}
    card.update(folded)
    # Move unadmitted AUTO versions to held so all ordinary stack readers exclude them.
    if out_of_stack:
        keep, out = [], []
        for v in card.get("versions") or []:
            (out if v.get("n") in out_of_stack else keep).append(v)
        card["versions"] = keep
        if out:
            card["held"] = out
            for v in out:
                v["vote"] = by_version.get(v["n"], by_version.get(str(v["n"])))
            # the card's own sound is its newest version's; a hidden one isn't the card's
            if keep and (keep[-1].get("media") or {}).get("audio"):
                card["media"] = {**(card.get("media") or {}), "audio": keep[-1]["media"]["audio"]}
    # Attachment signals store filenames, not URLs; convert after folding because _urls runs before the signal exists.
    card["attachments"] = [f"/media/{cid}/{a}" for a in card["attachments"]]
    versions = card.get("versions") or []
    for v in versions:
        if v.get("n") in by_version:
            v["vote"] = by_version[v["n"]]
    # Fold voice state into parts, including held versions; item voices are scoped by version and item.
    # A version's own parts correspond to its face item.
    for v in [*versions, *(card.get("held") or [])]:
        if voices["_voices"] or voices["_scoped"]:
            for item, parts in [(v.get("face_item"), v.get("parts") or []),
                                *((it.get("id"), it.get("parts") or []) for it in v.get("items") or [])]:
                for part in parts:
                    op = SIG.voice_state(voices, v.get("n"), item, part.get("id"))
                    if op:
                        part.update(op)
        _cut_mix(v, cid)
    # the card's own sound is its newest version's, so it follows that version's cut mix
    cm = card.get("media") or {}
    if versions and cm.get("audio") and cm["audio"] == (versions[-1].get("media") or {}).get("audio_full"):
        card["media"] = {**cm, "audio": versions[-1]["media"]["audio"]}
    # Apply the selected render where available; card media follows its newest visible version without rewriting files.
    face = card.get("face")
    if face:
        for v in versions:
            m = v.get("media") or {}
            pick = next((x for x in m.get("views") or [] if x.get("slug") == face), None)
            if pick:
                m.update({k: pick[k] for k in ("still", "gif") if pick.get(k)})
                for x in m["views"]:
                    x["face"] = x is pick
        if versions and (versions[-1].get("media") or {}).get("views"):
            card["media"] = {**(card.get("media") or {}),
                             **{k: versions[-1]["media"][k] for k in ("still", "gif")
                                if versions[-1]["media"].get(k)}}
    # A single-version card has one score: the newer card or version vote.
    if len(versions) == 1:
        versions[0]["vote"] = stack_vote
    # Use the shared best-visible-version rating so grid, cup and AUTO agree.
    card["vote"] = stack_vote
    if detail:
        card["signals"] = signals
    _cache[key] = (stamp, card)
    return card


def _request_images() -> dict[str, list[str]]:
    """Read request images from their single queue-media home, oldest request first; never copy them into cards."""
    out: dict[str, list[str]] = {}
    for job in sorted(Q.fold().values(), key=lambda j: j.get("created") or 0):
        if job.get("status") == "done" and job.get("result") and job.get("attachments"):
            # Only images that are there: a URL to a file that was removed draws a
            # broken tile and a 404 on every page that shows the card.
            d = Q.media_dir(job["id"])
            out.setdefault(job["result"], []).extend(
                f"/media/queue/{job['id']}/{n}" for n in job["attachments"]
                if (d / n).is_file())
    return out


@bp.get("/api/cards/stamp")
def cards_stamp():
    """Expose the shared generation so callers reload only after a store change."""
    return jsonify({"stamp": CAT.token()})


def _small(card: dict) -> dict:
    """Copy the grid projection without open-card text or held versions; never mutate cached cards.
    Keep item playback fields so referenced items still play before the full card is fetched."""
    def ver(v):
        v = {k: x for k, x in v.items() if k not in ("rationale", "params_doc")}
        if v.get("items"):
            v["items"] = [{k: x for k, x in it.items() if k not in ("parts", "why", "how")} for it in v["items"]]
        return v
    out = {k: x for k, x in card.items() if k != "held"}
    if isinstance(card.get("narrative"), dict):
        out["narrative"] = {k: x for k, x in card["narrative"].items() if k != "rationale"}
    if "versions" in card:
        out["versions"] = [ver(v) for v in card["versions"] or []]
    out["small"] = True
    return out


# Build type lists once per generation; retain snapshots so later pages do not shift under the caller.
# Cache entries hold generation, rows and id-to-position.
_built: dict[tuple, list] = {}
SNAPSHOTS = 4


def _rows(want: str | None, show_archived: bool) -> tuple:
    gen = CAT.scan()
    kept = _built.setdefault((want, show_archived), [])
    if kept and kept[-1][0] == gen:
        return kept[-1]
    cards = [c for cid, d, st in CAT.cards() for c in [read_card(cid, d=d, stamp=st)]
             if c is not None and (not want or c.get("type") == want)]
    asked = _request_images()
    out = []
    for card in cards:
        if card.get("archived") and not show_archived:
            continue
        # A card with only held versions stays off the grid until a version is admitted.
        if card.get("held") and not card.get("versions"):
            continue
        # A COPY: `read_card` hands back the object it cached, which must not learn the list's own fields
        out.append({**card, "attachments": asked.get(card.get("id"), []) + (card.get("attachments") or [])})
    # Sort by newest version, not first creation, so revised stacks surface with their latest work.
    for c in out:
        c["updated"] = max([c.get("created") or 0]
                           + [v.get("created") or 0 for v in c.get("versions") or []])
    out.sort(key=lambda c: c["updated"], reverse=True)
    # Calibrate attention with archived votes too; break equal need by newest work.
    if want and CONFIG.capability(want, "need"):
        nd = _need(want, cards)
        for c in out:
            c["need"] = nd.get(c.get("id"))
        out.sort(key=lambda c: -(c.get("need") or {}).get("value", 0))
    # A SCORED TAB (the manifest's `kind`): best first, by its newest version's score
    if want and CONFIG.manifest(want).get("kind") == "scored":
        out.sort(key=_best)
    snap = (gen, out, {c["id"]: i for i, c in enumerate(out)})
    kept.append(snap)
    del kept[:-SNAPSHOTS]
    return snap


def _best(c: dict) -> float:
    """A scored tab's order: its newest version's score, the best first; a card with none last."""
    sc = ((c.get("versions") or [{}])[-1].get("score")) or {}
    val = sc.get("value")
    if not isinstance(val, (int, float)):
        return float("inf")
    return val if sc.get("lower_is_better", True) is not False else -val


def every_card() -> list[dict]:
    """Use the index's existing stamps when reading folded cards; avoid a second filesystem scan."""
    return [c for cid, d, st in CAT.cards() for c in [read_card(cid, d=d, stamp=st)] if c]


# Cache live counts per generation instead of scanning the store on every initial page request.
_counts = {"gen": None, "n": {}}


def type_counts() -> dict[str, int]:
    gen = CAT.scan()
    if _counts["gen"] != gen:
        n: dict[str, int] = {}
        for c in every_card():
            if not c.get("archived"):
                n[c.get("type", "?")] = n.get(c.get("type", "?"), 0) + 1
        _counts.update(gen=gen, n=n)
    return dict(_counts["n"])


# A calibration vote can change other cards' need without changing their files.
# Track these derived changes so delta responses include them.
_needs: dict[str, tuple] = {}


def _need(t: str, cards: list | None = None) -> dict:
    gen = CAT.scan()
    st = _needs.get(t)
    if st and st[0] == gen:
        return st[1]
    if cards is None:
        cards = [c for cid, d, s in CAT.cards() for c in [read_card(cid, d=d, stamp=s)]
                 if c is not None and c.get("type") == t]
    nd = SIG.need(cards)
    # `floor`: the oldest generation the log can answer for; the first fold, or the newest entry trimmed off it
    log, floor = (st[2], st[3]) if st else ([], gen)
    if st:
        moved = {i for i in set(nd) | set(st[1]) if nd.get(i) != st[1].get(i)}
        if moved:
            log.append((gen, moved))
            if len(log) > CAT.KEEP:
                floor = log[-CAT.KEEP - 1][0]
                del log[:-CAT.KEEP]
    _needs[t] = (gen, nd, log, floor)
    return nd


@bp.get("/api/cards")
def list_cards():
    """Page within a retained generation; expired page snapshots return 410.
    Since queries return changed/removed rows or request a full reload when no delta is available."""
    want = request.args.get("type")
    show_archived = request.args.get("archived") in ("1", "true", "yes")
    since = request.args.get("since")
    if since is not None:
        ch = CAT.since(since)
        gen, rows, at = _rows(want, show_archived)
        moved = _moved(want, since) if want and CONFIG.capability(want, "need") else set()
        # a scored tab's order moves with any try: its reload is whole
        scored = want and CONFIG.manifest(want).get("kind") == "scored" and (ch is None or ch[0] or ch[1])
        if ch is None or moved is None or not want or scored:
            return jsonify({"gen": CAT.token(gen), "full": True})
        changed, removed = ch
        changed |= moved
        gone = [i for i in sorted(removed | changed) if i not in at
                and (i in removed or (read_card(i) or {}).get("type") == want)]
        return jsonify({"gen": CAT.token(gen), "removed": gone,
                        "changed": [_small(rows[at[i]]) for i in sorted((i for i in changed if i in at), key=at.get)]})
    asked_gen = request.args.get("gen")
    if asked_gen is not None:
        g = CAT.gen_of(asked_gen)
        snap = next((x for x in _built.get((want, show_archived), []) if x[0] == g), None)
        if snap is None:
            return jsonify({"error": "that order is no longer kept: start again", "gen": CAT.token()}), 410
    else:
        snap = _rows(want, show_archived)
    gen, out, _ = snap
    skip = max(0, request.args.get("skip", type=int) or 0)
    limit = request.args.get("limit", type=int)
    page = out[skip:skip + limit] if limit and limit > 0 else out[skip:]
    return jsonify({"cards": [_small(c) for c in page], "more": max(0, len(out) - skip - len(page)),
                    "gen": CAT.token(gen)})


def _moved(t: str, tok: str) -> set | None:
    """The cards of type t whose need moved after the token's generation; None when the log doesn't reach back."""
    g = CAT.gen_of(tok)
    _need(t)
    gen, _, log, floor = _needs[t]
    if g is None or g < floor:
        return None
    return set().union(*(ids for n, ids in log if n > g))


def by_ref(cid: str) -> str:
    """Resolve an id or manifest-prefixed short name; return 404 when neither identifies a card."""
    for t in CONFIG.types():
        p = t.get("name_prefix")
        if p and cid.startswith(p + ":"):
            return by_name(cid[len(p) + 1:], t["type"]) or abort(404, description=f"no card named {cid}")
    return cid


def by_name(name: str, type_: str) -> str | None:
    needle = f'"name": "{name}"'
    store = ST.of_type(type_)
    for d in (store.iterdir() if store.is_dir() else ()):
        f = d / "card.json"
        try:
            t = f.read_text()
        except OSError:
            continue
        if needle in t:
            try:
                c = json.loads(t)
            except ValueError:
                continue
            if c.get("type") == type_ and c.get("name") == name:
                return d.name
    return None


@bp.get("/api/cards/<cid>/download")
def download(cid):
    """Export the played version, selected bands or recording trim as on-demand AAC in an m4a.
    Do not cache downloads; browser decoding constraints do not apply to files."""
    import subprocess
    import tempfile
    from io import BytesIO
    cid = by_ref(cid)
    d = ST.card_dir(_safe(cid))
    try:
        raw = json.loads((d / "card.json").read_text())
    except (OSError, ValueError):
        abort(404)
    vs = raw.get("versions") or []
    n = request.args.get("version", type=int)
    v = next((x for x in vs if x.get("n") == n), None) if n else (vs[-1] if vs else None)
    if v is None:
        abort(404, description="no such version")
    parts = [p for p in v.get("parts") or [] if p.get("audio")]
    want = [b for b in (request.args.get("bands") or "").split(",") if b]
    mix = (v.get("media") or {}).get("audio")
    if want:
        srcs = [d / p["audio"] for p in parts if p.get("id") in want]
    else:
        srcs = [d / mix] if mix else [d / p["audio"] for p in parts]
    srcs = [x for x in srcs if x.exists()]
    if not srcs:
        abort(404, description="no audio for that")
    start, end = request.args.get("start", type=float), request.args.get("end", type=float)
    cmd = ["ffmpeg", "-v", "error", "-y"]
    for x in srcs:
        cmd += (["-ss", f"{start:.3f}"] if start else []) + (["-to", f"{end:.3f}"] if end else []) \
            + ["-i", str(x)]
    if len(srcs) > 1:
        cmd += ["-filter_complex", f"amix=inputs={len(srcs)}:normalize=0:duration=longest"]
    with tempfile.NamedTemporaryFile(suffix=".m4a", delete=False) as t:
        out = Path(t.name)
    try:
        r = subprocess.run(cmd + ["-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart",
                                  "-f", "ipod", str(out)], capture_output=True, text=True, timeout=180)
        if r.returncode:
            abort(500, description=f"ffmpeg: {r.stderr.strip()[-300:]}")
        data = out.read_bytes()
    finally:
        out.unlink(missing_ok=True)
    prefix = CONFIG.manifest(raw.get("type")).get("name_prefix")
    name = f"{prefix}_{raw['name']}" if prefix and raw.get("name") else cid
    tag = f"_v{v.get('n')}" if len(vs) > 1 else ""
    if want and len(want) < len(parts):
        tag += "_no-" + "-".join(p["id"] for p in parts if p.get("id") not in want)[:60]
    if start or end:
        tag += f"_{start or 0:.0f}-{end:.0f}s" if end else f"_{start:.0f}s-"
    resp = send_file(BytesIO(data), mimetype="audio/mp4", as_attachment=True, download_name=f"{name}{tag}.m4a")
    # the page's download link names a token; this cookie tells it the file is made (its spinner stops)
    token = request.args.get("token") or ""
    if re.fullmatch(r"[a-z0-9]{1,16}", token):
        resp.set_cookie(f"dl_{token}", "1", max_age=120, path="/", samesite="Lax")
    return resp


def with_need(card: dict) -> dict:
    """Use the grid's per-type calibration, including archived votes; copy before adding need."""
    t = card.get("type")
    if not t or not CONFIG.capability(t, "need"):
        return card
    return {**card, "need": _need(t).get(card.get("id"))}


@bp.get("/api/cards/<cid>")
def get_card(cid):
    cid = by_ref(cid)
    card = read_card(_safe(cid), detail=True)
    if card is None:
        abort(404)
    # A copy, for the same reason as list_cards: the cached dict must not learn
    # anything about another file.
    return jsonify(with_need({**card, "attachments": _request_images().get(card["id"], [])
                                                     + (card.get("attachments") or [])}))


# Keep the writable signal vocabulary closed; unknown state is a caller error, not an extension hook.
SIGNALS = {"vote", "archive", "face", "trim", "pool"}


@bp.post("/api/cards/<cid>/signal")
def write_signal(cid):
    """Append only to signals.jsonl; card.json belongs to the researcher.
    Reversing a decision appends a new signal, never rewrites old records."""
    cid = _safe(cid)
    d = ST.card_dir(cid)
    if not (d / "card.json").is_file():
        abort(404)
    body = request.get_json(silent=True) or {}
    kind = body.get("kind")
    if kind not in SIGNALS:
        abort(400, description=f"kind must be one of {sorted(SIGNALS)}")
    if kind == "face":
        v = (request.get_json(silent=True) or {}).get("value")
        if not (isinstance(v, str) and 0 < len(v) <= 32 and v.replace("_", "").isalnum()):
            abort(400, description="face is a render's slug, e.g. wholebody / newshort")
    if kind == "trim":
        # the selected part of a recording card, {start, end} s; or null: all of it
        try:
            body["value"] = Q.clean_trim(body.get("value"))
        except ValueError as e:
            abort(400, description=str(e))
    if kind == "pool":
        # Pool membership is last-write-wins per named pool.
        body["value"] = body.get("value", True)
        if not isinstance(body["value"], bool):
            abort(400, description="a pool mark's value is true or false")
        body["pool"] = body.get("pool") or "auto"
        if not (isinstance(body["pool"], str) and 0 < len(body["pool"]) <= 32
                and body["pool"].replace("_", "").replace("-", "").isalnum() and body["pool"].islower()):
            abort(400, description="pool is a pool's name, e.g. auto")
    rec = {"kind": kind, "value": body.get("value")}
    if body.get("item") is not None and not (isinstance(body["item"], str) and 0 < len(body["item"]) <= 32
                                             and body["item"].replace("_", "").isalnum()):
        abort(400, description="item is a bundle item's name, e.g. comp1")
    for k in ("version", "voice", "item", "pool"):
        if body.get(k) is not None:
            rec[k] = body[k]
    J.append_jsonl(d / "signals.jsonl", rec)
    CAT.note(cid)                                # the store's generation moves now, so the answer's need has the vote
    return jsonify(with_need(read_card(cid, detail=True)))


@bp.post("/api/cards/<cid>/split")
def split_card(cid):
    """Moving a version to a new stack is irreversible."""
    from core import split as SP
    cid = _safe(cid)
    body = request.get_json(silent=True) or {}
    try:
        version = int(body.get("version"))
    except (TypeError, ValueError):
        abort(400, description="send {version}")
    busy = any(j.get("card") == cid and j.get("status") == "running" for j in Q.jobs())
    try:
        new = SP.split(cid, version, busy=busy)
    except SP.Refused as e:
        return jsonify({"ok": False, "description": str(e)}), 409
    CAT.scan(max_age=0)                        # a new card and a changed one: the index sees them now
    return jsonify({"ok": True, "card": new, "from": read_card(cid)})


@bp.post("/api/cards/merge")
def merge_cards():
    """Merge into the first card in supplied order; this operation is irreversible."""
    from core import split as SP
    body = request.get_json(silent=True) or {}
    ids = [_safe(str(x)) for x in (body.get("cards") or []) if x]
    running = {j.get("card") for j in Q.jobs() if j.get("status") == "running"}
    try:
        root = SP.merge(ids, busy=lambda cid: cid in running)
    except SP.Refused as e:
        return jsonify({"ok": False, "description": str(e)}), 409
    CAT.scan(max_age=0)
    return jsonify({"ok": True, "card": root, "from": read_card(root)})


@bp.post("/api/cards/<cid>/duplicate")
def duplicate_card(cid):
    from core import split as SP
    cid = _safe(cid)
    try:
        version = int((request.get_json(silent=True) or {}).get("version"))
    except (TypeError, ValueError):
        abort(400, description="send {version}")
    try:
        new = SP.duplicate(cid, version)
    except SP.Refused as e:
        return jsonify({"ok": False, "description": str(e)}), 409
    CAT.scan(max_age=0)
    return jsonify({"ok": True, "card": new})


# a job's images (api/queue): at most 12 MB each, of these types
ATTACH_MAX = 12 * 1024 * 1024
# Extension is chosen from the declared type, never from a client-supplied filename:
# the name reaches a path, and `_safe` would reject most of what a phone sends anyway.
ATTACH_TYPES = {"image/png": "png", "image/jpeg": "jpg", "image/webp": "webp",
                "image/gif": "gif"}


def _decode_data_url(data_url: str) -> tuple[bytes, str]:
    import base64
    header, _, b64 = data_url.partition(",")
    if not header.startswith("data:"):
        abort(400, description="not a data URL")
    mime = header[5:].split(";")[0]
    if mime not in ATTACH_TYPES:
        abort(415, description=f"type must be one of {sorted(ATTACH_TYPES)}")
    try:
        return base64.b64decode(b64, validate=True), ATTACH_TYPES[mime]
    except Exception:
        abort(400, description="bad base64 in data URL")


# Cache thumbnails by source identity and restrict widths to bound disk growth.
THUMB_W = {160, 240, 360, 720, 1280}
THUMB_DIR = CONFIG.get().cache / "thumbs"


def _thumb(src: Path, w: int) -> Path | None:
    real = src.resolve()
    if real.suffix.lower() not in (".png", ".jpg", ".jpeg", ".webp"):
        return None
    st = real.stat()
    import hashlib                          # stable across restarts, unlike hash()
    key = hashlib.sha1(f"{real}|{st.st_mtime_ns}|{st.st_size}".encode()).hexdigest()[:16]
    out = THUMB_DIR / f"{key}_{w}.webp"
    if out.is_file():
        return out
    try:
        from PIL import Image
    except ImportError:                     # no Pillow: the full file, as before
        return None
    THUMB_DIR.mkdir(parents=True, exist_ok=True)
    with Image.open(real) as im:
        im = im.convert("RGB")
        if im.width > w:
            im = im.resize((w, max(1, round(im.height * w / im.width))), Image.LANCZOS)
        tmp = out.with_suffix(".tmp")
        im.save(tmp, "WEBP", quality=82, method=4)
        tmp.replace(out)
    return out


def prewarm_thumbs(widths=(360,)) -> int:
    made = 0
    for cid, d in ST.cards():                    # every store; a new store with no card yet gives none
        card = read_card(cid, d=d)
        if not card or card.get("archived"):
            continue
        urls = set()
        for v in card.get("versions") or [card]:
            m = v.get("media") or {}
            urls.update(x for x in [m.get("still")] + [y.get("still") for y in m.get("views") or []] if x)
        for u in urls:
            name = u.rsplit("/", 1)[-1]
            p = d / "media" / name
            if not p.exists():
                continue
            for w in widths:
                try:
                    if _thumb(p, w):
                        made += 1
                except Exception:
                    pass
    return made


MIX_DIR = CONFIG.get().cache / "mix"
_mix_lock = __import__("threading").Lock()


def _mix_plan(cid: str, n, keep: list[dict]) -> tuple[list[Path], list[str], str]:
    """Key by version, kept bands and file stamps; report missing kept files instead of omitting them."""
    import hashlib
    files, missing = [], []
    for p in keep:
        f = ST.card_dir(_safe(cid)) / "media" / _safe(str(p["audio"]).split("/")[-1])
        (files if f.exists() else missing).append(f if f.exists() else p.get("id") or str(p["audio"]))
    sig = "|".join(f"{f.resolve()}:{f.stat().st_mtime_ns}:{f.stat().st_size}" for f in files)
    return files, missing, hashlib.sha1(f"{cid}|{n}|{sig}".encode()).hexdigest()[:20]


def _version_of(cid: str, n) -> dict:
    card = read_card(_safe(cid))
    if card is None:
        raise LookupError("no such card")
    vs = [*(card.get("versions") or []), *(card.get("held") or [])]
    v = next((x for x in vs if x.get("n") == n), None)
    if v is None:
        raise LookupError("no such version")
    return v


def mix_file(cid: str, n: int) -> Path:
    """Sum all kept bands from zero at unit gain and cache by content key.
    Missing kept audio or no kept bands raises LookupError; encoding failure raises RuntimeError."""
    import subprocess
    v = _version_of(cid, n)
    keep, _ = _cut_out(v)
    if not keep:
        raise LookupError("every band is taken out")
    files, missing, key = _mix_plan(cid, n, keep)
    if missing:
        raise LookupError(f"a kept band's audio is missing: {', '.join(missing)}")
    out = MIX_DIR / f"{key}.mp3"
    with _mix_lock:
        if not out.is_file():
            MIX_DIR.mkdir(parents=True, exist_ok=True)
            tmp = out.with_suffix(f".{os.getpid()}.tmp.mp3")
            cmd = ["ffmpeg", "-v", "error", "-y"]
            for f in files:
                cmd += ["-i", str(f)]
            if len(files) > 1:
                cmd += ["-filter_complex", f"amix=inputs={len(files)}:normalize=0:duration=longest"]
            r = subprocess.run(cmd + ["-c:a", "libmp3lame", "-q:a", "2", str(tmp)],
                               capture_output=True, text=True, timeout=180)
            if r.returncode:
                tmp.unlink(missing_ok=True)
                raise RuntimeError(f"ffmpeg: {r.stderr.strip()[-300:]}")
            os.replace(tmp, out)
    return out


def cut_audio(cid: str, n: int) -> dict | None:
    """Return None only when no band is cut; otherwise return cut-aware URL and file.
    Unavailable cuts raise LookupError and encoding failures RuntimeError; never fall back to the full mix."""
    v = _version_of(cid, n)
    keep, cut = _cut_out(v)
    if not cut:
        return None
    path = mix_file(cid, n)
    _, _, key = _mix_plan(cid, n, keep)
    return {"url": f"/api/cards/{cid}/mix?version={n}&cut={','.join(cut)}&k={key}", "path": path}


@bp.get("/api/cards/<cid>/mix")
def cut_mix(cid):
    """Use the folded cuts, not the URL's cut parameter, to produce a seekable response."""
    cid = by_ref(cid)
    try:
        out = mix_file(cid, request.args.get("version", type=int))
    except LookupError as e:
        abort(404, description=str(e))
    except RuntimeError as e:
        abort(500, description=str(e))
    resp = send_file(out, mimetype="audio/mpeg", conditional=True)
    # Cache only URLs carrying the current content key; missing or stale keys require revalidation.
    resp.headers["Cache-Control"] = ("public, max-age=86400" if request.args.get("k") == out.stem
                                     else "no-cache")
    return resp


@bp.get("/media/<cid>/<name>")
def media(cid, name):
    p = ST.card_dir(_safe(cid)) / "media" / _safe(name)
    if not p.exists():                       # follows the symlink; a dead link is a 404
        abort(404)
    w = request.args.get("w", type=int)
    if w in THUMB_W:
        t = _thumb(p, w)
        if t:
            r = send_file(t, mimetype="image/webp", conditional=True)
            # a thumbnail is keyed by its source's mtime on the server; the browser may
            # keep it an hour without asking again
            r.headers["Cache-Control"] = "public, max-age=3600"
            return r
    r = send_file(p, conditional=True)
    r.headers["Cache-Control"] = "public, max-age=600"
    return r
