"""Whole-version playback must exclude cut bands; use only temporary stores and mix caches."""

import _cfg  # noqa: F401
import json
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

PICKER = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(PICKER))

try:
    import flask                                       # noqa: F401
    HAVE_FLASK = True
except ImportError:
    HAVE_FLASK = False

HAVE_FFMPEG = shutil.which("ffmpeg") is not None and shutil.which("ffprobe") is not None


def tone(path: Path, freq: int, secs: float = 2.0):
    src = f"sine=frequency={freq}:duration={secs}" if freq else f"anullsrc=d={secs}"
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", src, "-ac", "1",
                    "-c:a", "libmp3lame", "-q:a", "4", str(path)], check=True)


def mean_db(path: Path) -> float:
    r = subprocess.run(["ffmpeg", "-v", "info", "-i", str(path), "-af", "volumedetect",
                        "-f", "null", "-"], capture_output=True, text=True)
    line = next(x for x in r.stderr.splitlines() if "mean_volume" in x)
    return float(line.split("mean_volume:")[1].split("dB")[0])


@unittest.skipUnless(HAVE_FLASK and HAVE_FFMPEG, "needs flask and ffmpeg")
class CutMix(unittest.TestCase):
    def setUp(self):
        from api import cards as C
        self.C = C
        self.root = Path(tempfile.mkdtemp())
        self.store = self.root / "cards"
        self.old = C.MIX_DIR
        C.ST.use([self.store])
        C.MIX_DIR = self.root / "mix"
        C._cache.clear()
        self.cid = "cuttest01"
        d = self.store / self.cid
        (d / "media").mkdir(parents=True)
        tone(d / "media" / "v1__a.mp3", 440)
        tone(d / "media" / "v1__b.mp3", 0)            # silence: what is left after a ✕ on a
        tone(d / "media" / "v1__mix.mp3", 440)
        (d / "card.json").write_text(json.dumps({
            "id": self.cid, "type": "fx_music", "name": "cuttest", "attachments": [],
            "media": {"audio": "media/v1__mix.mp3"},
            "versions": [{"n": 1, "id": "v1", "duration": 2,
                          "media": {"audio": "media/v1__mix.mp3"},
                          "parts": [{"id": "a", "kind": "voice", "audio": "media/v1__a.mp3"},
                                    {"id": "b", "kind": "voice", "audio": "media/v1__b.mp3"}]}]}))

    def tearDown(self):
        self.C.ST.use(None)
        self.C.MIX_DIR = self.old
        self.C._cache.clear()
        shutil.rmtree(self.root, ignore_errors=True)

    def cut(self, voice, value=True):
        sp = self.store / self.cid / "signals.jsonl"
        with sp.open("a") as f:
            f.write(json.dumps({"ts": time.time(), "kind": "archive", "voice": voice,
                                "value": value}) + "\n")
        time.sleep(0.02)                               # read_card's cache is keyed on mtimes

    def test_a_bundle_item_voice_is_cut_in_its_version_and_item_only(self):
        # Item lanes belong to their own version and item, even when IDs match.
        cid, d = "cutbund01", self.store / "cutbund01"
        (d / "media").mkdir(parents=True)
        for v in ("v1", "v2"):
            tone(d / "media" / f"{v}__a.mp3", 440)
            tone(d / "media" / f"{v}__b.mp3", 0)
            tone(d / "media" / f"{v}__mix.mp3", 440)
        parts = lambda v: [{"id": "a", "kind": "voice", "audio": f"media/{v}__a.mp3"},   # noqa: E731
                           {"id": "b", "kind": "voice", "audio": f"media/{v}__b.mp3"}]
        ver = lambda n, v: {"n": n, "id": v, "duration": 2, "media": {"audio": f"media/{v}__mix.mp3"},  # noqa: E731
                            "parts": parts(v), "face_item": "comp1",
                            "items": [{"id": "comp1", "parts": parts(v)},
                                      {"id": "trans", "parts": [{"id": "a", "kind": "voice"}]}]}
        (d / "card.json").write_text(json.dumps({
            "id": cid, "type": "fx_music", "name": "cutbund", "attachments": [],
            "media": {"audio": "media/v2__mix.mp3"}, "versions": [ver(1, "v1"), ver(2, "v2")]}))
        (d / "signals.jsonl").write_text(json.dumps({"ts": time.time(), "kind": "archive", "voice": "a",
                                                     "value": True, "version": 1, "item": "comp1"}) + "\n")
        c = self.C.read_card(cid)
        v1, v2 = c["versions"]
        self.assertTrue(v1["parts"][0].get("archived"))                          # v1's face: out
        self.assertTrue(v1["items"][0]["parts"][0].get("archived"))              # v1's comp1 lane: out
        self.assertFalse(v1["items"][1]["parts"][0].get("archived"))             # v1's trans `a`: in
        self.assertFalse(v2["parts"][0].get("archived"))                          # v2's `a`: in
        self.assertTrue(v1["media"]["audio"].startswith(f"/api/cards/{cid}/mix?version=1&cut=a&k="))
        self.assertEqual(v2["media"]["audio"], f"/media/{cid}/v2__mix.mp3")
        self.assertLess(mean_db(self.C.mix_file(cid, 1)), -60)                   # the cut mix: only b

    def test_nothing_out_plays_the_rendered_mix(self):
        c = self.C.read_card(self.cid)
        self.assertEqual(c["versions"][0]["media"]["audio"], f"/media/{self.cid}/v1__mix.mp3")
        self.assertNotIn("audio_full", c["versions"][0]["media"])

    def test_a_band_out_points_at_the_mix_without_it(self):
        self.cut("a")
        c = self.C.read_card(self.cid)
        m = c["versions"][0]["media"]
        self.assertTrue(m["audio"].startswith(f"/api/cards/{self.cid}/mix?version=1&cut=a&k="), m["audio"])
        self.assertEqual(m["audio_full"], f"/media/{self.cid}/v1__mix.mp3")
        self.assertEqual(c["media"]["audio"], m["audio"], "the card's sound follows its newest version")
        out = self.C.mix_file(self.cid, 1)
        self.assertTrue(out.is_file())
        self.assertTrue(str(out).startswith(str(self.root / "mix")))
        # only the silent band is left: the 440 Hz band that was taken out is not in it
        self.assertLess(mean_db(out), -60)
        # made once: a second ask is the same file, not a new ffmpeg run
        mtime = out.stat().st_mtime_ns
        self.assertEqual(self.C.mix_file(self.cid, 1), out)
        self.assertEqual(out.stat().st_mtime_ns, mtime)
        # The URL key and filename must identify the same cached mix.
        self.assertTrue(m["audio"].endswith(f"&k={out.stem}"))
        self.assertEqual(self.C.cut_audio(self.cid, 1), {"url": m["audio"], "path": out})

    def test_a_kept_band_rerendered_is_a_new_url(self):
        self.cut("a")
        u1 = self.C.read_card(self.cid)["versions"][0]["media"]["audio"]
        time.sleep(0.02)
        tone(self.store / self.cid / "media" / "v1__b.mp3", 0, secs=3.0)   # b is kept; it changes
        self.C._cache.clear()
        u2 = self.C.read_card(self.cid)["versions"][0]["media"]["audio"]
        self.assertNotEqual(u1, u2)
        self.assertEqual(u1.split("&k=")[0], u2.split("&k=")[0], "same cut, new content key")

    def test_a_missing_kept_band_is_unavailable_never_short(self):
        self.cut("a")
        (self.store / self.cid / "media" / "v1__b.mp3").unlink()          # b is kept, and gone
        self.C._cache.clear()
        m = self.C.read_card(self.cid)["versions"][0]["media"]
        self.assertIsNone(m["audio"])
        self.assertEqual(m["audio_missing"], ["b"])
        with self.assertRaises(LookupError):
            self.C.mix_file(self.cid, 1)
        with self.assertRaises(LookupError):
            self.C.cut_audio(self.cid, 1)

    def test_no_cut_is_the_rendered_mix_for_cut_audio(self):
        self.assertIsNone(self.C.cut_audio(self.cid, 1))

    def test_put_back_plays_the_rendered_mix_again(self):
        self.cut("a")
        self.cut("a", False)
        c = self.C.read_card(self.cid)
        self.assertEqual(c["versions"][0]["media"]["audio"], f"/media/{self.cid}/v1__mix.mp3")

    def test_every_band_out_has_nothing_to_play(self):
        self.cut("a")
        self.cut("b")
        c = self.C.read_card(self.cid)
        self.assertIsNone(c["versions"][0]["media"]["audio"])
        with self.assertRaises(LookupError):
            self.C.mix_file(self.cid, 1)
        with self.assertRaises(LookupError):
            self.C.cut_audio(self.cid, 1)        # unavailable: never the full mix

    def test_the_route_serves_it_with_ranges(self):
        from flask import Flask
        app = Flask(__name__)
        app.register_blueprint(self.C.bp)
        self.cut("b")
        cl = app.test_client()
        r = cl.get(f"/api/cards/{self.cid}/mix?version=1&cut=b")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.mimetype, "audio/mpeg")
        self.assertGreater(len(r.data), 1000)
        r.close()
        self.assertEqual(r.headers["Cache-Control"], "no-cache", "no key: asked about every time")
        r.close()
        url = self.C.read_card(self.cid)["versions"][0]["media"]["audio"]
        r = cl.get(url)
        self.assertEqual(r.headers["Cache-Control"], "public, max-age=86400", "its own key: kept")
        r.close()
        r = cl.get(f"/api/cards/{self.cid}/mix?version=1", headers={"Range": "bytes=0-99"})
        self.assertEqual(r.status_code, 206)
        r.close()
        self.assertEqual(cl.get(f"/api/cards/{self.cid}/mix?version=9").status_code, 404)


