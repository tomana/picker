"""/api/events: a queue change and a store change are pushed (api/events.py), on a temp queue and store."""
import _cfg  # noqa: F401
import json
import shutil
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from flask import Flask  # noqa: E402

from api import events as E  # noqa: E402
from core import catalog as CAT  # noqa: E402
from core import queue as Q  # noqa: E402
from core import stores as ST  # noqa: E402


class Events(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp())
        ST.use([self.root / "cards"])
        CAT.reset()
        app = Flask(__name__)
        app.register_blueprint(E.bp)
        self.cl = app.test_client()

    def tearDown(self):
        ST.use(None)
        CAT.reset()
        shutil.rmtree(self.root, ignore_errors=True)

    def test_a_queue_change_and_a_new_card_are_pushed(self):
        got = []
        with mock.patch.object(E, "TICK", 0.05), mock.patch.object(Q, "_path", lambda root=None: self.root / "q.jsonl"):
            r = self.cl.get("/api/events", buffered=False)

            def read():
                for chunk in r.response:
                    got.append(chunk.decode() if isinstance(chunk, bytes) else chunk)
                    if any("event: cards" in g for g in got):
                        return
            t = threading.Thread(target=read, daemon=True)
            t.start()
            time.sleep(1.2)                                  # the stream's first look has aged past a fresh scan's
            d = self.root / "cards" / "c1"
            d.mkdir(parents=True)
            (d / "card.json").write_text(json.dumps({"id": "c1", "type": "t", "versions": []}))
            (self.root / "q.jsonl").write_text(json.dumps({"event": "enqueue", "id": "j1"}) + "\n")
            t.join(5)
        text = "".join(got)
        self.assertIn("event: queue", text)
        self.assertIn("event: cards", text, "a queue change looks at the store, which moved")


if __name__ == "__main__":
    unittest.main()
