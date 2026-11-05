"""The mix route the open card's player asks: named lanes, streams from a second, a mix made when a band goes out,
one render per key, a bounded cache, a lane's fine peaks. Temporary stores and caches only."""

import _cfg  # noqa: F401
import base64
import json
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

PICKER = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(PICKER))

try:
    import flask
    HAVE_FLASK = True
except ImportError:
    HAVE_FLASK = False

HAVE_FFMPEG = shutil.which("ffmpeg") is not None


def tone(path: Path, freq: int, secs: float = 4.0):
    src = f"sine=frequency={freq}:duration={secs}" if freq else f"anullsrc=d={secs}"
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", src, "-ac", "1",
                    "-c:a", "libmp3lame", "-b:a", "128k", str(path)], check=True)


def ffmpegs(calls) -> int:
    return sum(1 for c in calls if c.args and c.args[0] and c.args[0][0] == "ffmpeg")


@unittest.skipUnless(HAVE_FLASK and HAVE_FFMPEG, "needs flask and ffmpeg")
class Mix(unittest.TestCase):
    def setUp(self):
        from api import cards as C
        self.C = C
        self.root = Path(tempfile.mkdtemp())
        self.store = self.root / "cards"
        self.old = (C.MIX_DIR, C.PEAKS_DIR, C.MIX_CAP)
        C.ST.use([self.store])
        C.MIX_DIR, C.PEAKS_DIR = self.root / "mix", self.root / "peaks"
        C._cache.clear()
        self.cid = "mixtest01"
        d = self.store / self.cid
        (d / "media").mkdir(parents=True)
        for name, f in (("a", 440), ("b", 660), ("c", 0), ("mix", 440), ("t_a", 220), ("t_b", 330), ("t_mix", 220)):
            tone(d / "media" / f"v1__{name}.mp3", f)
        lane = lambda i, f: {"id": i, "kind": "voice", "audio": f"media/v1__{f}.mp3"}   # noqa: E731
        (d / "card.json").write_text(json.dumps({
            "id": self.cid, "type": "fx_music", "name": "mixtest", "attachments": [],
            "media": {"audio": "media/v1__mix.mp3"},
            "versions": [{"n": 1, "id": "v1", "duration": 4, "face_item": "comp1",
                          "media": {"audio": "media/v1__mix.mp3"},
                          "parts": [lane("a", "a"), lane("b", "b"), lane("c", "c")],
                          "items": [{"id": "comp1", "media": {"audio": "media/v1__mix.mp3"},
                                     "parts": [lane("a", "a"), lane("b", "b"), lane("c", "c")]},
                                    {"id": "trans", "media": {"audio": "media/v1__t_mix.mp3"},
                                     "parts": [lane("a", "t_a"), lane("b", "t_b")]}]}]}))
        self.app = flask.Flask(__name__)
        self.app.register_blueprint(C.bp)
        self.cl = self.app.test_client()

    def tearDown(self):
        for p in list(self.C._streams):
            p.kill()
        self.C.ST.use(None)
        self.C.MIX_DIR, self.C.PEAKS_DIR, self.C.MIX_CAP = self.old
        self.C._cache.clear()
        shutil.rmtree(self.root, ignore_errors=True)

    def url(self, q):
        return f"/api/cards/{self.cid}/mix?version=1&{q}"

    def made(self, timeout=5.0, **plan):
        _, key = self.C._plan(self.cid, 1, **plan)
        end = time.time() + timeout
        while time.time() < end:
            if (self.C.MIX_DIR / f"{key}.mp3").is_file():
                return True
            time.sleep(0.05)
        return False

    def test_named_lanes_are_one_render_and_seekable(self):
        with mock.patch.object(self.C.subprocess, "run", wraps=subprocess.run) as run:
            r = self.cl.get(self.url("lanes=a,b"))
            self.assertEqual(r.status_code, 200)
            self.assertEqual(r.mimetype, "audio/mpeg")
            self.assertGreater(len(r.data), 1000)
            key = r.headers["X-Mix-Key"]
            r.close()
            r = self.cl.get(self.url("lanes=b,a"), headers={"Range": "bytes=0-99"})
            self.assertEqual(r.status_code, 206)
            self.assertEqual(r.headers["X-Mix-Key"], key, "the same set in another order is the same mix")
            r.close()
        self.assertEqual(ffmpegs(run.call_args_list), 1, "two asks, one ffmpeg")
        r = self.cl.get(self.url(f"lanes=a,b&k={key}"))
        self.assertEqual(r.headers["Cache-Control"], "public, max-age=86400")
        r.close()

    def test_unknown_or_no_lanes_are_404(self):
        self.assertEqual(self.cl.get(self.url("lanes=a,zz")).status_code, 404)
        self.assertEqual(self.cl.get(self.url("lanes=")).status_code, 404)
        self.assertEqual(self.cl.get(self.url("item=nope&lanes=a")).status_code, 404)
        self.assertEqual(self.cl.get(self.url("item=../x&lanes=a")).status_code, 400)

    def test_an_items_lanes_are_its_own(self):
        r = self.cl.get(self.url("item=trans&lanes=a"))
        self.assertEqual(r.status_code, 200)
        r.close()
        self.assertNotEqual(self.C._plan(self.cid, 1, "trans", ["a"])[1], self.C._plan(self.cid, 1, None, ["a"])[1])

    def test_head_is_202_until_made_then_200(self):
        r = self.cl.head(self.url("lanes=a,c"))
        self.assertEqual(r.status_code, 202)
        self.assertTrue(self.made(lanes=["a", "c"]), "a HEAD starts making it")
        r = self.cl.head(self.url("lanes=a,c"))
        self.assertEqual(r.status_code, 200)
        r.close()

    def test_from_streams_at_once_and_makes_the_file_behind(self):
        t0 = time.time()
        r = self.cl.get(self.url("lanes=a,b&from=1.5"), buffered=False)
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.headers["Cache-Control"], "no-store")
        first = next(iter(r.response))
        self.assertLess(time.time() - t0, 0.5, "first bytes within half a second")
        self.assertGreater(len(first), 0)
        body = first + b"".join(r.response)
        r.close()
        pcm = subprocess.run(["ffmpeg", "-v", "error", "-i", "-", "-ac", "1", "-ar", "8000", "-f", "s16le", "-"],
                             input=body, capture_output=True).stdout
        self.assertAlmostEqual(len(pcm) / 2 / 8000, 2.5, delta=0.1, msg="the piece from 1.5 s on")
        self.assertTrue(self.made(lanes=["a", "b"]), "the whole file is made behind the stream")
        r = self.cl.get(self.url("lanes=a,b&from=3"), buffered=False)        # made: cut from the file
        self.assertGreater(len(b"".join(r.response)), 1000)
        r.close()

    def test_only_the_newest_streams_run(self):
        rs = [self.cl.get(self.url(f"lanes=a,b&from={s}"), buffered=False) for s in (0.5, 1, 1.5)]
        procs = list(self.C._streams)
        self.assertEqual(len(procs), self.C.STREAMS)
        for r in rs:
            r.close()
        self.assertEqual(self.C._streams, [], "a closed stream ends its encoder")

    def test_a_band_out_is_made_before_the_next_play(self):
        r = self.cl.post(f"/api/cards/{self.cid}/signal", json={"kind": "archive", "voice": "a", "value": True,
                                                                 "version": 1, "item": "comp1"})
        self.assertEqual(r.status_code, 200)
        self.assertTrue(self.made(timeout=3.0), "the folded set is made within 3 s of the signal")

    def test_an_items_cut_mix_names_its_item(self):
        sp = self.store / self.cid / "signals.jsonl"
        sp.write_text(json.dumps({"ts": time.time(), "kind": "archive", "voice": "a", "value": True,
                                  "version": 1, "item": "trans"}) + "\n")
        v = self.C.read_card(self.cid)["versions"][0]
        trans = v["items"][1]["media"]
        self.assertTrue(trans["audio"].startswith(f"/api/cards/{self.cid}/mix?version=1&item=trans&lanes=b&k="))
        self.assertEqual(trans["audio_full"], f"/media/{self.cid}/v1__t_mix.mp3")
        self.assertEqual(v["media"]["audio"], f"/media/{self.cid}/v1__mix.mp3", "the face item is untouched")
        r = self.cl.get(trans["audio"])
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.headers["Cache-Control"], "public, max-age=86400")
        r.close()

    def test_the_cache_keeps_the_last_played(self):
        old = self.C.mix_file(self.cid, 1, lanes=["a"])
        time.sleep(0.05)
        new = self.C.mix_file(self.cid, 1, lanes=["b"])
        self.C.MIX_CAP = new.stat().st_size + 10
        self.C.mix_file(self.cid, 1, lanes=["b"])                  # played again: the newest
        self.C._prune()
        self.assertFalse(old.exists())
        self.assertTrue(new.exists())

    def test_fine_peaks_are_made_once(self):
        u = f"/api/cards/{self.cid}/peaks?version=1&lane=b&n=400"
        with mock.patch.object(self.C.subprocess, "run", wraps=subprocess.run) as run:
            r = self.cl.get(u)
            self.assertEqual(r.status_code, 200)
            body = r.get_json()
            self.assertEqual(len(base64.b64decode(body["peaks"])), 400)
            self.assertEqual(max(base64.b64decode(body["peaks"])), 255, "against the lane's own peak")
            self.assertAlmostEqual(body["secs"], 4.0, delta=0.1)
            again = self.cl.get(u)
            self.assertEqual(again.get_json(), body)
            self.assertEqual(self.cl.get(u, headers={"If-None-Match": r.headers["ETag"]}).status_code, 304)
        self.assertEqual(ffmpegs(run.call_args_list), 1)
        self.assertEqual(self.cl.get(f"/api/cards/{self.cid}/peaks?version=1&lane=zz").status_code, 404)
        r = self.cl.get(f"/api/cards/{self.cid}/peaks?version=1&item=trans&lane=a&n=16")
        self.assertEqual(len(base64.b64decode(r.get_json()["peaks"])), 16)


if __name__ == "__main__":
    unittest.main()
