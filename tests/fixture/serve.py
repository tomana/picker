"""Start only inside the fixture sandbox, never on the production port; install the guard before imports."""
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import guard  # noqa: E402

PICKER = guard.PICKER
PORT, LEAKS = int(sys.argv[1]), Path(sys.argv[2])
# what every child inherits: this picker's address (the runners' PICKER_URL used to default to :8080), the port the
# guard lets them reach, and the leak log
os.environ.update(FIXTURE_PORT=str(PORT), PICKER_URL=f"http://127.0.0.1:{PORT}", FIXTURE_LEAKS=str(LEAKS),
                  PYTHONDONTWRITEBYTECODE="1")
guard.install(LEAKS)                     # before anything else

os.chdir(PICKER)
sys.path.insert(0, str(PICKER))

from core import config as CONFIG  # noqa: E402

CFG = CONFIG.require([])                 # Require sandbox config; never fall back to production paths.
import server  # noqa: E402
from core import auto as AU  # noqa: E402

AU.TICK = 2.0                            # a queued job is started within seconds, not a minute


# Hold scheduler wakes while scratch-state checks expect jobs to remain queued.
_HOLD = {"on": False}
_wake = AU.wake


def _held_wake(*a, **k):
    return [] if _HOLD["on"] else _wake(*a, **k)


AU.wake = _held_wake

# Hold direct starts too, including functions imported by name.
from api import agents as AGA, researchers as R  # noqa: E402


def _held(fn):
    def start(*a, **k):
        return ({"ok": True, "runner": "fixture: on hold"}, 202) if _HOLD["on"] else fn(*a, **k)
    return start


R.start_for, R.start_runner = _held(R.start_for), _held(R.start_runner)
AGA.start_runner = _held(AGA.start_runner)


@server.app.post("/__fixture/hold")
def _hold():
    from flask import jsonify, request
    _HOLD["on"] = bool((request.get_json(silent=True) or {}).get("on", True))
    return jsonify(_HOLD)


@server.app.post("/__fixture/prefs")
def _prefs():
    """Restore routed settings too, so AUTO cannot leak into later checks; clear keys absent from the snapshot."""
    from flask import jsonify, request
    from core import prefs as P
    snap = (request.get_json(silent=True) or {}).get("prefs") or {}
    now = P.fold()
    for k in sorted(P.KEYS):
        if now.get(k) != snap.get(k):
            P.set(k, snap.get(k))
    return jsonify(P.fold())


@server.app.post("/__fixture/append")
def _append():
    """Inject raw queue events to reproduce states unavailable through UI actions."""
    from flask import jsonify, request
    from core import queue as Q
    body = request.get_json(silent=True) or {}
    for rec in body.get("queue") or []:
        Q._append(rec)
    return jsonify({"ok": True})


if __name__ == "__main__":
    # (the leak log is NOT emptied here: what the imports above wrote must stay in it)
    from core import stores as ST
    print(f"[fixture] the stores: {CFG.data / 'stores'} — {sum(1 for _ in ST.cards())} cards", flush=True)
    sys.argv = [str(PICKER / "server.py"), "--port", str(PORT), "--host", "127.0.0.1"]
    server.main()
