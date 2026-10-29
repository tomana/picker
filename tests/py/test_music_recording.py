import _cfg  # noqa: F401
import importlib
import importlib.util
import io
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
import wave
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import numpy as np
from flask import Flask

HERE = Path(__file__).resolve().parents[2] / "examples" / "music"


class MusicRecordingTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.enterContext(patch.dict(sys.modules))
        self.enterContext(patch.object(sys, "path", [str(HERE), *sys.path]))
        for name in ("recording", "synth", "seed", "sync", "fake_agent", "queue_runner"):
            sys.modules.pop(name, None)
        self.audio = importlib.import_module("recording")
        self.synth = importlib.import_module("synth")
        self.seed = importlib.import_module("seed")
        self.runner = importlib.import_module("queue_runner")
        self.sync = importlib.import_module("sync")
        self.runs = self.root / "runs"
        self.runs.mkdir()
        self.enterContext(patch.object(self.runner, "HERE", self.root))
        self.enterContext(patch.object(self.runner, "RUNS", self.runs))
        self.files = self.root / "recordings"
        self.files.mkdir()

    def recording(self):
        x = np.linspace(-0.4, 0.4, 4 * self.audio.RATE, dtype=np.float32)
        self.audio.write_recording(self.runs / "rec01", "a take", x, 100)
        return x

    def test_fake_agent_is_available_without_an_external_cli(self):
        from core import agents
        self.assertEqual(agents.binary("fake"), sys.executable)

    def test_seed_fallback_links_loops_to_recordings_and_scores_only_notes(self):
        ids = self.seed.seed(self.runs, n=1, recordings=self.files)
        self.assertEqual(len(ids), 7)
        for cid in ("rec01", "rec02", "rec03"):
            home = self.runs / f"{cid}loop"
            meta = json.loads((home / "meta.json").read_text())
            v = json.loads((home / "v1" / "version.json").read_text())
            loop = json.loads((home / "v1" / "loop.json").read_text())
            self.assertEqual(meta["parent"], cid)
            self.assertGreater(meta["span"]["dur"], 0)
            self.assertEqual(v["score"]["value"], self.synth.clash(loop))
            self.assertEqual(len(v["parts"]), len(loop["voices"]) + 1)
            self.assertEqual(v["parts"][-1]["id"], "rec")
            self.assertEqual(len(self.audio.read(home / "v1" / "rec.wav")),
                             len(self.audio.read(home / "v1" / "mix.wav")))
        store = self.root / "cards"
        self.sync.project(self.runs, store)
        c = json.loads((store / "rec01loop" / "card.json").read_text())
        self.assertEqual(c["origin"]["span"], json.loads((self.runs / "rec01loop" / "meta.json").read_text())["span"])
        self.assertEqual(c["lineage"]["parent"], "rec01")
        signals = store / "rec01loop" / "signals.jsonl"
        signals.write_text('{"kind":"vote","value":1}\n')
        self.assertEqual(self.sync.project(self.runs, store), 0)
        self.assertEqual(signals.read_text(), '{"kind":"vote","value":1}\n')

    @unittest.skipUnless(shutil.which("ffmpeg"), "ffmpeg is required for imports")
    def test_seed_uses_sorted_own_files_first_and_decodes_stereo(self):
        for name in ("B take.WAV", "A take.wav"):
            with wave.open(str(self.files / name), "wb") as w:
                w.setnchannels(2)
                w.setsampwidth(2)
                w.setframerate(48000)
                w.writeframes(np.tile([1000, 3000], 4800).astype("<i2").tobytes())
        ids = self.seed.record(self.runs, 1000, self.files)
        self.assertEqual(ids, ["rec01", "rec02", "rec03"])          # the files first; a made-up one fills up to three
        labels = [json.loads((self.runs / c / "meta.json").read_text())["label"] for c in ids]
        self.assertEqual(labels, ["A take", "B take", "rain on a window"])
        x = self.audio.read(self.runs / "rec01" / "v1" / "rec.wav")
        self.assertEqual(len(x), 2205)
        self.assertAlmostEqual(float(x.mean()), 2000 / 32768, places=3)

    @unittest.skipUnless(shutil.which("ffmpeg"), "ffmpeg is required for imports")
    def test_a_recording_brings_its_own_loop_and_stretch(self):
        with wave.open(str(self.files / "take.wav"), "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(48000)
            w.writeframes((np.sin(np.arange(48000 * 4) / 20) * 3000).astype("<i2").tobytes())
        loop = {"name": "its own", "why": "notes heard in it", "tempo": 96, "span": {"start": 0.5, "end": 2.5},
                "voices": [{"name": "bass", "wave": "saw", "notes": [40, None] * 8, "decay": 0.3, "level": 0.8},
                           {"name": "lead", "wave": "square", "notes": [None, 64] * 8, "decay": 0.2, "level": 0.5}]}
        (self.files / "take.loop.json").write_text(json.dumps(loop))
        self.seed.seed(self.runs, recordings=self.files)
        got = json.loads((self.runs / "rec01loop" / "v1" / "loop.json").read_text())
        self.assertEqual(got, {k: v for k, v in loop.items() if k != "span"})
        self.assertEqual(json.loads((self.runs / "rec01loop" / "meta.json").read_text())["span"], {"start": 0.5, "dur": 2.0})
        self.assertNotEqual(json.loads((self.runs / "rec02loop" / "v1" / "loop.json").read_text())["name"], "its own")

    @unittest.skipUnless(shutil.which("ffmpeg"), "ffmpeg is required for imports")
    def test_compressed_formats_decode_to_the_lane_format(self):
        self.recording()
        source = self.runs / "rec01" / "v1" / "rec.wav"
        for suffix in (".mp3", ".m4a", ".flac"):
            with self.subTest(suffix=suffix):
                encoded = self.files / f"take{suffix}"
                subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-i", str(source), "-t", "0.2", str(encoded)],
                               check=True, capture_output=True)
                target = self.root / "decoded.wav"
                x = self.audio.decode(encoded, target)
                self.assertGreater(len(x), 0)
                self.assertTrue(np.array_equal(x, self.audio.read(target)))

    def test_trim_is_cut_or_repeated_without_changing_score(self):
        self.recording()
        src = self.runs / "rec01" / "v1" / "rec.wav"
        span = {"start": 1.0, "dur": 0.5}
        x = self.audio.read(src)[22050:33075]
        self.assertTrue(np.array_equal(self.audio.stretch(src, span, 1000), x[:1000]))
        self.assertTrue(np.array_equal(self.audio.stretch(src, span, 30000), np.resize(x, 30000)))
        self.assertEqual(self.audio.select_span(4, {"start": 1, "end": 20}), {"start": 1, "dur": 3})
        self.assertEqual(self.audio.select_span(10)["dur"], 8 * 60 / 110)
        for trim in ({"start": 5, "end": 6}, {"start": 2, "end": 1}, {"start": 0, "end": float("nan")}):
            with self.assertRaises(ValueError):
                self.audio.select_span(4, trim)

    def test_runner_keeps_the_trim_and_revisions_keep_the_recording(self):
        self.recording()
        job = {"id": "abcdef123456", "card": "rec01", "kind": "inspire", "trim": {"start": 1, "end": 2},  # pragma: allowlist secret
               "text": "minor", "model": "m-picked", "context": {"versions": [], "base": None}}
        brief = self.runner.brief(job, "fake")
        self.assertIn("Recording: runs/rec01/v1/rec.wav", brief)
        self.assertIn("Use seconds 1.000 to 2.000", brief)
        self.assertNotEqual(self.runner._plan({**job, "kind": "revise"})[0], "rec01")

        def agent(*args, **kwargs):
            target = self.runner._plan(job)[2]
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(json.dumps(importlib.import_module("fake_agent").make("minor", None, "test")))
            from core.agents import AgentResult
            return AgentResult(args[0], kwargs.get("model"), "low", 0)

        with patch.object(self.runner.sdk, "run_job", side_effect=agent):
            made = self.runner.work(job, lambda _: None)
        cid = made[0]["card"]
        # the job's model goes to the agent, and the version records what ran
        version = json.loads((self.runs / cid / made[0]["version"] / "version.json").read_text())
        self.assertEqual((version["model"], version["effort"]), ("m-picked", "low"))
        meta = json.loads((self.runs / cid / "meta.json").read_text())
        self.assertEqual(meta["parent"], "rec01")
        self.assertEqual(meta["span"], {"start": 1, "dur": 1})
        self.assertEqual(self.runner.recording_source({"card": cid})[1], meta["span"])
        self.assertIn("Recording:", self.runner.brief({**job, "card": cid, "kind": "revise", "trim": None}, "fake"))

    @unittest.skipUnless(shutil.which("ffmpeg"), "ffmpeg is required for uploads")
    def test_uploads_publish_complete_cards_and_invalid_audio_leaves_nothing(self):
        spec = importlib.util.spec_from_file_location("music_upload_test", HERE / "picker_plugin.py")
        plugin = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(plugin)
        plugin.HERE = self.root
        store = self.root / "cards"
        import threading
        lock = threading.Lock()
        S = SimpleNamespace(sync_lock=lambda _: lock, stores=SimpleNamespace(card_dir=lambda cid: store / cid),
                            sync=lambda _: self.sync.project(self.runs, store))
        app = Flask(__name__)
        app.register_blueprint(plugin.routes(S)[0])
        x = self.recording()
        data = (self.runs / "rec01" / "v1" / "rec.wav").read_bytes()

        def upload():
            with app.test_client() as c:
                return c.post("/api/music/upload", data={"file": (io.BytesIO(data), "own take.wav")})

        # Serialize sync as the real service does, without recursively holding its lock.
        def sync(_):
            with lock:
                self.sync.project(self.runs, store)
        S.sync = sync
        with ThreadPoolExecutor(max_workers=2) as pool:
            responses = list(pool.map(lambda _: upload(), range(2)))
        self.assertTrue(all(r.status_code == 200 for r in responses))
        self.assertEqual({r.json["card"] for r in responses}, {"rec02", "rec03"})
        for cid in ("rec02", "rec03"):
            c = json.loads((store / cid / "card.json").read_text())
            self.assertEqual(c["origin"]["kind"], "recording")
            self.assertEqual(c["label"], "own take")
            self.assertEqual(len(self.audio.read(self.runs / cid / "v1" / "rec.wav")), len(x))
        before = sorted(p.name for p in self.runs.iterdir())
        with app.test_client() as c:
            self.assertEqual(c.post("/api/music/upload").status_code, 400)
            self.assertEqual(c.post("/api/music/upload", data={"file": (io.BytesIO(b"bad"), "bad.wav")}).status_code, 400)
            self.assertEqual(c.post("/api/music/upload", data={"file": (io.BytesIO(data), "bad.txt")}).status_code, 400)
        self.assertEqual(sorted(p.name for p in self.runs.iterdir()), before)
