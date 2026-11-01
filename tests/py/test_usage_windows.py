import _cfg  # noqa: F401
import time
import unittest
from datetime import datetime, timedelta, timezone
from unittest import mock

import server

ISO = "%Y-%m-%dT%H:%M:%SZ"


class Windows(unittest.TestCase):
    """A usage window is always percent USED; a reset in the past reads 0."""

    def setUp(self):
        self.now = time.time()
        self.fut = (datetime.now(timezone.utc) + timedelta(hours=3)).strftime(ISO)
        self.past = (datetime.now(timezone.utc) - timedelta(hours=1)).strftime(ISO)

    def w(self, pct, resets):
        x = server._usage_window("session", "s", pct, resets, self.now)
        return x["used_pct"], x["post_reset"]

    def test_normalised(self):
        self.assertEqual(self.w(41.0, self.fut), (41.0, False))
        self.assertEqual(self.w(41.0, self.past), (0.0, True), "a reset that passed")
        self.assertEqual(self.w(140.0, self.fut), (100.0, False), "clamped")
        self.assertEqual(self.w(None, None), (None, False), "no reading stays none")
        self.assertEqual(self.w(41.0, "not-a-date"), (41.0, False), "an unreadable reset isn't a reset")

    def test_a_press_refreshes_only_its_source(self):
        seen = []
        with mock.patch.object(server, "_claude_usage", lambda f: (seen.append(("anthropic", f)), {})[1]), \
             mock.patch.object(server, "_codex_usage", lambda f: (seen.append(("codex", f)), {})[1]), \
             mock.patch.object(server, "_usage_all_agy", lambda now, f: (seen.append(("agy", f)), {"windows": []})[1]), \
             mock.patch("core.agents.binary", lambda cli: True):
            server.app.test_client().get("/api/usage/all?refresh=codex")
            self.assertEqual(sorted(seen), [("agy", False), ("anthropic", False), ("codex", True)])
            seen.clear()
            server.app.test_client().get("/api/usage/all?refresh=true")
            self.assertEqual(sorted(seen), [("agy", True), ("anthropic", True), ("codex", True)])


if __name__ == "__main__":
    unittest.main()
