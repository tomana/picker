#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = ["flask>=3.0", "numpy", "pillow"]
# ///
"""Register shared routes and plugin services only after configuration resolves."""

import argparse
import gzip
import json
import os
import subprocess
import sys
import threading
import time
from urllib.parse import urlsplit
from pathlib import Path

from core import config as CONFIG

if __name__ == "__main__":
    CONFIG.require(sys.argv[1:])           # the service's start: no config, or a bad one, exits here (core/config.py)
CFG = CONFIG.get()

from flask import Flask, Response, abort, jsonify, request, send_file  # noqa: E402

PICKER = CONFIG.PICKER
STATIC_DIR = PICKER / "static"



app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 512 * 1024 * 1024          # an upload's ceiling (a long recording fits)

LOCAL = {"127.0.0.1", "localhost", "::1"}


def _hostname(netloc: str) -> str:
    h = (netloc or "").strip().lower()
    if h.startswith("["):
        return h[1:h.find("]")]
    return h.rsplit(":", 1)[0] if h.count(":") == 1 else h


@app.before_request
def _only_its_own_names():
    """No login, so the request must name this picker: its Host (a DNS name rebound to 127.0.0.1 is refused) and, on a
    write, a browser's Origin (a page elsewhere can't post here). A client that sends no Origin (curl, an app) passes."""
    ok = LOCAL | set(CFG.names)
    if _hostname(request.host) not in ok:
        abort(403, description=f"not a name this picker answers to: {request.host} (config: [server] names)")
    origin = request.headers.get("Origin")
    if origin is not None and request.method not in ("GET", "HEAD", "OPTIONS") \
            and _hostname(urlsplit(origin).netloc) not in ok:
        abort(403, description=f"a write from another site: {origin}")

# The optional band script comes from configuration, not this server's routes.
@app.get("/static/band.js")
def band_js():
    resp = Response(CFG.band.read_text() if CFG.band else "", mimetype="text/javascript")
    resp.headers["Cache-Control"] = "no-cache"
    return resp

from api import cards as _cards_api          # noqa: E402
from api import queue as _queue_api          # noqa: E402
from api import researchers as _res_api      # noqa: E402
from api import arrange as _arrange_api       # noqa: E402
from api import prefs as _prefs_api           # noqa: E402
from api import cup as _cup_api               # noqa: E402
from api import agents as _agents_api         # noqa: E402
from api import audit as _audit_api           # noqa: E402
from api import auto as _auto_api             # noqa: E402
from api import gate as _gate_api             # noqa: E402
from api import receipts as _receipts_api     # noqa: E402
from api import events as _events_api         # noqa: E402
app.register_blueprint(_cards_api.bp)
app.register_blueprint(_queue_api.bp)
app.register_blueprint(_res_api.bp)
app.register_blueprint(_arrange_api.bp)
app.register_blueprint(_prefs_api.bp)
app.register_blueprint(_cup_api.bp)
app.register_blueprint(_agents_api.bp)
app.register_blueprint(_audit_api.bp)
app.register_blueprint(_auto_api.bp)
app.register_blueprint(_gate_api.bp)
app.register_blueprint(_receipts_api.bp)
app.register_blueprint(_events_api.bp)
# Register each configured plugin's routes once, even when multiple types share it.
from core import plugins as _plugins          # noqa: E402


def _start_job(type_: str, job: dict) -> None:
    from api.researchers import _types, start_for
    t = next((t for t in _types() if t["type"] == type_), None)
    if t:
        start_for(t, job)


# what only the server has, for the plugins' services (core/plugins.py): the folded card, a cut's mix, an id checked,
# a job's runner started
_plugins.provide(read_card=_cards_api.read_card, cut_audio=_cards_api.cut_audio, safe=_cards_api._safe,
                 start=_start_job, cards=_cards_api.every_card)
_PLUGIN_RULES: list = []
for _p in _plugins.every():
    for _bp in (_p.routes(_plugins.services()) if hasattr(_p, "routes") else []):
        app.register_blueprint(_bp)
        _PLUGIN_RULES.extend(r.rule for r in app.url_map.iter_rules() if r.endpoint.startswith(_bp.name + "."))


