"""A plugin's grid_rank groups a need-ordered tab; each group keeps the need order."""

import _cfg  # noqa: F401
import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

PICKER = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(PICKER))

try:
    import flask                                       # noqa: F401
    HAVE_FLASK = True
except ImportError:
    HAVE_FLASK = False

PLUGIN = "def grid_rank(card):\n    return 0 if card['id'].startswith('first') else 1\n"


@unittest.skipUnless(HAVE_FLASK, "flask")
class GridRank(unittest.TestCase):
    def setUp(self):
        from flask import Flask
        from api import cards as C
        from core import catalog as CAT
        from core import queue as Q
        from core import stores as ST
        self.C, self.CAT, self.Q, self.ST = C, CAT, Q, ST
        self.root = Path(tempfile.mkdtemp())
        store = self.root / "store"
        store.mkdir()
        (self.root / "picker_plugin.py").write_text(PLUGIN)
        self.old = (Q.fold, C.CONFIG.manifest)
        Q.fold = lambda root=None: {}
        self.manifest = {"type": "tx", "capabilities": {"need": True}, "plugin": str(self.root / "picker_plugin.py")}
        C.CONFIG.manifest = lambda t, cfg=None: self.manifest if t == "tx" else {}
        ST.use([store])
        CAT.reset()
        C._cache.clear()
        C._built.clear()
        for i, (cid, loss) in enumerate([("later_near", 1), ("first_near", 1), ("later_far", 9), ("first_far", 9)]):
            d = store / cid
            d.mkdir()
            (d / "card.json").write_text(json.dumps({
                "id": cid, "type": "tx", "label": cid, "created": 1000 + i, "attachments": [],
                "versions": [{"n": 1, "id": "v1", "created": 1000 + i, "media": {}, "parts": [{"kind": "voice"}],
                              "score": {"name": "loss", "value": loss, "lower_is_better": True}}]}))
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

    def ids(self):
        return [c["id"] for c in self.cl.get("/api/cards?type=tx").get_json()["cards"]]

    def test_groups_first_then_need(self):
        self.assertEqual(self.ids(), ["first_far", "first_near", "later_far", "later_near"])

    def test_without_the_need_capability_the_rank_is_not_read(self):
        self.manifest["capabilities"] = {}
        self.assertEqual(self.ids(), ["first_far", "later_far", "first_near", "later_near"], "newest first")


if __name__ == "__main__":
    unittest.main()
