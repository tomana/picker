"""Freeze selected versions, votes, cuts and request images into job context using temporary stores."""
import _cfg  # noqa: F401
import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from core import researcher as RS  # noqa: E402
from core import stores as ST  # noqa: E402


class ContextTest(unittest.TestCase):
    def setUp(self):
        self.store = Path(tempfile.mkdtemp())
        ST.use([self.store])
        d = self.store / "zz1"
        (d / "media").mkdir(parents=True)
        for f in ("v1__a.mp3", "v1__b.mp3", "attach_1.png"):
            (d / "media" / f).write_bytes(b"x")
        (d / "card.json").write_text(json.dumps({"id": "zz1", "type": "t", "versions": [
            {"n": n, "id": f"v{n}", "rationale": f"take {n}", "agent": "claude", "parts": [{"id": f"p{n}"}]}
            for n in (1, 2, 3, 4)]}))
        sig = [{"kind": "vote", "version": 2, "value": 1}, {"kind": "vote", "version": 3, "value": -1},
               {"kind": "held", "version": 4}]
        (d / "signals.jsonl").write_text("".join(json.dumps(s) + "\n" for s in sig))

    def tearDown(self):
        ST.use(None)
        shutil.rmtree(self.store, ignore_errors=True)

    def test_the_versions_their_votes_and_the_base(self):
        ctx = RS.context({"card": "zz1"})
        self.assertEqual([(v["n"], v["vote"], bool(v.get("hidden"))) for v in ctx["versions"]],
                         [(1, 0, False), (2, 1, False), (3, -1, False), (4, 0, True)])
        self.assertEqual(ctx["base"]["n"], 2)             # v4 an unkept held try, v3 voted down: v2
        self.assertEqual(RS.context({"card": "zz1", "version": 3})["base"]["n"], 3)    # the one on screen
        self.assertEqual([Path(p).name for p in ctx["attachments"]], ["attach_1.png"])

    def test_a_cut_hears_what_was_kept_when_it_was_sent(self):
        job = {"card": "zz1", "source": {"cut": ["b"], "keep": ["media/v1__a.mp3"]}}
        kept = RS.context(job)["kept"]
        self.assertEqual(kept, [str(self.store / "zz1" / "media" / "v1__a.mp3")])
        with open(self.store / "zz1" / "signals.jsonl", "a") as f:        # Later cuts must not change frozen job context.
            f.write(json.dumps({"kind": "cut", "version": 1, "part": "a", "value": True}) + "\n")
        self.assertEqual(RS.context(job)["kept"], kept)                   # the job hears it as it was
        self.assertEqual(RS.context({"card": "zz1", "source": {"cut": [], "keep": ["x"]}})["kept"], [])

    def test_the_helpers_read_the_context_the_job_came_with(self):
        handed = {"versions": [{"n": 1, "id": "v1", "vote": 0, "agent": None, "rationale": "", "parts": []}],
                  "base": None, "attachments": [], "requests": [], "kept": []}
        job = {"card": "zz1", "context": handed}
        self.assertIs(RS.context_of(job), handed)
        self.assertEqual(RS.version_votes(job), (handed["versions"], None))
        self.assertEqual(RS.attachment_note(job, self.store), "")      # the card's image is not in what it was handed
        self.assertIn("attach_1.png", RS.attachment_note({"card": "zz1"}, self.store))

    def test_a_job_with_no_card(self):
        self.assertEqual(RS.context({"kind": "seed"}),
                         {"versions": [], "base": None, "attachments": [], "requests": [], "kept": []})


if __name__ == "__main__":
    unittest.main()
