"""A view's loop is served as its still and gif are, and a chosen face brings its loop along; temporary stores only."""

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
    import flask  # noqa: F401
    HAVE_FLASK = True
except ImportError:
    HAVE_FLASK = False


def view(slug, face=False):
    return {"slug": slug, "still": f"media/v1.{slug}.png", "gif": f"media/v1.{slug}.gif",
            "loop": f"media/v1.{slug}.mp4", **({"face": True} if face else {})}


@unittest.skipUnless(HAVE_FLASK, "needs flask")
class ViewLoops(unittest.TestCase):
    def setUp(self):
        from api import cards as C
        self.C = C
        self.root = Path(tempfile.mkdtemp())
        C.ST.use([self.root / "cards"])
        C._cache.clear()
        self.d = self.root / "cards" / "looptest01"
        self.d.mkdir(parents=True)
        media = {"still": "media/v1.png", "gif": "media/v1.gif", "loop": "media/v1.front.mp4",
                 "views": [view("front", face=True), view("side")]}
        (self.d / "card.json").write_text(json.dumps({
            "id": "looptest01", "type": "fx_visual", "name": "looptest", "attachments": [],
            "media": dict(media), "versions": [{"n": 1, "id": "v1", "media": media}]}))

    def tearDown(self):
        self.C.ST.use(None)
        self.C._cache.clear()
        shutil.rmtree(self.root, ignore_errors=True)

    def test_a_views_loop_is_a_url(self):
        m = self.C.read_card("looptest01")["versions"][0]["media"]
        self.assertEqual([v["loop"] for v in m["views"]],
                         ["/media/looptest01/v1.front.mp4", "/media/looptest01/v1.side.mp4"])

    def test_a_face_brings_its_loop(self):
        (self.d / "signals.jsonl").write_text(json.dumps({"ts": 1, "kind": "face", "value": "side"}) + "\n")
        c = self.C.read_card("looptest01")
        self.assertEqual(c["versions"][0]["media"]["loop"], "/media/looptest01/v1.side.mp4")
        self.assertEqual(c["media"]["loop"], "/media/looptest01/v1.side.mp4", "the card's own picture too")


if __name__ == "__main__":
    unittest.main()