@app.get("/api/plugins")
def plugin_rules():
    """Expose only installed plugin services and page modules."""
    return jsonify({"serves": sorted(set(_PLUGIN_RULES)),
                    "pages": [p.page for p in _plugins.every() if isinstance(getattr(p, "page", None), str)]})


_GZIP_TYPES = ("application/json", "text/css", "text/html", "text/plain",
               "application/javascript", "text/javascript", "image/svg+xml")
_GZIP_MIN = 1024          # below this the header costs more than the saving


@app.after_request
def _gzip(resp):
    if "gzip" not in request.headers.get("Accept-Encoding", "").lower():
        return resp
    if resp.status_code < 200 or resp.status_code >= 300 or "Content-Encoding" in resp.headers:
        return resp
    if not (resp.mimetype or "").startswith(_GZIP_TYPES):
        # png, gif, mp3, mp4 and the rest are already compressed; gzipping them
        # spends CPU to make them very slightly bigger.
        return resp
    # send_file responses are passthrough; reading .data requires buffering before compression.
    resp.direct_passthrough = False
    data = resp.get_data()
    if len(data) < _GZIP_MIN:
        return resp
    packed = gzip.compress(data, 6)       # 6, not 9: 9 costs ~3x the CPU for ~2%
    if len(packed) >= len(data):
        return resp
    resp.set_data(packed)
    resp.headers["Content-Encoding"] = "gzip"
    resp.headers["Content-Length"] = str(len(packed))
    # Proxy caches must distinguish responses by Accept-Encoding.
    resp.headers.setdefault("Vary", "Accept-Encoding")
    return resp



_usage_cache = {"ts": 0.0, "data": None}
_usage_refresh_lock = threading.Lock()

# Serve fresh immediately, refresh usable stale data in the background, and block only beyond the stale window.
# Rate-limit upstream calls on errors too; retain the last successful reading.
_USAGE_FRESH_S = 180    # cache fully fresh: no upstream call.
_USAGE_STALE_S = 900    # cache usable: serve stale, refresh in BG.
_USAGE_RETRY_S = 180    # after upstream error, wait this long before retry.


def _fetch_usage_blocking():
    """Preserve the last good snapshot on failure and use the shorter retry window.
    Cache initial errors too, so repeated requests do not hammer an unavailable upstream."""
    from core import agents as _A
    try:
        _usage_cache.update(ts=time.time(), data=_A.claude_usage(time.time()))
        return
    except Exception as e:
        # Backdate freshness so failures retry after _USAGE_RETRY_S, not the full stale window.
        retry_ts = time.time() - (_USAGE_FRESH_S - _USAGE_RETRY_S)
        last = _usage_cache.get("data")
        is_good = last and (last.get("session") or last.get("weekly"))
        if is_good:
            # Keep the last known-good data; just bump ts.
            _usage_cache.update(ts=retry_ts, data={**last, "error": str(e)[:120]})
        else:
            # No usable data yet; cache the error so the UI can show
            # "unavailable" without re-attempting on every request.
            _usage_cache.update(ts=retry_ts,
                                data={"session": None, "weekly": None,
                                      "error": str(e)[:120],
                                      **({"missing": "claude"} if isinstance(e, _A.CLIMissing) else {})})


def _refresh_usage_background():
    """Background refresh. Bail if one's already in flight (no piling up)."""
    if not _usage_refresh_lock.acquire(blocking=False):
        return
    try:
        _fetch_usage_blocking()
    finally:
        _usage_refresh_lock.release()


def _claude_usage(force_refresh: bool) -> dict:
    now = time.time()
    if not force_refresh and _usage_cache["data"] is not None:
        age = now - _usage_cache["ts"]
        if age >= _USAGE_FRESH_S and age < _USAGE_STALE_S:
            threading.Thread(target=_refresh_usage_background, daemon=True).start()
        if age < _USAGE_STALE_S:
            return _usage_cache["data"]
    # Share the in-flight capture at startup or forced refresh instead of launching another CLI.
    with _usage_refresh_lock:
        if force_refresh or _usage_cache["data"] is None or now - _usage_cache["ts"] >= _USAGE_STALE_S:
            _fetch_usage_blocking()
    return _usage_cache["data"]


