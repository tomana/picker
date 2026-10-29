"""Read usage through a fake CLI, never login tokens or a real agent binary."""
import _cfg  # noqa: F401
import json
import sys
import tempfile
import unittest
from datetime import datetime
from pathlib import Path
from unittest import mock
from zoneinfo import ZoneInfo

PICKER = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(PICKER))
from core import agents as A  # noqa: E402

OSLO = ZoneInfo("Europe/Oslo")
NOW = datetime(2026, 10, 23, 20, 30, tzinfo=OSLO).timestamp()
ANSWER = ("You are currently using your subscription to power your Claude Code usage\n\n"
          "Current session: 37% used · resets Oct 23, 11:19pm (Europe/Oslo)\n"
          "Current week (all models): 61% used · resets Oct 24, 9pm (Europe/Oslo)\n"
          "Current week (Fable): 12% used · resets Oct 24, 9pm (Europe/Oslo)\n")


class ClaudeResetTest(unittest.TestCase):
    def test_the_shapes_the_cli_prints(self):
        self.assertEqual(A.claude_reset("Oct 23, 11:19pm (Europe/Oslo)", NOW), "2026-10-23T23:19:00+02:00")
        self.assertEqual(A.claude_reset("Oct 24, 9pm (Europe/Oslo)", NOW), "2026-10-24T21:00:00+02:00")
        self.assertEqual(A.claude_reset("11:19pm (Europe/Oslo)", NOW), "2026-10-23T23:19:00+02:00")
        self.assertEqual(A.claude_reset("8:05am (Europe/Oslo)", NOW), "2026-10-24T08:05:00+02:00")

    def test_january_read_in_december_is_next_year(self):
        dec = datetime(2026, 12, 30, 12, 0, tzinfo=OSLO).timestamp()
        self.assertTrue(A.claude_reset("Jan 2, 3am (Europe/Oslo)", dec).startswith("2027-01-02T03:00"))

    def test_anything_else_is_no_known_reset(self):
        for t in (None, "", "soon", "Oct 24, 9pm (Mars/Base)", "Foo 24, 9pm (Europe/Oslo)"):
            self.assertIsNone(A.claude_reset(t, NOW), t)


class ClaudeUsageTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="usage-cli-"))

    def fake(self, result=None, raw=None):
        exe = self.tmp / "claude"
        out = raw if raw is not None else json.dumps({"type": "result", "result": result})
        (self.tmp / "out.txt").write_text(out)
        exe.write_text(f"#!/bin/sh\ncat '{self.tmp / 'out.txt'}'\n")
        exe.chmod(0o755)
        return mock.patch.object(A, "binary", lambda cli, reg=None: str(exe) if cli == "claude" else None)

    def test_reads_session_and_week_from_the_cli(self):
        with self.fake(ANSWER):
            d = A.claude_usage(NOW, cwd=self.tmp)
        self.assertEqual(d["session"], {"pct": 37.0, "resets_at": "2026-10-23T23:19:00+02:00"})
        self.assertEqual(d["weekly"], {"pct": 61.0, "resets_at": "2026-10-24T21:00:00+02:00"})

    def test_an_answer_without_numbers_raises_with_its_last_line(self):
        with self.fake("Usage is not available for API-key logins"):
            with self.assertRaisesRegex(RuntimeError, "API-key"):
                A.claude_usage(NOW, cwd=self.tmp)
        with self.fake(raw="not json"):
            with self.assertRaises(RuntimeError):
                A.claude_usage(NOW, cwd=self.tmp)

    def test_no_cli_is_its_own_error(self):
        with mock.patch.object(A, "binary", lambda cli, reg=None: None):
            with self.assertRaises(A.CLIMissing):
                A.claude_usage(NOW, cwd=self.tmp)

    def test_the_picker_reads_no_credentials(self):
        src = "\n".join(p.read_text() for p in [PICKER / "server.py", *PICKER.glob("core/*.py")])
        self.assertNotIn(".credentials.json", src)
        self.assertNotIn("accessToken", src)


if __name__ == "__main__":
    unittest.main()
