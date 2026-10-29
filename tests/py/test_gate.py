"""A closed gate permits sends but blocks every claim and start path, including direct SDK starts."""
import _cfg  # noqa: F401
import json
import shutil
import tempfile
import unittest
from pathlib import Path


class GateTest(unittest.TestCase):
    def setUp(self):
        from core import gate as G, queue as Q, prefs as P, auto as AU
        self.G, self.Q, self.P, self.AU = G, Q, P, AU
        self.root = Path(tempfile.mkdtemp())
        self._data, self._queue, self._state = Q.DATA, Q.QUEUE, G.STATE
        Q.DATA, Q.QUEUE, G.STATE = self.root, self.root / "queue.jsonl", self.root

    def tearDown(self):
        self.Q.DATA, self.Q.QUEUE, self.G.STATE = self._data, self._queue, self._state
        shutil.rmtree(self.root, ignore_errors=True)

    def test_closed_nothing_is_claimed_and_the_job_keeps_its_place(self):
        j = self.Q.enqueue(type="t", kind="seed", text="x", root=self.root)
        self.G.close("a switch", root=self.root)
        self.assertTrue(self.G.closed(self.root))
        self.assertIsNone(self.Q.claim_next("t:r", types=["t"], root=self.root), "closed: no claim")
        self.assertEqual(self.Q.get(j["id"], root=self.root)["status"], "queued", "and it waits, queued")
        self.G.open_(root=self.root)
        got = self.Q.claim_next("t:r", types=["t"], root=self.root)
        self.assertEqual(got and got["id"], j["id"], "open: it is claimed")
        self.assertIsNone(self.Q.claim_next("t:r", types=["t"], root=self.root), "…once")

    def test_closed_the_scheduler_starts_nothing(self):
        self.P.set("auto", {**self.AU.DEFAULTS, "on": True, "types": ["t"]}, root=self.root)
        self.Q.enqueue(type="t", kind="seed", text="x", root=self.root)
        self.G.close("a switch", root=self.root)
        started = []
        made = self.AU.tick(cards=lambda: [{"id": "c1", "type": "t"}],
                            start=lambda t, j: started.append(j), root=self.root)
        self.assertEqual((made, started), ([], []), "AUTO's tick queues and starts nothing")
        self.assertIn("gate", self.AU.state["why"])
        asked = self.AU.wake([{"type": "t", "start": ["x"]}], lambda t, lane: started.append(t),
                             root=self.root, alive=lambda t, lane=None: False)
        self.assertEqual((asked, started), ([], []), "the wake starts no runner for the queued job")

    def test_closed_a_direct_start_is_refused_and_the_routes_say_so(self):
        from flask import Flask
        from api import gate as AG, researchers as R
        app = Flask(__name__)
        app.register_blueprint(AG.bp)
        c = app.test_client()
        # a type with no start command: 501 while open (nothing is started), 503 the gate's while closed
        body, code = R.start_runner({"type": "t"})
        self.assertEqual(code, 501, "open: a start is not the gate's to refuse")
        r = c.post("/api/gate", json={"closed": True, "why": "S2's switch"})
        self.assertEqual((r.status_code, r.get_json()["closed"]["why"]), (200, "S2's switch"))
        body, code = R.start_runner({"type": "t"})
        self.assertEqual(code, 503, body)
        # what still runs: a claimed job keeps it busy until it is done
        j = self.Q.enqueue(type="t", kind="seed", text="x", root=self.root)
        self.G.open_(root=self.root)
        self.Q.claim_next("t:r", types=["t"], root=self.root)
        self.G.close("again", root=self.root)
        R._types, saved = (lambda: []), R._types
        try:
            idle = c.get("/api/gate").get_json()["idle"]
            self.assertEqual((idle["idle"], idle["running"]), (False, [j["id"]]))
            self.Q.done(j["id"], None, attempt=1, root=self.root)
            self.assertTrue(c.get("/api/gate").get_json()["idle"]["idle"], "its job done: idle")
        finally:
            R._types = saved
        self.assertEqual(c.post("/api/gate", json={"closed": "yes"}).status_code, 400)
        R._types, saved = (lambda: []), R._types
        try:
            self.assertIsNone(c.post("/api/gate", json={"closed": False}).get_json()["closed"], "open again")
        finally:
            R._types = saved
        self.assertFalse((self.root / "gate.json").exists())

    def test_a_broken_gate_file_is_open(self):
        (self.root / "gate.json").write_text("{not json")
        self.assertFalse(self.G.closed(self.root))
        (self.root / "gate.json").write_text(json.dumps({"closed": False}))
        self.assertFalse(self.G.closed(self.root))


if __name__ == "__main__":
    unittest.main()