_codex_cache = {"ts": 0.0, "data": None}

# Usage comes only from the installed CLI; do not read credentials or scrape account endpoints.

_AGY_CACHE = {"ts": 0.0, "data": None}
_AGY_CACHE_FRESH_S = 300    # Past this age, serve the snapshot while refreshing in the background.
_AGY_REFRESH_LOCK = threading.Lock()


def _capture_agy_usage_cli() -> dict:
    """Preserve every reported group and bucket; absence of a window is not zero usage."""
    from core import agents as _A
    from core import agy as AG
    exe = _A.binary("agy")
    if not exe:
        return {"error": "no agy binary"}
    try:
        r = subprocess.run([exe, "-p", "/usage", "--output-format", "json"],
                           capture_output=True, text=True, timeout=45, cwd=str(Path.home()),
                           env=_A.agent_env())
        if r.returncode:
            return {"error": f"agy /usage exited {r.returncode}: {(r.stderr or '').strip()[-120:]}"}
        d = json.loads(r.stdout or "{}")
    except Exception as e:
        return {"error": f"agy /usage: {str(e)[:120]}"}
    groups = (((d.get("command") or {}).get("data") or {}).get("groups")) or []
    found = {}
    for g in groups:
        name = g.get("name")
        if not name:
            continue
        key = AG.group_id(name)
        if not key or key in found:
            return {"error": "agy /usage has duplicate or invalid group names"}
        found[key] = {**AG.describe(name, g.get("description") or ""),
                      "buckets": {b["window"]: dict(b) for b in g.get("buckets") or [] if b.get("window")}}
    if not found:
        return {"error": f"agy /usage listed no groups ({(r.stderr or '').strip()[-120:]})"}
    return {"groups": found, "plan": (d.get("command") or {}).get("data", {}).get("plan"), "source": "agy-usage",
            "as_of": time.time()}


def _store_agy(data: dict):
    """Keep the last successful capture so a temporary daemon gap does not blank the bar."""
    _AGY_CACHE.update(ts=time.time(), data=data)
    if "error" not in data:
        _AGY_CACHE["good"] = {**data, "good_ts": data.get("as_of") or time.time()}


def _refresh_agy_quota_background():
    if not _AGY_REFRESH_LOCK.acquire(blocking=False):
        return
    try:
        _store_agy(_capture_agy_usage_cli())
    finally:
        _AGY_REFRESH_LOCK.release()


def _epoch_to_iso(e):
    if not isinstance(e, (int, float)):
        return None
    from datetime import datetime, timezone
    return datetime.fromtimestamp(int(e), tz=timezone.utc).isoformat()


# Read account limits without running a model; refresh process-backed reads in the background.
# Never send the similarly named reset-credit consume request.
_CODEX_LIVE = {"ts": 0.0, "data": None, "busy": False, "err": None}
_CODEX_LIVE_EVERY_S = 120


def _codex_rate_limits(timeout=20.0):
    """the CLI's own reading of the account's limits (the app server's
    `account/rateLimits/read` result), or None. Never runs a model."""
    import queue as _q
    from core import agents as _A
    exe = _A.binary("codex")
    if not exe:
        _CODEX_LIVE["err"] = "no codex binary"
        return None
    try:
        p = subprocess.Popen([exe, "app-server"], stdin=subprocess.PIPE,
                             stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                             text=True, env=_A.agent_env())
    except OSError as e:
        _CODEX_LIVE["err"] = str(e)[:120]
        return None
    lines = _q.Queue()
    threading.Thread(target=lambda: [lines.put(l) for l in p.stdout], daemon=True).start()

    def send(o):
        p.stdin.write(json.dumps({"jsonrpc": "2.0", **o}) + "\n")
        p.stdin.flush()
    try:
        send({"id": 1, "method": "initialize",
              "params": {"clientInfo": {"name": "picker", "version": "1"}}})
        end = time.time() + timeout
        while time.time() < end:
            try:
                m = json.loads(lines.get(timeout=max(0.1, end - time.time())))
            except (_q.Empty, ValueError):
                continue
            if m.get("id") == 1:
                send({"method": "initialized"})
                send({"id": 2, "method": "account/rateLimits/read"})
            elif m.get("id") == 2:
                if m.get("error"):
                    _CODEX_LIVE["err"] = str(m["error"])[:120]
                    return None
                _CODEX_LIVE["err"] = None
                return m.get("result")
        _CODEX_LIVE["err"] = "timed out"
        return None
    except (OSError, ValueError) as e:
        _CODEX_LIVE["err"] = str(e)[:120]
        return None
    finally:
        p.kill()
        try:
            p.wait(timeout=3)
        except Exception:
            pass


