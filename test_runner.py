import json
import tempfile
import unittest
from pathlib import Path

import runner


class RunnerStateTest(unittest.TestCase):
    def test_persists_phase_log_and_failure(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            log = root / "logs" / "runner_1.log"
            runner.write(root, agent="antigravity",
                         model="Gemini 3.5 Flash (High)",
                         log=str(log), phase="sanity")

            state = runner.read(root)
            self.assertTrue(state["running"])
            self.assertEqual(state["phase"], "sanity")
            self.assertEqual(state["log"], str(log))

            runner.update(root, phase="running")
            self.assertEqual(runner.read(root)["phase"], "running")

            runner.finish(root, error="agy sanity check timed out",
                          exit_code=1)
            state = runner.read(root)
            self.assertFalse(state["running"])
            self.assertEqual(state["phase"], "failed")
            self.assertEqual(state["exit_code"], 1)
            self.assertEqual(state["error"], "agy sanity check timed out")
            self.assertIsInstance(state["ended_at"], float)

    def test_old_state_gets_new_fields(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "runner.json").write_text(json.dumps({"running": False}))
            state = runner.read(root)
            for key in ("phase", "log", "error", "exit_code", "ended_at"):
                self.assertIn(key, state)


if __name__ == "__main__":
    unittest.main()