@unittest.skipUnless(HAVE_FLASK, "needs flask")
class Stamp(unittest.TestCase):
    """Store stamps must change for new versions and signals, not just new card directories."""
    def setUp(self):
        from api import cards as C
        self.C = C
        self.root = Path(tempfile.mkdtemp())
        C.ST.use([self.root])
        (self.root / "c1").mkdir()
        (self.root / "c1" / "card.json").write_text("{}")

    def tearDown(self):
        self.C.ST.use(None)
        self.C.CAT.reset()
        shutil.rmtree(self.root, ignore_errors=True)

    def look(self):
        self.C.CAT.scan(max_age=0)                         # past the 2 s memo
        return self.C.CAT.token()

    def test_a_signal_or_a_version_moves_it(self):
        a = self.look()
        time.sleep(0.02)
        (self.root / "c1" / "signals.jsonl").write_text('{"kind": "vote"}\n')
        b = self.look()
        self.assertNotEqual(a, b, "a vote")
        time.sleep(0.02)
        (self.root / "c1" / "card.json").write_text('{"versions": [1]}')
        self.assertNotEqual(b, self.look(), "a new version")

    def test_nothing_moved_is_the_same_stamp(self):
        self.assertEqual(self.look(), self.look())


if __name__ == "__main__":
    unittest.main()


@unittest.skipUnless(HAVE_FLASK and HAVE_FFMPEG, "needs flask and ffmpeg")
class DownloadMade(unittest.TestCase):
    setUp, tearDown = CutMix.setUp, CutMix.tearDown           # the same card with audio

    def test_the_made_file_sets_its_tokens_cookie(self):
        """The page's spinner waits for this cookie: it arrives with the file, and only for a plain token."""
        from flask import Flask
        app = Flask(__name__)
        app.register_blueprint(self.C.bp)
        cl = app.test_client()
        r = cl.get(f"/api/cards/{self.cid}/download?token=k3x9")
        self.assertEqual(r.status_code, 200)
        self.assertIn("attachment", r.headers["Content-Disposition"])
        self.assertTrue(any(c.startswith("dl_k3x9=1") for c in r.headers.getlist("Set-Cookie")))
        r = cl.get(f"/api/cards/{self.cid}/download?token=../x")
        self.assertEqual(r.headers.getlist("Set-Cookie"), [])