def _codex_live_fetch():
    res = _codex_rate_limits()
    if res and isinstance(res.get("rateLimits"), dict):
        _CODEX_LIVE.update(ts=time.time(), data=res, err=None)
    elif not _CODEX_LIVE.get("err"):
        _CODEX_LIVE["err"] = "no rate limits in CLI response"
    _CODEX_LIVE["busy"] = False


def _codex_live(force=False):
    """Return a recent cached reading; startup and explicit refresh wait for the shared capture."""
    c, now = _CODEX_LIVE, time.time()
    if force or c["data"] is None:
        if not c["busy"]:
            c["busy"] = True
            _codex_live_fetch()
        else:                                     # one in flight (the start-up's, the scheduler's): wait for it
            for _ in range(60):
                if not c["busy"]:
                    break
                time.sleep(0.25)
    elif now - c["ts"] >= _CODEX_LIVE_EVERY_S and not c["busy"]:
        c["busy"] = True
        threading.Thread(target=_codex_live_fetch, daemon=True).start()
    res = c["data"]
    if not res or time.time() - c["ts"] > _CODEX_STALE_S:
        return None
    rl = res["rateLimits"]

    def win(w):
        w = w or {}
        return {"pct": w.get("usedPercent"), "resets_at": _epoch_to_iso(w.get("resetsAt")),
                "window_minutes": w.get("windowDurationMins")}
    cr = rl.get("credits") or {}
    return {
        "available": True,
        "session": win(rl.get("primary")),
        "weekly": win(rl.get("secondary")),
        "plan_type": rl.get("planType"),
        "age_seconds": int(max(0, time.time() - c["ts"])),
        # Depletion requires a blocked/reached limit, not merely the absence of paid credits.
        "depleted": bool(rl.get("rateLimitReachedType")) or res.get("ordinaryUsageAllowed") is False,
        "credits": {"balance": cr.get("balance"), "has_credits": cr.get("hasCredits"),
                    "unlimited": cr.get("unlimited")},
        "reset_credits": (res.get("rateLimitResetCredits") or {}).get("availableCount"),
        "source": "live",
        "live_error": c["err"],
    }


def _codex_usage(force_refresh: bool) -> dict:
    now = time.time()
    if not force_refresh and _codex_cache["data"] is not None and now - _codex_cache["ts"] < 60:
        return _codex_cache["data"]
    live = _codex_live(force=force_refresh)
    if live is not None:
        _codex_cache.update(ts=now, data=live)
        return live
    data = {"available": False, "session": None, "weekly": None,
            "plan_type": None, "age_seconds": None, "live_error": _CODEX_LIVE["err"]}
    _codex_cache.update(ts=now, data=data)
    return data


# Normalize percent used and elapsed reset windows here, not independently in each client.
# Use last-good snapshots on failure; do not block the family-quota source unless explicitly refreshed.

_CODEX_STALE_S = 6 * 3600
_AGY_UI_STALE_S = 2 * 3600


def _iso_to_epoch(iso):
    """An unparseable reset is unknown, never resetting now."""
    if not iso or not isinstance(iso, str):
        return None
    from datetime import datetime
    try:
        return datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp()
    except (ValueError, TypeError):
        return None


