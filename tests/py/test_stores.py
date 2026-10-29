"""Resolve cards across manifest stores, with unknown types falling back to the configured store."""
import _cfg  # noqa: F401
import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))       # picker/
from core import stores as ST                                       # noqa: E402


class StoresTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        cfg = SimpleNamespace(research=self.tmp / "research", data=self.tmp / "data")
        mans = [{"type": "own", "cards": "proj/cards"}, {"type": "plain"}, {"type": "own2", "cards": "proj/cards"}]
        self._C = ST.C
        ST.C = SimpleNamespace(get=lambda: cfg, manifests=lambda c=None: mans,
                               manifest=lambda t: next((m for m in mans if m["type"] == t), {}))
        self.own, self.plain = cfg.research / "proj" / "cards", cfg.data / "cards"
        for store, cid in ((self.own, "a1"), (self.plain, "b1"), (self.own, "_folded"), (self.plain, ".tmp")):
            (store / cid).mkdir(parents=True)
            (store / cid / "card.json").write_text(json.dumps({"id": cid}))

    def tearDown(self):
        ST.C = self._C
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_every_store_once_in_the_configs_order(self):
        self.assertEqual(ST.every(), [self.own, self.plain])

    def test_a_types_store(self):
        self.assertEqual(ST.of_type("own"), self.own)
        self.assertEqual(ST.of_type("plain"), self.plain)

    def test_a_card_by_its_id_alone(self):
        self.assertEqual(ST.card_dir("a1"), self.own / "a1")
        self.assertEqual(ST.card_dir("b1"), self.plain / "b1")
        self.assertEqual(ST.card_dir("nope"), self.own / "nope")      # where an unknown one would go

    def test_every_card_but_the_stores_own_folders(self):
        self.assertEqual(sorted(cid for cid, _ in ST.cards()), ["a1", "b1"])

    def test_a_tests_stores(self):
        ST.use([self.tmp / "x"])
        try:
            self.assertEqual(ST.every(), [self.tmp / "x"])
            self.assertEqual(ST.of_type("own"), self.tmp / "x")
        finally:
            ST.use(None)
        self.assertEqual(ST.every(), [self.own, self.plain])


class LogsTest(unittest.TestCase):
    """Keep each type log beside its cards and include every log in folds."""
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        cfg = SimpleNamespace(research=self.tmp / "research", data=self.tmp / "data")
        mans = [{"type": "own", "cards": "proj/cards"}, {"type": "plain"}]
        self._C = ST.C
        ST.C = SimpleNamespace(get=lambda: cfg, manifests=lambda c=None: mans,
                               manifest=lambda t: next((m for m in mans if m["type"] == t), {}))
        self.own, self.data = cfg.research / "proj" / "cards", cfg.data

    def tearDown(self):
        ST.C = self._C
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_homes(self):
        self.assertEqual(ST.homes(), [self.own, self.data])
        self.assertEqual(ST.home("own"), self.own)
        self.assertEqual(ST.home("plain"), self.data)

    def test_a_cup_round_stays_in_its_types_log(self):
        from core import cup as CU
        a = CU.open_cup(type="own", groups=[["x", "y", "z"]])
        b = CU.open_cup(type="plain", groups=[["p", "q", "r"]])
        CU.pick(a, 0, ["x", "y"])
        CU.pick(b, 0, ["q", "r"])
        own = (self.own / "cup.jsonl").read_text()
        plain = (self.data / "cup.jsonl").read_text()
        self.assertEqual((own.count(a), own.count(b), plain.count(a), plain.count(b)), (2, 0, 0, 2))
        self.assertEqual({c["type"] for c in CU.cups()}, {"own", "plain"})

    def test_a_timeline_stays_in_its_types_log(self):
        from core import arrange as AR
        t = AR.create(type="own", name="t")["id"]
        AR.put_clip(t, ref={"card": "c1", "part": "p1"}, track=0, start=0, len=2)
        AR.rename(t, "t2")
        self.assertEqual((self.own / "arrangements.jsonl").read_text().count(t), 3)
        self.assertFalse((self.data / "arrangements.jsonl").exists())
        self.assertEqual(AR.get(t)["name"], "t2")

    def test_a_tests_logs(self):
        ST.use_logs(self.tmp / "x")
        try:
            self.assertEqual(ST.homes(), [self.tmp / "x"])
            self.assertEqual(ST.log("cup.jsonl", type_="own"), self.tmp / "x" / "cup.jsonl")
        finally:
            ST.use_logs(None)


if __name__ == "__main__":
    unittest.main()
