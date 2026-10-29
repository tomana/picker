"""Paginated lists retain one generation order even when cards change between requests."""

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


def card(root: Path, cid: str, created: int, **more) -> Path:
    d = root / cid
    d.mkdir(parents=True, exist_ok=True)
    (d / "card.json").write_text(json.dumps({
        "id": cid, "type": "fx_visual", "label": cid, "attachments": [],
        "versions": [{"n": 1, "id": "v1", "created": created, "rationale": "why", "media": {"still": "media/a.png"}}],
        **more}))
    return d


@unittest.skipUnless(HAVE_FLASK, "flask")
class Index(unittest.TestCase):
    def setUp(self):
        from flask import Flask
        from api import cards as C
        from core import catalog as CAT
        from core import queue as Q
        from core import stores as ST
        self.C, self.CAT, self.Q, self.ST = C, CAT, Q, ST
        self.root = Path(tempfile.mkdtemp())
        self.old = Q.fold
        Q.fold = lambda root=None: {}
        ST.use([self.root])
        CAT.reset()
        C._cache.clear()
        C._built.clear()
        for i, cid in enumerate(["ca", "cb", "cc", "cd"]):
            card(self.root, cid, 1000 + i)
        app = Flask(__name__)
        app.register_blueprint(C.bp)
        self.cl = app.test_client()

    def tearDown(self):
        self.ST.use(None)
        self.Q.fold = self.old
        self.CAT.reset()
        self.C._cache.clear()
        self.C._built.clear()
        shutil.rmtree(self.root, ignore_errors=True)

    def get(self, q):
        r = self.cl.get(f"/api/cards?type=fx_visual{q}")
        return r.status_code, r.get_json()

    def later(self):
        time.sleep(0.01)                               # a new mtime
        self.CAT.scan(max_age=0)

    def test_pages_from_one_order(self):
        _, p1 = self.get("&limit=2")
        self.assertEqual([c["id"] for c in p1["cards"]], ["cd", "cc"], "newest work first")
        self.assertEqual(p1["more"], 2)
        # a card changes between the pages: the rest still comes from the order the first page was from
        card(self.root, "ca", 9000)
        self.later()
        _, p2 = self.get(f"&gen={p1['gen']}&skip=2")
        self.assertEqual([c["id"] for c in p2["cards"]], ["cb", "ca"], "the first page's order, not the new one")
        self.assertTrue(all(c["small"] for c in p2["cards"]))

    def test_an_order_no_longer_kept_is_410(self):
        _, p1 = self.get("&limit=2")
        for k in range(self.C.SNAPSHOTS + 1):          # as many new generations, each with its list built
            card(self.root, "ca", 2000 + k)
            self.later()
            self.get("&limit=1")
        code, body = self.get(f"&gen={p1['gen']}&skip=2")
        self.assertEqual(code, 410)
        self.assertIn("gen", body)

    def test_since_is_only_what_changed(self):
        _, p1 = self.get("&limit=24")
        _, d = self.get(f"&since={p1['gen']}")
        self.assertEqual((d["changed"], d["removed"]), ([], []), "nothing moved")
        card(self.root, "cb", 5000)                    # a new version: it moves to the top
        card(self.root, "ce", 4000)                    # a new card
        shutil.rmtree(self.root / "cc")                # one gone
        (self.root / "cd" / "signals.jsonl").write_text('{"kind": "archive", "value": true, "ts": 1}\n')   # archived
        self.later()
        _, d = self.get(f"&since={p1['gen']}")
        self.assertEqual([c["id"] for c in d["changed"]], ["cb", "ce"], "the changed rows, in the list's order")
        self.assertEqual(sorted(d["removed"]), ["cc", "cd"])
        self.assertNotEqual(d["gen"], p1["gen"])
        _, d2 = self.get(f"&since={d['gen']}")
        self.assertEqual((d2["changed"], d2["removed"]), ([], []), "and from the new generation, nothing")

    def test_a_signal_moves_the_generation_at_once(self):
        _, p1 = self.get("&limit=24")
        r = self.cl.post("/api/cards/cb/signal", json={"kind": "vote", "value": 1})
        self.assertEqual(r.status_code, 200)
        _, d = self.get(f"&since={p1['gen']}")          # no scan in between: the write said so
        self.assertEqual([c["id"] for c in d["changed"]], ["cb"])
        self.assertEqual(d["changed"][0]["vote"], 1)

    def test_another_life_starts_over(self):
        _, d = self.get("&since=ffffff.3")
        self.assertTrue(d["full"])
        code, _ = self.get("&gen=ffffff.3&skip=1")
        self.assertEqual(code, 410)

    def test_the_stamp_is_the_generation(self):
        a = self.cl.get("/api/cards/stamp").get_json()["stamp"]
        self.assertEqual(a, self.cl.get("/api/cards/stamp").get_json()["stamp"], "nothing moved")
        card(self.root, "ca", 7000)
        self.later()
        self.assertNotEqual(a, self.cl.get("/api/cards/stamp").get_json()["stamp"])


@unittest.skipUnless(HAVE_FLASK, "flask")
class Since(unittest.TestCase):
    """core/catalog.since on its own: a card removed and made again is changed, not gone."""
    def setUp(self):
        from core import catalog as CAT
        from core import stores as ST
        self.CAT, self.ST = CAT, ST
        self.root = Path(tempfile.mkdtemp())
        ST.use([self.root])
        CAT.reset()
        card(self.root, "ca", 1)

    def tearDown(self):
        self.ST.use(None)
        self.CAT.reset()
        shutil.rmtree(self.root, ignore_errors=True)

    def test_removed_then_made_again(self):
        t = self.CAT.token(self.CAT.scan(max_age=0))
        shutil.rmtree(self.root / "ca")
        self.CAT.scan(max_age=0)
        card(self.root, "ca", 2)
        self.CAT.scan(max_age=0)
        self.assertEqual(self.CAT.since(t), ({"ca"}, set()))


if __name__ == "__main__":
    unittest.main()
