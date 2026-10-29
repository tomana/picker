"""Reuse fixture media through relative links to scale card counts without encoding new media."""
import base64
import json
import os
import random
import sys
from pathlib import Path

T0 = 1790000000
WORDS = ["slow", "bright", "low", "cold", "warm", "thin", "wide", "soft", "hard", "deep", "pale", "dark", "quick",
         "still", "rough", "glass", "drone", "pulse", "ring", "wave", "tide", "grain", "hum", "spark", "dust"]


def scale(store: Path, n: int) -> dict:
    music, visual = store / "stores" / "fx_music", store / "stores" / "fx_visual"    # build.py's, by type
    rng = random.Random(7)
    music_src = json.loads((music / "fx0a1b2c3d4e" / "card.json").read_text())      # build.py's, three voices a version
    visual_src = json.loads((visual / "fxlat1" / "card.json").read_text())
    voices = [p for v in music_src["versions"] for p in v["parts"]]
    made = {"fx_music": 0, "fx_visual": 0}

    def own(peaks: str) -> str:
        """Give each voice a distinct waveform so repeated fixture data does not inflate cache hits."""
        b = base64.b64decode(peaks)
        k, g = rng.randrange(len(b)), rng.uniform(0.6, 1.0)
        return base64.b64encode(bytes(min(255, round(x * g)) for x in b[k:] + b[:k])).decode()

    def link(home: Path, src_card: Path, rel: str, name: str) -> str:
        media = home / "media"
        media.mkdir(parents=True, exist_ok=True)
        dst = media / name
        if not dst.is_symlink():
            os.symlink(os.path.relpath(src_card / rel, media), dst)
        return f"media/{name}"

    for k in range(n):
        label = f"{rng.choice(WORDS)} {rng.choice(WORDS)} {k}"
        t = T0 - rng.randint(0, 365 * 86400)
        # music: two versions of five voices
        cid = f"fs{k:010x}"
        home = music / cid
        versions = []
        for vn in (1, 2):
            parts = []
            for j in range(5):
                src = voices[(k + vn + j) % len(voices)]
                vid = f"v{vn}_{['lead', 'pad', 'click', 'bass', 'air'][j]}"
                parts.append({**src, "id": vid, "label": vid.replace("_", " "), "peaks": own(src["peaks"]),
                              "audio": link(home, music / "fx0a1b2c3d4e", src["audio"], f"v{vn}__{vid}.mp3"),
                              "src": link(home, music / "fx0a1b2c3d4e", src["src"], f"v{vn}__{vid}.scd")})
            mix = link(home, music / "fx0a1b2c3d4e", music_src["versions"][vn - 1]["media"]["audio"], f"v{vn}__mix.mp3")
            versions.append({"n": vn, "id": f"v{vn}", "created": t + vn * 600, "parts": parts, "duration": 11.0 + vn,
                             "rationale": f"{label}, take {vn}", "agent": "fixture", "model": "none",
                             "media": {"audio": mix}})
        (home / "card.json").write_text(json.dumps({
            "id": cid, "type": "fx_music", "label": label, "name": f"s{k:06d}", "created": t, "created_from": "fixture",
            "agent": "fixture", "model": "none", "narrative": {"rationale": "a made-up card at scale"},
            "lineage": {"parent": None, "refs": [], "why": None}, "versions": versions, "media": versions[-1]["media"],
            "origin": {"fixture": True, "scale": True}}))
        made["fx_music"] += 1
        # visual: one to three versions
        cid = f"fv{k:06d}"
        home = visual / cid
        versions = []
        for vn in range(1, 1 + rng.randint(1, 3)):
            src = visual_src["versions"][(vn - 1) % len(visual_src["versions"])]
            stem = cid if vn == 1 else f"{cid}_{vn}"
            media = {"still": link(home, visual / "fxlat1", src["media"]["still"], f"{stem}.png"),
                     "gif": link(home, visual / "fxlat1", src["media"]["gif"], f"{stem}.gif")}
            versions.append({"n": vn, "id": f"v{vn}", "created": t + vn * 600, "rationale": f"{label}, take {vn}",
                             "agent": "fixture", "model": "none", "media": media,
                             "parts": [{"kind": "shader", "id": stem, "label": stem, "enabled": True,
                                        "src": link(home, visual / "fxlat1", src["parts"][0]["src"], f"{stem}.frag"),
                                        "mode": stem}]})
        (home / "card.json").write_text(json.dumps({
            "id": cid, "type": "fx_visual", "label": label, "created": t, "created_from": "fixture", "agent": "fixture",
            "model": "none", "narrative": {"idea": label, "rationale": "a made-up card at scale"},
            "lineage": {"parent": None, "refs": [], "why": None}, "versions": versions, "media": versions[-1]["media"],
            "origin": {"fixture": True, "scale": True}}))
        made["fx_visual"] += 1
    return made


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    print(json.dumps(scale(Path(sys.argv[1]).resolve(), int(sys.argv[2]))))
