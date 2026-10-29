"""agy's two pools (gemini, claude/gpt) stay apart across reads, admission, waits and the scheduler; a pool that
names no models (one model's own quota) is read but not tracked."""
import _cfg  # noqa: F401
import copy
import json
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest import mock

import server
from core import agents as A, agy as AG, budget as B, prefs as P, queue as Q

# a real answer's shape: Gemini Models, Claude and GPT models, and a separate single-model pool
RAW = json.loads((Path(__file__).resolve().parents[1] / "fixture/agy_usage_three_groups.json").read_text())
NOW = datetime(2026, 10, 28, 14, 7, 43, tzinfo=timezone.utc)
MESSAGE = "RESOURCE_EXHAUSTED (code 429): Individual quota reached … Resets in 102h47m14s"
LATER = datetime(2026, 10, 28, 18, 22, 37, tzinfo=timezone.utc)


def reading(raw=RAW):
    with (mock.patch.object(A, "binary", return_value="fake-agy"),
          mock.patch.object(server.subprocess, "run", return_value=mock.Mock(returncode=0, stdout=json.dumps(raw), stderr="")),
          mock.patch.object(server.time, "time", return_value=NOW.timestamp()),
          mock.patch.dict(server._AGY_CACHE, {}, clear=True)):
        return server._usage_all_agy(NOW.timestamp(), True)


class Groups(unittest.TestCase):
    def test_two_pools_tracked_and_a_single_model_pool_not(self):
        source = reading()
        self.assertEqual(len(source["groups"]), 3)
        families = sorted(str(g["family"]) for g in source["groups"].values())
        self.assertEqual(families, ["None", "claude_gpt", "gemini"])
        self.assertEqual(AG.window(source, "gemini-4-pro-high")["used_pct"], 0)
        self.assertEqual(AG.window(source, "gemini-4-argon-high")["used_pct"], 0)    # counts as gemini
        for model in ("claude-opus-5-5-high", "gpt-oss-120b-medium"):
            self.assertEqual(AG.window(source, model)["used_pct"], 62)

    def test_an_unknown_fourth_group_is_read_not_dropped(self):
        raw = copy.deepcopy(RAW)
        raw["command"]["data"]["groups"].append({"name": "Video quota", "description": "Video generation",
            "buckets": [{"window": "daily", "remaining_fraction": .5, "reset_time": "2030-01-01T00:00:00Z"}]})
        source = reading(raw)
        self.assertEqual(source["groups"]["video_quota"]["windows"], {"daily": "video_quota:daily"})
        self.assertIsNone(source["groups"]["video_quota"]["family"])

    def test_a_quota_reached_refusal_is_a_plain_failure(self):
        res = A.AgentResult("antigravity", "gemini-4-argon-high", None, 1, text=MESSAGE)
        failure = A.failure(res, "agy")
        self.assertIsInstance(failure, A.AgentFailed)
        self.assertNotIsInstance(failure, A.AgentLimited)


class Admission(unittest.TestCase):
    def setUp(self):
        self.root = Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.prefs = {"agents": {"antigravity": {"model": "gemini-4-pro-high", "session_cap": 60}}}
        self.enterContext(mock.patch.object(P, "fold", side_effect=lambda *a: self.prefs))
        self.source = reading()
        self.reader = self.enterContext(mock.patch.object(B, "_reader", return_value=self.source))
        self.enterContext(mock.patch.dict(B._samples, {}, clear=True))
        self.enterContext(mock.patch.object(A, "execution", return_value={"allowed": True}))

    def test_the_cap_follows_the_jobs_models_pool(self):
        gemini = B.check("antigravity", now=NOW.timestamp(), root=self.root)
        self.assertTrue(gemini["allowed"])
        for model in ("claude-opus-5-5-high", "gpt-oss-120b-medium"):
            held = B.check("antigravity", model=model, now=NOW.timestamp(), root=self.root)
            self.assertFalse(held["allowed"])
            self.assertEqual(held["used_pct"], 62)
        self.assertTrue(B.check("antigravity", model="gemini-4-argon-high", now=NOW.timestamp(), root=self.root)["allowed"])

    def test_a_pools_known_limit_holds_only_that_pool(self):
        job = Q.enqueue(type="t", kind="seed", backend="antigravity", model="claude-opus-5-5-high", root=self.root)
        Q.defer(job["id"], agent="antigravity", until=LATER.timestamp(), why="provider limit", quota_group="claude_gpt",
                root=self.root)
        now = NOW.timestamp()
        self.assertEqual(A.limited_until("antigravity", model="gpt-oss-120b-medium", now=now, root=self.root),
                         LATER.timestamp())
        self.assertIsNone(A.limited_until("antigravity", model="gemini-4-pro-high", now=now, root=self.root))
        self.reader.assert_not_called()

    def test_a_known_limit_expires_at_its_recorded_reset(self):
        job = Q.enqueue(type="t", kind="seed", backend="antigravity", model="gemini-4-pro-high", root=self.root)
        Q.defer(job["id"], agent="antigravity", until=LATER.timestamp(), why="provider limit", quota_group="gemini",
                root=self.root)
        self.assertEqual(A.limited_until("antigravity", model=job["model"], now=NOW.timestamp(), root=self.root),
                         LATER.timestamp())
        self.assertIsNone(A.limited_until("antigravity", model=job["model"], now=LATER.timestamp() + 1, root=self.root))


if __name__ == "__main__":
    unittest.main()
