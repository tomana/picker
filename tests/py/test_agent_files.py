"""Readable files must be explicitly allowed by type metadata, not merely share a repository root."""
import _cfg  # noqa: F401
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

try:
    from api import agents as AG  # noqa: E402
except ImportError:                 # a bare python3 without flask (t11 runs these under uv)
    AG = None


@unittest.skipIf(AG is None, "flask not installed")
class ReadableTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="agentfiles-")).resolve()
        repo = self.tmp / "repo"
        (repo / ".git").mkdir(parents=True)
        for f in ["music/agent/program.md", "music/agent/queue_runner.py", "music/notes/x.json",
                  "music/CLAUDE.md", "CLAUDE.md", "AGENTS.md", ".claude/skills/mix/SKILL.md",
                  "picker/data/prefs.jsonl", "music/cards/a/card.json", "music/cards/a/signals.jsonl",
                  "picker/README.md",
                  "music/thoughts/private.md", "music/agent/token.json", "other/CLAUDE.md",
                  "music/.private/settings.json", "music/agent/.cache/notes.md"]:
            (repo / f).parent.mkdir(parents=True, exist_ok=True)
            (repo / f).write_text("x")
        sib = self.tmp / "sibling"
        (sib / ".git").mkdir(parents=True)
        (sib / "notes.md").write_text("x")
        self.repo, self.sib = repo, sib
        self._types, self._root = AG._types, AG.ROOT
        AG._types = lambda: [{"type": "music", "researcher": "music/agent/queue_runner.py"}]
        AG.ROOT = repo
        import api.researchers as R
        self._rroot, R.ROOT = R.ROOT, repo
        from core import stores as ST
        self.ST = ST
        ST.use([repo / "music" / "cards"])

    def tearDown(self):
        import api.researchers as R
        AG._types, AG.ROOT, R.ROOT = self._types, self._root, self._rroot
        self.ST.use(None)

    def ok(self, rel, base=None):
        return AG._readable(((base or self.repo) / rel).resolve())

    def test_the_researchers_area(self):
        self.assertTrue(self.ok("music/agent/program.md"))
        self.assertTrue(self.ok("music/notes/x.json"))
        self.assertFalse(self.ok("music/agent/queue_runner.py"))     # code isn't an instruction file

    def test_instructions_and_skills_on_the_way_up(self):
        self.assertTrue(self.ok("music/CLAUDE.md"))
        self.assertTrue(self.ok("CLAUDE.md"))
        self.assertTrue(self.ok("AGENTS.md"))
        self.assertTrue(self.ok(".claude/skills/mix/SKILL.md"))
        self.assertFalse(self.ok("other/CLAUDE.md"))                  # not on a researcher's way up

    def test_the_store_and_the_picker_are_not_served(self):
        self.assertFalse(self.ok("picker/data/prefs.jsonl"))
        self.assertFalse(self.ok("music/cards/a/card.json"))            # in the researcher's area, but its store
        self.assertFalse(self.ok("music/cards/a/signals.jsonl"))
        self.assertFalse(self.ok("picker/README.md"))

    def test_secrets_and_siblings(self):
        self.assertFalse(self.ok("music/agent/token.json"))
        self.assertFalse(self.ok("music/.private/settings.json"))     # nothing inside a hidden folder
        self.assertFalse(self.ok("music/agent/.cache/notes.md"))
        self.assertFalse(self.ok("notes.md", self.sib))               # a repo beside this one


if __name__ == "__main__":
    unittest.main()
