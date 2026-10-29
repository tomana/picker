"""AUTO state and made-card lists are type-scoped; use temporary stores and a fake queue fold."""

import _cfg  # noqa: F401
import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

PICKER = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(PICKER))

from core import auto as AU                            # noqa: E402

try:
    import flask                                       # noqa: F401
    HAVE_FLASK = True
except ImportError:
    HAVE_FLASK = False


class Scope(unittest.TestCase):
    def test_fx_music_is_one_of_autos_tabs(self):
        s = AU.settings({"auto": {"on": True, "types": ["fx_visual", "fx_music", "fx_show"]}})
        self.assertEqual(s["types"], ["fx_visual", "fx_music", "fx_show"])

    def test_an_off_auto_works_no_tab(self):
        # Starting one tab must not revive stale AUTO state in another.
        self.assertEqual(AU.settings({"auto": {"on": False, "types": ["fx_visual"]}})["types"], [])
        self.assertEqual(AU.settings({"auto": {"on": True}})["types"], [])
        self.assertEqual(AU.settings({})["types"], [])

    @unittest.skipUnless(HAVE_FLASK, "needs flask")
    def test_the_route_offers_fx_music_too(self):
        from api import auto as A
        types = A._auto_types()
        self.assertIn("fx_music", types)
        self.assertIn("fx_visual", types)


@unittest.skipUnless(HAVE_FLASK, "needs flask")
class Made(unittest.TestCase):
    def setUp(self):
        from flask import Flask
        from api import auto as A
        from api import cards as C
        from core import queue as Q
        from core import stores as ST
        self.A, self.C, self.Q, self.ST = A, C, Q, ST
        from core import autolog as AL
        self.root = Path(tempfile.mkdtemp())
        self.old = Q.fold
        ST.use([self.root / "cards"])
        ST.use_logs(self.root / "logs")
        C._cache.clear()
        for e in ({"event": "queued", "job": "j1", "card": "cardA", "kind": "revise", "keep": False},
                  {"event": "made", "job": "j1", "card": "cardA", "version": 2, "held": False}):
            AL.append("fx_visual", e)
        d = self.root / "cards" / "cardA"
        d.mkdir(parents=True)
        (d / "card.json").write_text(json.dumps({
            "id": "cardA", "type": "fx_visual", "label": "a card", "attachments": [],
            "versions": [{"n": 1, "id": "v1", "created": 1000, "media": {"still": "media/a1.png"}},
                         {"n": 2, "id": "v2", "created": 2050, "media": {"still": "media/a2.png"}},
                         {"n": 3, "id": "v3", "created": 9000, "media": {"still": "media/a3.png"}}]}))
        jobs = {
            "j1": {"id": "j1", "group": "auto", "type": "fx_visual", "kind": "revise", "card": "cardA",
                   "status": "done", "result": "cardA", "started": 2000, "ended": 2100,
                   "backend": "codex"},
            "j2": {"id": "j2", "group": "auto", "type": "fx_visual", "kind": "revise", "card": "cardA",
                   "status": "running", "started": 9500, "backend": "claude"},
            "j3": {"id": "j3", "group": "", "type": "fx_visual", "kind": "revise", "card": "cardA",
                   "status": "done", "result": "cardA", "started": 8990, "ended": 9010},
            "j4": {"id": "j4", "group": "auto", "type": "fx_show", "kind": "revise", "card": "x",
                   "status": "done", "started": 1, "ended": 2},
        }
        Q.fold = lambda root=None: jobs
        app = Flask(__name__)
        app.register_blueprint(A.bp)
        self.cl = app.test_client()

    def tearDown(self):
        self.ST.use(None)
        self.ST.use_logs(None)
        self.Q.fold = self.old
        self.C._cache.clear()
        shutil.rmtree(self.root, ignore_errors=True)

    def test_made_is_what_the_log_says_it_made(self):
        d = self.cl.get("/api/auto/made?type=fx_visual").get_json()
        self.assertEqual([m["job"] for m in d["made"]], ["j1"], "only AUTO's own, from its log")
        m = d["made"][0]
        self.assertEqual((m["card"], m["vid"], m["agent"]), ("cardA", "v2", "codex"))
        self.assertEqual(m["still"], "/media/cardA/a2.png")
        self.assertEqual([x["job"] for x in d["making"]], ["j2"], "and what it is making now")

    def test_another_type_sees_none_of_it(self):
        d = self.cl.get("/api/auto/made?type=fx_show").get_json()
        self.assertEqual((d["made"], d["making"]), ([], []))


if __name__ == "__main__":
    unittest.main()


@unittest.skipUnless(HAVE_FLASK, "needs flask")
class AutoModel(unittest.TestCase):
    """PUT /api/auto: the model AUTO runs with is one its agent offers; another agent named alone resets it."""

    def setUp(self):
        from unittest import mock
        from flask import Flask
        from api import auto as AA
        from core import agents as A, prefs as P
        self.saved = []
        self.enterContext(mock.patch.object(P, "set", side_effect=lambda k, v: self.saved.append(v)))
        self.enterContext(mock.patch.object(AU, "settings", return_value={**AU.DEFAULTS, "agent": "claude"}))
        app = Flask(__name__)
        app.register_blueprint(AA.bp)
        self.c = app.test_client()
        self.mid = A.cached_catalogue("claude")["models"][0]["id"]

    def test_a_runners_kick_makes_auto_look_now(self):
        from unittest import mock
        with mock.patch.object(AU, "kick") as kick:
            self.assertEqual(self.c.post("/api/auto/kick", json={}).status_code, 200)
        kick.assert_called_once_with()

    def test_a_model_the_agent_offers_is_saved(self):
        self.assertEqual(self.c.put("/api/auto", json={"model": self.mid}).status_code, 200)
        self.assertEqual(self.saved[-1]["model"], self.mid)

    def test_a_model_it_does_not_offer_is_refused(self):
        self.assertEqual(self.c.put("/api/auto", json={"model": "no-such-model"}).status_code, 400)
        self.assertEqual(self.saved, [])

    def test_another_agent_named_alone_resets_the_model(self):
        self.c.put("/api/auto", json={"agent": "codex"})
        self.assertIsNone(self.saved[-1]["model"])
