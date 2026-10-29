"""Push queue changes and card generations; local writes count immediately, external writes are scanned."""
import json
import time

from flask import Blueprint, Response

from core import catalog as CAT
from core import queue as Q

bp = Blueprint("events", __name__)
TICK = 1.0               # the queue log is stat'ed this often
SCAN = 30.0              # the store is scanned at least this often (a sync outside a job, a signal from elsewhere)
BEAT = 15.0              # a comment line this often, so a closed connection is noticed


def _queue_mark():
    try:
        st = Q._path().stat()
        return st.st_mtime_ns, st.st_size
    except OSError:
        return None


@bp.get("/api/events")
def events():
    def stream():
        mark, token = _queue_mark(), CAT.token()
        scanned = beat = time.time()
        yield "retry: 5000\n\n"
        while True:
            time.sleep(TICK)
            now, m = time.time(), _queue_mark()
            moved = m != mark
            if moved:
                mark = m
                yield "event: queue\ndata: {}\n\n"
            if moved or now - scanned >= SCAN:
                scanned = now
                t = CAT.token(CAT.scan(max_age=1.0))     # fresh after a queue change; shared by the pages listening
            else:
                t = CAT.last()                           # the picker's own writes (a signal) count at once
            if t != token:
                token = t
                yield f"event: cards\ndata: {json.dumps(t)}\n\n"
            if now - beat >= BEAT:
                beat = now
                yield ": beat\n\n"
    return Response(stream(), mimetype="text/event-stream",
                    headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})