def _usage_window(key, label, used_pct, resets_at, now):
    """One normalised window. `used_pct` is ALWAYS percent USED."""
    post = False
    epoch = _iso_to_epoch(resets_at)
    if epoch is not None and now > epoch:
        used_pct, post = 0.0, True
    if used_pct is not None:
        used_pct = round(max(0.0, min(100.0, float(used_pct))), 1)
    return {"key": key, "label": label, "used_pct": used_pct,
            "resets_at": resets_at, "post_reset": post}


def _usage_all_anthropic(now, force):
    try:
        d = _claude_usage(force) or {}
    except Exception as e:
        return {"available": False, "age_seconds": None, "stale": True,
                "error": str(e)[:120], "windows": []}
    age = (int(max(0, now - _usage_cache["ts"]))
           if _usage_cache.get("ts") else None)
    s, w = d.get("session") or {}, d.get("weekly") or {}
    return {
        "available": bool(d.get("session") or d.get("weekly")),
        "age_seconds": age,
        "stale": age is None or age >= _USAGE_STALE_S,
        "error": d.get("error"),
        "windows": [_usage_window("session", "session (5h)", s.get("pct"),
                                  s.get("resets_at"), now),
                    _usage_window("weekly", "weekly (7d)", w.get("pct"),
                                  w.get("resets_at"), now)],
    }


def _usage_all_codex(now, force):
    try:
        d = _codex_usage(force) or {}
    except Exception as e:
        return {"available": False, "age_seconds": None, "stale": True,
                "error": str(e)[:120], "windows": []}
    age = d.get("age_seconds")
    s, w = d.get("session") or {}, d.get("weekly") or {}
    return {
        "available": bool(d.get("available")),
        "error": d.get("live_error"),
        "age_seconds": age,
        "stale": (not d.get("available")) or (age is not None and age > _CODEX_STALE_S),
        "plan_type": d.get("plan_type"),
        # Wallet state, not a window: only the session bar wears it.
        "depleted": bool(d.get("depleted")),
        "windows": [_usage_window("session", "session (5h)", s.get("pct"),
                                  s.get("resets_at"), now),
                    _usage_window("weekly", "weekly (7d)", w.get("pct"),
                                  w.get("resets_at"), now)],
    }


def _usage_all_agy(now, force):
    """Invert remaining into used percentages; keep family and weekly windows separate."""
    if force:
        _store_agy(_capture_agy_usage_cli())
    elif (_AGY_CACHE.get("data") is None
          or now - (_AGY_CACHE.get("ts") or 0) >= _AGY_CACHE_FRESH_S):
        # Kick it off, don't wait for it. The widget gets the last good
        # snapshot now and the fresh one on its next tick.
        threading.Thread(target=_refresh_agy_quota_background,
                         daemon=True).start()

    data = _AGY_CACHE.get("data") or {}
    # A zero timestamp means no capture and unknown age, not an ancient real reading.
    age = (int(max(0, now - _AGY_CACHE["ts"]))
           if _AGY_CACHE.get("ts") else None)
    if "error" in data or not data.get("groups"):
        good = _AGY_CACHE.get("good")
        if good:
            data = good
            age = (int(max(0, now - good["good_ts"]))
                   if good.get("good_ts") else None)

    # Age the snapshot from its capture time, not the time it was reread from disk.
    if data.get("as_of"):
        age = int(max(0, now - data["as_of"]))
    groups, wins = {}, []
    for gid, group in (data.get("groups") or {}).items():
        keys = {}
        for period, bucket in (group.get("buckets") or {}).items():
            key = f"{gid}:{period}"
            remaining = bucket.get("remaining_fraction")
            used = None
            if isinstance(remaining, (int, float)) and not isinstance(remaining, bool):
                used = 100 * (1 - remaining)
            wins.append({**_usage_window(key, f"{group['name']} ({period})", used, bucket.get("reset_time"), now),
                         "group": gid, "period": period})
            keys[period] = key
        groups[gid] = {k: v for k, v in group.items() if k != "buckets"} | {"windows": keys}
    return {
        "available": bool(groups),
        "age_seconds": age,
        "stale": (not groups) or (age is not None and age > _AGY_UI_STALE_S),
        "error": ((_AGY_CACHE.get("data") or {}).get("error")
                  or (None if groups else "no snapshot yet — capture running")),
        "plan": data.get("plan"),
        "groups": groups,
        "windows": wins,
    }


