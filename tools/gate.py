#!/usr/bin/env python3
"""Closing the gate permits queueing but blocks starts and claims; wait for idle before reopening."""
import json
import os
import sys
import time
import urllib.request

URL = os.environ.get("PICKER_URL", "http://127.0.0.1:8080").rstrip("/") + "/api/gate"


def call(body=None) -> dict:
    req = urllib.request.Request(URL, data=None if body is None else json.dumps(body).encode(),
                                 method="GET" if body is None else "POST",
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.loads(r.read())


def say(d: dict) -> str:
    c, i = d.get("closed"), d.get("idle") or {}
    gate = f"CLOSED since {time.strftime('%H:%M:%S', time.localtime(c['since']))} ({c.get('why') or 'no reason given'})" \
        if c else "open"
    busy = ", ".join(filter(None, [f"{len(i.get('running') or [])} running: {' '.join(i['running'])}" if i.get("running") else "",
                                   f"runners alive: {' '.join(i['runners'])}" if i.get("runners") else ""]))
    return f"gate {gate} · {'idle' if i.get('idle') else 'busy — ' + busy}"


def main(argv: list[str]) -> int:
    cmd = argv[1] if len(argv) > 1 else "status"
    if cmd == "status":
        print(say(call()))
    elif cmd == "close":
        print(say(call({"closed": True, "why": " ".join(argv[2:])})))
    elif cmd == "open":
        print(say(call({"closed": False})))
    elif cmd == "wait":
        until = time.time() + (float(argv[2]) if len(argv) > 2 else 900)
        while True:
            d = call()
            if (d.get("idle") or {}).get("idle"):
                print(say(d))
                return 0
            if time.time() > until:
                print(say(d), file=sys.stderr)
                return 1
            time.sleep(3)
    else:
        print(__doc__, file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
