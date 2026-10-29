"""Each agent lane claims only its own jobs, so usage waits do not block other lanes."""
import _cfg  # noqa: F401
import sys
import tempfile
import time
import unittest
from pathlib import Path

PICKER = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(PICKER))
from core import queue as Q  # noqa: E402


class CodexLaneTest(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="lane-"))

    def test_each_runner_claims_its_own_lane(self):
        c = Q.enqueue(type="fx_music", kind="inspire", card="x", text="", backend="codex", root=self.root)
        a = Q.enqueue(type="fx_music", kind="inspire", card="x", text="", root=self.root)
        self.assertEqual(Q.lane_for(c), Q.CODEX_LANE)
        self.assertIsNone(Q.lane_for(a))
        main = Q.claim_next("fx_music:claude", types=["fx_music"], root=self.root)
        self.assertEqual(main["id"], a["id"])
        self.assertIsNone(Q.claim_next("fx_music:claude", types=["fx_music"], root=self.root))
        lane = Q.claim_next("fx_music:claude@codex", types=["fx_music"], root=self.root)
        self.assertEqual(lane["id"], c["id"])

    def test_a_due_codex_job_goes_back_to_the_codex_lane(self):
        c = Q.enqueue(type="fx_music", kind="inspire", card="x", text="", backend="codex", root=self.root)
        Q.claim_next("fx_music:claude@codex", types=["fx_music"], root=self.root)
        Q.wait(c["id"], agent="codex", until=time.time() - 1, why="limit", attempt=1, root=self.root)
        self.assertIsNone(Q.claim_next("fx_music:claude", types=["fx_music"], root=self.root))
        again = Q.claim_next("fx_music:claude@codex", types=["fx_music"], root=self.root)
        self.assertEqual(again["id"], c["id"])

    def test_antigravity_has_a_lane_of_its_own_too(self):
        g = Q.enqueue(type="fx_music", kind="inspire", card="x", text="", backend="antigravity", root=self.root)
        c = Q.enqueue(type="fx_music", kind="inspire", card="x", text="", backend="claude", root=self.root)
        r = Q.enqueue(type="fx_music", kind="inspire", card="x", text="", backend="render", root=self.root)
        self.assertEqual([Q.lane_for(j) for j in (g, c, r)], ["antigravity", None, None])
        self.assertEqual(Q.claim_next("fx_music:claude", types=["fx_music"], root=self.root)["id"], c["id"])
        self.assertEqual(Q.claim_next("fx_music:claude", types=["fx_music"], root=self.root)["id"], r["id"])
        self.assertIsNone(Q.claim_next("fx_music:claude", types=["fx_music"], root=self.root))
        self.assertIsNone(Q.claim_next("fx_music:claude@codex", types=["fx_music"], root=self.root))
        self.assertEqual(Q.claim_next("fx_music:claude@antigravity", types=["fx_music"], root=self.root)["id"],
                         g["id"])

    def test_other_types_have_no_codex_lane(self):
        self.assertIsNone(Q.lane_for({"type": "fx_visual", "kind": "revise", "backend": "codex"}))


if __name__ == "__main__":
    unittest.main()