@app.get("/api/usage/all")
def api_usage_all():
    """Normalize every source to percent used; refresh=true forces all, refresh=<source> only that source."""
    now = time.time()
    asked = request.args.get("refresh")
    force = lambda src: asked == "true" or asked == src
    sources = {}
    # One bad source must never fail the call: the widget would go blank
    # over a transient daemon gap.
    from core import agents as _A
    from core import budget as B
    for name, cli, fn in (("anthropic", "claude", lambda: _usage_all_anthropic(now, force("anthropic"))),
                          ("codex", "codex", lambda: _usage_all_codex(now, force("codex"))),
                          ("agy", "agy", lambda: _usage_all_agy(now, force("agy")))):
        # Missing CLIs must show unavailable instead of stale usage.
        if not _A.binary(cli):
            sources[name] = {"available": False, "age_seconds": None, "stale": True,
                             "missing": cli, "error": f"{cli} CLI not installed", "windows": []}
            continue
        try:
            sources[name] = B.bar_source(cli) or fn()
        except Exception as e:
            sources[name] = {"available": False, "age_seconds": None,
                             "stale": True, "error": str(e)[:120],
                             "windows": []}
    return jsonify({"generated_at": int(now), "sources": sources})


def _budget_source(agent):
    from core import agents as A
    now = time.time()
    readers = {"claude": _usage_all_anthropic, "codex": _usage_all_codex, "agy": _usage_all_agy}
    cli = A.spec(agent)["cli"]
    if cli not in readers or not A.binary(cli):
        return {"available": False, "error": f"{cli}: no session usage reader", "windows": []}
    return readers[cli](now, True)


from core import budget as _budget
_budget.configure(_budget_source)



@app.get("/")
def index():
    """The page: static/shell.html, never cached, so a change to it is a reload away."""
    resp = send_file(STATIC_DIR / "shell.html")
    resp.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
    return resp



def _start_scheduler():
    from core import auto as AU
    from api.researchers import _types, start_runner
    from api.cards import every_card

    AU.run_forever(
        wake_hooks={"types": _types(),
                    "start_lane": lambda t, lane: start_runner(t, lane=lane)},
        cards=every_card, start=_start_job)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", help="picker.toml (read before anything else: core/config.py)")
    ap.add_argument("--port", type=int, default=CFG.port)
    ap.add_argument("--host", default=CFG.host)
    args = ap.parse_args()
    os.environ["PICKER_URL"] = f"http://127.0.0.1:{args.port}"
    print(f"[picker] config {CFG.file}")

    try:
        types = CONFIG.types(CFG)
    except Exception as e:
        types = []
        print(f"[picker] a manifest is unreadable ({e}) — the store still serves, but "
              f"no researcher can be started")
    print(f"[picker] {len(types)} type(s): "
          f"{', '.join(t.get('type', '?') for t in types) or '(none)'}")
    from core import stores as ST
    for st in ST.every():
        n = len(list(st.glob("*/card.json")))
        print(f"[picker] {n} cards in {st}")
    # Recover abandoned work immediately at boot; warm usage caches concurrently before the first request.
    def _warm_usage():
        if _budget.bar_source("claude") is None:
            _refresh_usage_background()
        if _budget.bar_source("codex") is None:
            _codex_live()
    threading.Thread(target=_warm_usage, daemon=True).start()
    _start_scheduler()
    # the grid's thumbnails, made before the first page asks (api/cards.prewarm_thumbs)
    def _warm():
        from api.cards import prewarm_thumbs
        t0 = time.time()
        n = prewarm_thumbs()
        print(f"[picker] thumbnails ready: {n} in {time.time() - t0:.0f}s", flush=True)
    threading.Thread(target=_warm, name="thumbs", daemon=True).start()
    print(f"[picker] serving http://{args.host}:{args.port}/")
    app.run(host=args.host, port=args.port, debug=False, threaded=True)


if __name__ == "__main__":
    main()
