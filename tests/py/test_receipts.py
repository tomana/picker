"""Hash invocation inputs independently; later edits cannot alter receipts and receipt failures cannot fail jobs."""
import _cfg  # noqa: F401
import contextlib
import json
import shutil
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(_cfg.PICKER))
from core import agents as A  # noqa: E402
from core import receipts as R  # noqa: E402
from core import trace as T  # noqa: E402


def res(exit=0, text="ok", model="m"):
    return A.AgentResult(agent="codex", model=model, effort=None, exit=exit, text=text, shown=[text])


class ReceiptTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.cwd = self.tmp / "work"
        self.cwd.mkdir()
        (self.cwd / "AGENTS.md").write_text("the project's rules, as they were\n")
        (self.cwd / "program.md").write_text("the program, as it was\n")
        self.store = self.tmp / "receipts"
        self._root = R._root
        R._root = lambda root=None: Path(root) if root else self.store

    def tearDown(self):
        R._root = self._root
        shutil.rmtree(self.tmp, ignore_errors=True)

    def reg(self, **codex):
        r = json.loads(json.dumps(A.load()))
        r["agents"]["codex"].update(codex)
        return r

    def run_codex(self, job, once=None, **k):
        """`once` stands in for one CLI run (core/agents.run); None: the caller has patched it."""
        with T.bound(job=job, type="t"), (mock.patch.object(A, "run", once) if once else contextlib.nullcontext()):
            return A.run_job("codex", "Read program.md, then make one card.", self.cwd, Path("/dev/null"), **k)

    def test_one_receipt_per_invocation(self):
        self.run_codex("j1", lambda n, p, c, l, *, model, **k: res(0, "ok", model), reg=self.reg(model="tier-a"))
        got = R.of_job("j1")
        self.assertEqual([(x["model"], x["ok"]) for x in got], [("tier-a", True)])
        x = got[0]
        self.assertEqual((x["job"], x["agent"], x["cli"], x["cwd"]), ("j1", "codex", "codex", str(self.cwd)))
        self.assertEqual(R.text(x["prompt"]["sha256"]), "Read program.md, then make one card.")
        self.assertNotIn("Read program.md, then make one card.", x["argv"])            # by reference in the argv
        why = {f["path"].split("/")[-1]: f for f in x["files"]}
        self.assertIn("AGENTS.md", why)
        self.assertEqual(why["program.md"]["why"], "named in the brief")

    def test_an_edited_instruction_file_changes_no_old_receipt(self):
        self.run_codex("j2", lambda *a, **k: res(0))
        f = next(f for f in R.of_job("j2")[0]["files"] if f["path"].endswith("program.md"))
        (self.cwd / "program.md").write_text("the program, rewritten afterwards\n")
        self.assertEqual(R.text(f["sha256"]), "the program, as it was\n")

    def test_two_jobs_at_once_keep_their_own(self):
        out = {}

        def job(jid):
            out[jid] = self.run_codex(jid).ok
        ts = [threading.Thread(target=job, args=(j,)) for j in ("ja", "jb")]
        with mock.patch.object(A, "run", lambda *a, **k: res(0)):      # once for both threads
            [t.start() for t in ts]
            [t.join() for t in ts]
        self.assertEqual(out, {"ja": True, "jb": True})
        self.assertEqual([(len(R.of_job(j)), R.of_job(j)[0]["job"]) for j in ("ja", "jb")], [(1, "ja"), (1, "jb")])

    def test_a_receipt_that_cannot_be_written_never_fails_the_job(self):
        real = R.start
        R.start = lambda **k: (_ for _ in ()).throw(OSError("disk full"))
        try:
            self.assertTrue(self.run_codex("j3", lambda *a, **k: res(0)).ok)
        finally:
            R.start = real
        self.assertEqual(R.of_job("j3"), [])

    def test_a_tools_receipt_says_what_it_ran_on(self):
        src = self.tmp / "take.wav"
        src.write_bytes(b"RIFF made up")
        with T.bound(job="j5", type="t"):
            with R.tool("a sweep", inputs={"seed": 7, "knobs": {"a": 0.5}}, argv=["tool", "--x"], files=[src]):
                pass
            with self.assertRaises(RuntimeError):
                with R.tool("a tool", inputs={"seed": 8}):
                    raise RuntimeError("the render failed")
        ok, failed = R.of_job("j5")
        self.assertEqual((ok["tool"], ok["inputs"]["seed"], ok["argv"], ok["ok"]), ("a sweep", 7, ["tool", "--x"], True))
        import hashlib
        self.assertEqual(ok["input_files"][0]["sha256"], hashlib.sha256(b"RIFF made up").hexdigest())
        self.assertEqual((failed["ok"], failed["why"]), (False, "RuntimeError: the render failed"))

    def test_the_routes(self):
        try:
            from flask import Flask
        except ImportError:
            self.skipTest("flask")
        from api import receipts as AR
        self.run_codex("j4", lambda *a, **k: res(0))
        app = Flask(__name__)
        app.register_blueprint(AR.bp)
        c = app.test_client()
        got = c.get("/api/queue/j4/receipts").get_json()["receipts"]
        self.assertEqual(len(got), 1)
        self.assertEqual(c.get(f"/api/receipts/text/{got[0]['prompt']['sha256']}").get_json()["text"],
                         "Read program.md, then make one card.")
        self.assertEqual(c.get("/api/receipts/text/nothex").status_code, 404)
        self.assertEqual(c.get("/api/queue/nojob/receipts").get_json()["receipts"], [])    # from before receipts


if __name__ == "__main__":
    unittest.main()
