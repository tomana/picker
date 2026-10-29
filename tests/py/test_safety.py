"""The server answers only to its own names; the examples' fake agents stay in their runs/."""
import _cfg  # noqa: F401
import subprocess
import sys
import unittest
from pathlib import Path

import server


class NamesTest(unittest.TestCase):
    def setUp(self):
        self.cl = server.app.test_client()

    def test_a_local_name_is_answered(self):
        for host in ("127.0.0.1:8080", "localhost", "[::1]:8080"):
            self.assertEqual(self.cl.get("/api/gate", headers={"Host": host}).status_code, 200, host)

    def test_another_name_is_refused(self):
        self.assertEqual(self.cl.get("/api/gate", headers={"Host": "rebound.example:8080"}).status_code, 403)

    def test_a_write_from_another_site_is_refused(self):
        r = self.cl.post("/api/agents/check", headers={"Host": "127.0.0.1:8080", "Origin": "https://elsewhere.example"},
                         data="x", content_type="text/plain")
        self.assertEqual(r.status_code, 403)
        r = self.cl.post("/api/agents/check", headers={"Host": "127.0.0.1:8080", "Origin": "null"}, data="x")
        self.assertEqual(r.status_code, 403)

    def test_a_configured_name_passes(self):
        names = server.CFG.names
        object.__setattr__(server.CFG, "names", ("picker.tailnet.example",))
        try:
            self.assertEqual(self.cl.get("/api/gate", headers={"Host": "picker.tailnet.example"}).status_code, 200)
        finally:
            object.__setattr__(server.CFG, "names", names)


class FakeAgentTest(unittest.TestCase):
    """The examples' fake agents take their paths from the brief's text: only their own runs/ is read or written."""

    def test_a_path_outside_runs_is_refused(self):
        for ex in ("visual", "music"):
            home = Path(__file__).resolve().parents[2] / "examples" / ex
            for brief in ("write ONE file, /tmp/outside.json now", f"write ONE file, {home}/runs/x/v1/loop.json now\n"
                          "Build from: /etc/hostname\n"):
                r = subprocess.run([sys.executable, str(home / "fake_agent.py"), brief], cwd=home,
                                   capture_output=True, text=True)
                self.assertEqual(r.returncode, 1, (ex, brief, r.stdout, r.stderr))
                self.assertIn("refused", r.stdout)


if __name__ == "__main__":
    unittest.main()
