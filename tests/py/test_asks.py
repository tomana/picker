"""A version's info shows the ask of the job that made it, not the card's first ask; temporary stores only."""

import _cfg  # noqa: F401
import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

PICKER = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(PICKER))

try:
    import flask
    HAVE_FLASK = True
except ImportError:
    HAVE_FLASK = False

JOBS = {
    "j1": {"id": "j1", "text": "  the first ask  ", "group": None, "status": "done", "result": "asktest01"},
    "j2": {"id": "j2", "text": "stretch it out", "group": None, "status": "done", "result": "asktest01"},
    "j3": {"id": "j3", "text": "AUTO — one clear step", "group": "auto", "status": "done", "result": "asktest01"},
}


@unittest.skipUnless(HAVE_FLASK, "needs flask")
class Asks(unittest.TestCase):
    def setUp(self):
        from api import cards as C
        self.C = C
        self.root = Path(tempfile.mkdtemp())
        C.ST.use([self.root / "cards"])
        C._cache.clear()
        d = self.root / "cards" / "asktest01"
        d.mkdir(parents=True)
        (d / "card.json").write_text(json.dumps({
            "id": "asktest01", "type": "fx_music", "name": "asktest", "attachments": [],
            "lineage": {"parent": None, "refs": [], "why": "the first ask"},
            "versions": [{"n": 1, "id": "v1", "job": "j1"}, {"n": 2, "id": "v2", "job": "j2"},
                         {"n": 3, "id": "v3", "job": "j3"}, {"n": 4, "id": "v4", "job": "gone"},
                         {"n": 5, "id": "v5"}]}))
        self.fold = C.Q.fold
        C.Q.fold = lambda root=None: JOBS
        self.app = flask.Flask(__name__)
        self.app.register_blueprint(C.bp)

    def tearDown(self):
        self.C.Q.fold = self.fold
        self.C.ST.use(None)
        self.C._cache.clear()
        shutil.rmtree(self.root, ignore_errors=True)

    def test_each_version_carries_its_own_jobs_ask(self):
        vs = self.app.test_client().get("/api/cards/asktest01").get_json()["versions"]
        self.assertEqual(vs[0]["asked"], "the first ask")
        self.assertEqual(vs[1]["asked"], "stretch it out")
        self.assertIsNone(vs[2]["asked"], "AUTO's prompt is nobody's ask")
        self.assertNotIn("asked", vs[3], "an unknown job leaves the card's lineage to answer")
        self.assertNotIn("asked", vs[4])

    def test_a_name_finds_its_card_with_what_its_title_adds(self):
        # the tile's title and the open card's id line copy m:asktest:v3 and m:asktest:bass:v3
        for ref in ("m:asktest", "m:asktest:v3", "m:asktest:bass:v3"):
            r = self.app.test_client().get(f"/api/cards/{ref}")
            self.assertEqual((r.status_code, (r.get_json() or {}).get("id")), (200, "asktest01"), ref)
        self.assertEqual(self.app.test_client().get("/api/cards/m:nothere:v3").status_code, 404)

    def test_the_cached_card_learns_nothing(self):
        self.app.test_client().get("/api/cards/asktest01")
        self.assertNotIn("asked", self.C.read_card("asktest01", detail=True)["versions"][1])


if __name__ == "__main__":
    unittest.main()
