"""Large pools must move to a referenced file so the brief fits within a single CLI argument."""

import _cfg  # noqa: F401
import sys
import tempfile
import unittest
from pathlib import Path

PICKER = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(PICKER))
from core import survey as SV                          # noqa: E402


def pool(n):
    return [{"card": f"c{i}", "label": f"card {i}", "versions": 1, "part": None, "node": None, "frag": None,
             "vote": 0, "last_auto": None, "pools": []} for i in range(n)]


class Pool(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.job = {"id": "j1", "type": "t", "text": "the empty ones"}

    def tearDown(self):
        self.tmp.cleanup()

    def brief(self, n):
        return SV.brief(self.job, {"label": "t"}, pool(n), cwd=self.root, here=self.root / "run",
                        store=self.root / "cards")

    def test_a_small_pool_is_listed_in_the_brief(self):
        b = self.brief(3)
        self.assertIn("  - c2 «card 2»", b)
        self.assertFalse(SV.pool_path(self.job, self.root / "run").exists())

    def test_a_big_pool_goes_to_a_file(self):
        n = SV.INLINE * 50
        b = self.brief(n)
        self.assertLess(len(b.encode()), 4096)
        self.assertNotIn("  - c1 ", b)
        self.assertIn("run/logs/survey_j1_pool.txt", b)
        self.assertIn("cards/<card id>/card.json", b)
        rows = SV.pool_path(self.job, self.root / "run").read_text().splitlines()
        self.assertEqual(len(rows), n)
        self.assertTrue(rows[-1].startswith(f"  - c{n - 1} «card {n - 1}»"))


if __name__ == "__main__":
    unittest.main()
