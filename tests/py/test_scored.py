"""Sort scored cards by newest-version score; a new attempt reloads the entire tab."""

import _cfg  # noqa: F401
import json
import shutil
import sys
import tempfile
import time
import unittest
from pathlib import Path

PICKER = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(PICKER))

try:
    import flask                                       # noqa: F401
    HAVE_FLASK = True
except ImportError:
    HAVE_FLASK = False


def tried(root: Path, cid: str, made: int, value, kept: bool, lower=True, **media) -> None:
    d = root / cid
    d.mkdir(parents=True, exist_ok=True)
    (d / "card.json").write_text(json.dumps({
        "id": cid, "type": "tx", "label": f"change {cid}", "created": made, "attachments": [],
        "versions": [{"n": 1, "id": "v1", "created": made, "kept": kept, "media": media, "parts": [],
                      "score": {"name": "startup", "value": value, "lower_is_better": lower, "unit": "ms"}}]}))


@unittest.skipUnless(HAVE_FLASK, "flask")
class Scored(unittest.TestCase):
    def setUp(self):
        from flask import Flask
        from api import cards as C
        from core import catalog as CAT
        from core import queue as Q
        from core import stores as ST
        self.C, self.CAT, self.Q, self.ST = C, CAT, Q, ST
        self.root = Path(tempfile.mkdtemp())
        self.old = (Q.fold, C.CONFIG.manifest)
        Q.fold = lambda root=None: {}
        C.CONFIG.manifest = lambda t, cfg=None: {"type": "tx", "kind": "scored"} if t == "tx" else {}
        ST.use([self.root])
        CAT.reset()
        C._cache.clear()
        C._built.clear()
        for i, (cid, v, kept) in enumerate([("ta", 412, True), ("tb", 431, False), ("tc", 389, True), ("td", 395, False)]):
            tried(self.root, cid, 1000 + i, v, kept)
        app = Flask(__name__)
        app.register_blueprint(C.bp)
        self.cl = app.test_client()

    def tearDown(self):
        self.ST.use(None)
        self.Q.fold, self.C.CONFIG.manifest = self.old
        self.CAT.reset()
        self.C._cache.clear()
        self.C._built.clear()
        shutil.rmtree(self.root, ignore_errors=True)

    def rows(self, q=""):
        return self.cl.get(f"/api/cards?type=tx{q}").get_json()

    def test_best_first(self):
        self.assertEqual([c["id"] for c in self.rows()["cards"]], ["tc", "td", "ta", "tb"], "the fastest first")

    def test_a_new_try_takes_its_place_and_reloads_whole(self):
        first = self.rows("&limit=24")
        time.sleep(0.01)
        tried(self.root, "tf", 3000, 360, True)
        self.CAT.scan(max_age=0)
        self.assertTrue(self.rows(f"&since={first['gen']}")["full"], "a scored tab's reload is whole")
        self.assertEqual(self.rows()["cards"][0]["id"], "tf")

    def test_higher_is_better(self):
        for cid, v in (("ha", 0.5), ("hb", 0.9), ("hc", 0.7)):
            tried(self.root, cid, 4000, v, True, lower=False)
        for cid in ("ta", "tb", "tc", "td"):
            shutil.rmtree(self.root / cid)
        self.CAT.scan(max_age=0)
        self.assertEqual([c["id"] for c in self.rows()["cards"]], ["hb", "hc", "ha"])


if __name__ == "__main__":
    unittest.main()
