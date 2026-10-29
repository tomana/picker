import importlib.util
import subprocess
import tempfile
import time
from pathlib import Path

from flask import Blueprint, abort, jsonify, request

HERE = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location("_music_recording", HERE / "recording.py")
audio = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(audio)


def routes(S):
    bp = Blueprint("music_recordings", __name__)

    @bp.post("/api/music/upload")
    def upload():
        file = request.files.get("file")
        if not file or not file.filename:
            abort(400, description="choose an audio file")
        suffix = Path(file.filename).suffix.lower()
        if suffix not in audio.FORMATS:
            abort(400, description="choose a wav, mp3, m4a or flac file")
        runs = HERE / "runs"
        runs.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix=".upload-", dir=runs) as tmp:
            tmp = Path(tmp)
            source = tmp / f"upload{suffix}"
            try:
                file.save(source)
                try:
                    x = audio.decode(source, tmp / "rec.wav")
                except (ValueError, subprocess.TimeoutExpired) as e:
                    abort(400, description=str(e))
                home = tmp / "card"
                audio.write_recording(home, Path(file.filename).stem, x, time.time())
                # Publish complete files under the same lock used by projection.
                with S.sync_lock("music"):
                    n = 1
                    while (runs / f"rec{n:02d}").exists() or S.stores.card_dir(f"rec{n:02d}").exists():
                        n += 1
                    cid = f"rec{n:02d}"
                    home.rename(runs / cid)
            finally:
                # Absolute cleanup paths keep sandbox audit targets unambiguous.
                for p in sorted(tmp.rglob("*"), reverse=True):
                    p.rmdir() if p.is_dir() else p.unlink()
        S.sync("music")
        return jsonify({"ok": True, "card": cid})

    return [bp]
