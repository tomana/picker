#!/usr/bin/env python3
"""Deterministic fixture media; use MP3 because browser decoding can silently drop native AAC output."""
import base64
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

sys.path.insert(0, str(Path(__file__).resolve().parent))
import staircase  # noqa: E402

T0 = 1790000000                      # All fixture timestamps share one epoch.
RATE = 22050

# Black and white, as the example's cards mostly are: a dark and a light.
SITE = [((0, 0, 0), (255, 255, 255)), ((8, 8, 8), (200, 200, 200)), ((20, 20, 20), (240, 240, 240)),
        ((0, 0, 0), (245, 242, 234)), ((5, 5, 5), (150, 150, 150)), ((30, 30, 30), (255, 255, 255)),
        ((0, 0, 0), (220, 220, 220)), ((12, 12, 12), (235, 235, 235)), ((0, 0, 0), (190, 190, 190))]
VISUAL = [   # id, label, versions, the colours it is drawn in
    ("fxlat1", "lattice of slow rings", 3, SITE[0]),
    ("fxdun1", "dune ripple field", 2, SITE[6]),
    ("fxemb1", "ember drift", 1, SITE[3]),
    ("fxgrd1", "grid that breathes", 2, SITE[1]),
    ("fxmoi1", "moire of two fans", 1, SITE[4]),
    ("fxold1", "an older sketch", 1, SITE[7]),          # archived
    # Keep enough cards to exercise grid overflow.
    ("fxtid1", "tide lines", 1, SITE[0]),
    ("fxsnd1", "sand script", 1, SITE[5]),
    ("fxfrn1", "fern spiral", 2, SITE[1]),
    ("fxhaz1", "haze bands", 1, SITE[7]),
    ("fxkil1", "kiln glow", 1, SITE[5]),
    ("fxpol1", "pollen drift", 1, SITE[2]),
]
# Keep a card fully visible below the header after scrolling.
_WORDS = ["salt", "cloud", "wave", "ember", "frost", "moss", "dusk", "glass", "smoke", "rain", "silk", "ash",
          "copper", "ink", "fog", "slate"]
VISUAL += [(f"fxv{k + 1:02d}", f"{w} study", 1, SITE[k % len(SITE)]) for k, w in enumerate(_WORDS)]
MUSIC = [    # id, name, label, versions, the voices' base pitches (Hz), seconds (v1; each later version 1 s more)
    # long enough to scrub and hand over (the playlist's checks want 10 s or more, the playhead's 15 s)
    ("fx0a1b2c3d4e", "glassbl", "glass bell drone", 3, (220.0, 330.0, 440.0), 11.0),
    ("fx1b2c3d4e5f", "pulsewv", "pulse under waves", 2, (110.0, 165.0), 11.0),
    ("fx2c3d4e5f60", "reedhum", "reed hum and click", 2, (196.0, 294.0, 392.0), 11.0),
    ("fx3d4e5f6071", "subtide", "sub tide", 1, (55.0, 82.5), 7.0),
    ("fx4e5f607182", "chimefl", "chime flutter", 1, (523.0, 659.0, 784.0), 17.0),
    ("fx5f60718293", "oldloop", "an older loop", 1, (147.0, 220.0), 7.0),                # archived
    # Keep the music list longer than its panel.
    ("fx6a7b8c9d0e", "lowhorn", "low horn and hiss", 1, (73.4, 146.8), 8.0),
    ("fx7b8c9d0e1f", "brightp", "bright pluck", 1, (659.0, 988.0), 8.0),
    ("fx8c9d0e1f20", "wovenst", "woven strings", 1, (196.0, 247.0), 8.0),
    ("fx9d0e1f2031", "nightfz", "night fizz", 1, (880.0, 1320.0), 8.0),
]
# Leave enough rows that archiving cannot clamp the scroll position.
MUSIC += [(f"fxe{k + 1:02d}0000000", f"extra{k + 1:02d}", f"{w} hum", 1, (110.0 * (1 + k % 4), 165.0 * (1 + k % 3)), 4.0)
          for k, w in enumerate(["reed", "wire", "glass", "bowl", "drum", "breath", "string", "bell"])]
ARCHIVED = {"fxold1", "fx5f60718293"}

# Exercise sparse versions, bundles, alternate renders and stable lane IDs.
BUNDLE = ("fx7a8b9c0d1e", "bundtak", "a bundled take")   # a bundle: two items, each its own voices, `kick` in both
SPARSE = ("fxspr1", "a stack missing its first take")      # versions v2 and v5 only
VIEWS = ("fxvws1", "one ring, two renders")                 # a version with two renders (`views`)
SHOW = ("fxshw1", "a timeline with no parts")              # fx_show has video and timeline media but no parts.
LINKED = ("fxlnk1", "a card linked from its research")     # its media are relative links (with --runners only)
HIDDEN = "fx0a1b2c3d4e"            # its v3 is held (AUTO, keep in list until voted) and never voted up
CUT_ITEM = (BUNDLE[0], 1, "comp1", "kick")                  # a cut on one item's voice: the other item's kick stays
CUT_VOICE = ("fx2c3d4e5f60", "v2_click")                    # a cut on a voice across the card
SAME = ("fxsame000001", "samelan", "one lane, four takes")  # Stable lane IDs across four unvoted versions.
# Fixture-only types use fake loops and local manifests.
OWN = Path(__file__).resolve().parent / "types"
FITS = [   # fits_hybrid: id, label, the drum, each try's loss (the loop's versions), the last try's doubts
    ("fxfit01", "kick, tight", "kick", [0.42, 0.27, 0.19], []),
    ("fxfit02", "kick, boomy", "kick", [0.55, 0.48], ["its two judges disagree: the spectrum says close, the envelope far"]),
    ("fxfit03", "snare, dry", "snare", [0.38, 0.33, 0.35], []),
    ("fxfit04", "snare, ringing", "snare", [0.61], []),
    ("fxfit05", "hat, closed", "hat", [0.22, 0.14], []),
    ("fxfit06", "hat, open", "hat", [0.47, 0.44, 0.45], ["stuck: three tries within 0.03 of each other"]),
    ("fxfit07", "kick, sub", "kick", [0.31], []),
]
DRUM = {   # a target's knobs; a try is the same drum with its knobs off by about its loss
    "kick": {"pitch": 52.0, "drop": 3.0, "decay": 0.18},
    "snare": {"pitch": 185.0, "drop": 0.4, "decay": 0.12},
    "hat": {"pitch": 7000.0, "drop": 0.0, "decay": 0.05},
}
HIT, GAP = 0.6, 0.35               # a hit's seconds, and the silence between A and B
CODE = [   # code_scored, a loop that makes a program start faster: id, the change, its median of five starts (ms), kept
    ("fxcode01", "cache the shader compile", 412, True, ["- prog = compile(src)", "+ prog = cache.get(src) or compile(src)"]),
    ("fxcode02", "parallel asset scan", 431, False, ["- found = [scan(d) for d in dirs]", "+ found = pool.map(scan, dirs)"]),
    ("fxcode03", "lazy-load the font atlas", 389, True, ["- atlas = load_atlas()", "+ atlas = lazy(load_atlas)"]),
    ("fxcode04", "skip the warm-up frame", 386, False, ["- draw_frame(blank)", "+ # the first frame drawn on demand"]),
    ("fxcode05", "precompute the colour LUT", 371, True, ["- lut = build_lut(256)", "+ lut = np.load('lut.npy')"]),
    ("fxcode06", "smaller first texture", 402, False, ["- tex = load('bg_4k.png')", "+ tex = load('bg_1k.png')"]),
    ("fxcode07", "inline the config parse", 366, True, ["- cfg = toml.load(path)", "+ cfg = CONFIG  # parsed at build"]),
    ("fxcode08", "mmap the mode table", 380, False, ["- table = read(path)", "+ table = mmap(path)"]),
]
OWN_SEED = {"fx_fit": "fxfit01", "fx_code": "fxcode01",   # the card a fake seed or inspire copies, per own type
            "fx_visual": VISUAL[2][0], "fx_music": MUSIC[3][0], "fx_show": SHOW[0]}
# Example tab labels are independent of production type labels.
LABELS: dict = {}
# Hidden fixture types still participate in dry runs.
UNSHOWN: set = set()
# Copy runnable visual and music examples with their real runners and syncs.
EXAMPLES = sorted((Path(__file__).resolve().parents[2] / "examples").glob("*/picker-type.json"))
STOOD_FOR = {"fx_visual", "fx_music", "fx_show"}        # the checks' shapes, not shown in the example picker
# Preserve the configured default tab order until the user saves a reorder.
FIRST = ["visual", "fx_fit", "music", "fx_code", "fx_show"]
# Suite fixtures may remap types and add their own cards.
KINDS = {"visual": "fx_visual", "music": "fx_music", "show": "fx_show"}
SUITE = None                       # the suite's fixture.py, when there is one


def _w(p: Path, text: str) -> None:
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(text)


def _jsonl(p: Path, rows: list) -> None:
    _w(p, "".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows))



def _frame(w: int, h: int, a, b, phase: float, seed: int) -> Image.Image:
    rng = np.random.default_rng(seed)
    x = np.linspace(0, 1, w)[None, :]
    y = np.linspace(0, 1, h)[:, None]
    k = 4 + seed % 5
    t = 0.5 + 0.5 * np.sin(2 * np.pi * (k * x + 0.6 * k * y + phase))
    t = np.clip(t + 0.03 * rng.standard_normal((h, w)), 0, 1)
    rgb = (np.asarray(a)[None, None, :] * (1 - t[..., None]) + np.asarray(b)[None, None, :] * t[..., None])
    im = Image.fromarray(rgb.astype(np.uint8), "RGB")
    d = ImageDraw.Draw(im)
    cx, cy = w * (0.3 + 0.4 * ((seed * 37) % 10) / 10), h / 2
    r = h * (0.18 + 0.08 * np.sin(2 * np.pi * phase))
    d.ellipse([cx - r, cy - r, cx + r, cy + r], outline=tuple(b), width=3)
    return im


def _pictures(media: Path, stem: str, a, b, seed: int) -> dict:
    media.mkdir(parents=True, exist_ok=True)
    frames = [_frame(240, 135, a, b, i / 8, seed) for i in range(8)]
    frames[0].save(media / f"{stem}.png")
    frames[0].save(media / f"{stem}.gif", save_all=True, append_images=frames[1:], duration=120, loop=0)
    return {"still": f"media/{stem}.png", "gif": f"media/{stem}.gif"}



def _voice(f0: float, secs: float, seed: int) -> np.ndarray:
    rng = np.random.default_rng(seed)
    t = np.arange(int(secs * RATE)) / RATE
    env = np.minimum(1, t / 0.4) * np.minimum(1, (secs - t) / 0.8)
    wob = 1 + 0.004 * np.sin(2 * np.pi * (0.3 + seed % 3 * 0.2) * t)
    s = np.sin(2 * np.pi * f0 * wob * t) + 0.3 * np.sin(2 * np.pi * 2 * f0 * t + seed)
    if seed % 2:                                             # every other voice pulses
        s *= 0.55 + 0.45 * np.sign(np.sin(2 * np.pi * (1.5 + seed % 4) * t))
    s += 0.02 * rng.standard_normal(len(t))
    return (0.35 * env * s).astype(np.float32)


def _mp3(p: Path, x: np.ndarray) -> None:
    p.parent.mkdir(parents=True, exist_ok=True)
    pcm = (np.clip(x, -1, 1) * 32767).astype("<i2").tobytes()
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "s16le", "-ar", str(RATE), "-ac", "1", "-i", "-",
                    "-c:a", "libmp3lame", "-b:a", "48k", "-fflags", "+bitexact", "-map_metadata", "-1", str(p)],
                   input=pcm, check=True)


def _drum(kind: str, p: dict, seed: int) -> np.ndarray:
    """One made-up drum hit: a falling sine (kick, snare's body), noise (snare's rattle, the hat)."""
    t = np.arange(int(HIT * RATE)) / RATE
    rng = np.random.default_rng(seed)
    env = np.exp(-t / p["decay"])
    if kind == "hat":
        x = np.diff(rng.standard_normal(len(t)), prepend=0.0) * env
    else:
        f = p["pitch"] * (1 + p["drop"] * np.exp(-t / 0.03))
        x = np.sin(2 * np.pi * np.cumsum(f) / RATE) * env
        if kind == "snare":
            x = 0.6 * x + 0.5 * rng.standard_normal(len(t)) * np.exp(-t / (0.8 * p["decay"]))
    return (0.85 * x / max(1e-9, float(np.abs(x).max()))).astype(np.float32)


def _spectrogram(x: np.ndarray, path: Path, w: int = 360, h: int = 160) -> None:
    """Keep the spectrogram on the clip time axis, with low notes at the bottom."""
    n, hop = 512, max(1, len(x) // w)
    pad = np.concatenate([x, np.zeros(n, np.float32)])
    mag = np.abs(np.fft.rfft(np.stack([pad[i * hop:i * hop + n] * np.hanning(n) for i in range(w)]), axis=1))[:, 1:]
    freqs = np.fft.rfftfreq(n, 1 / RATE)[1:]
    rows = np.clip(np.searchsorted(freqs, np.geomspace(40, 10000, h)), 0, len(freqs) - 1)
    db = 20 * np.log10(mag[:, rows] + 1e-6)
    v = np.clip((db - (db.max() - 70)) / 70, 0, 1).T[::-1]
    stops = np.array([[0, 0, 0], [40, 30, 110], [230, 120, 40], [255, 240, 200]], float)
    pos = v * 3
    i = np.minimum(pos.astype(int), 2)
    f = (pos - i)[..., None]
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray((stops[i] * (1 - f) + stops[i + 1] * f).astype(np.uint8), "RGB").save(path)


def _fits(cards: Path, made: dict) -> None:
    """Each fit attempt retains its score, judges, settings and doubts alongside the target clip."""
    made["fx_fit"] = []
    for i, (cid, label, drum, losses, doubts) in enumerate(FITS):
        home = cards / cid
        target = _drum(drum, DRUM[drum], seed=500 + i)
        _mp3(home / "media" / "reference.mp3", target)
        versions = []
        for n, loss in enumerate(losses, 1):
            rng = np.random.default_rng(600 + i * 10 + n)
            knobs = {k: v * (1 + loss * float(rng.uniform(-0.8, 0.8))) for k, v in DRUM[drum].items()}
            fit = _drum(drum, knobs, seed=700 + i * 10 + n)
            ab = np.concatenate([fit, np.zeros(int(GAP * RATE), np.float32), target])
            _mp3(home / "media" / f"v{n}.mp3", fit)
            _mp3(home / "media" / f"v{n}_ab.mp3", ab)
            _spectrogram(ab, home / "media" / f"v{n}_still.png")
            versions.append({
                "n": n, "id": f"v{n}", "created": T0 + 120000 + i * 3600 + n * 600,
                "rationale": f"{label}: the fit loop's try {n}", "agent": "fixture", "model": "none",
                "duration": HIT, "ab_at": HIT + GAP, "ab_dur": 2 * HIT + GAP,
                "score": {"name": "loss", "value": loss, "lower_is_better": True, "group": drum},
                "measures": {"spectrum": round(loss * 0.8, 3), "envelope": round(loss * 1.3, 3)},
                "doubts": doubts if n == len(losses) else [],
                "params": {k: round(v, 3) for k, v in knobs.items()},
                "media": {"still": f"media/v{n}_still.png", "audio": f"media/v{n}.mp3",
                          "reference": "media/reference.mp3", "ab": f"media/v{n}_ab.mp3"},
                "parts": []})
        card = {"id": cid, "type": "fx_fit", "label": label, "created": T0 + 120000 + i * 3600,
                "created_from": "fixture", "agent": "fixture", "model": "none",
                "narrative": {"rationale": "a made-up fit for the checks"},
                "lineage": {"parent": None, "refs": [], "why": None},
                "versions": versions, "media": versions[-1]["media"], "origin": {"fixture": True}}
        _w(home / "card.json", json.dumps(card, indent=1))
        made["fx_fit"].append(cid)


def _code(cards: Path, made: dict) -> None:
    """Code attempts in their order, each with its timings, kept status and its staircase as its still."""
    made["fx_code"] = []
    tries = [{"value": ms, "kept": kept, "label": label} for _, label, ms, kept, _ in CODE]
    best = 450
    for i, (cid, label, ms, kept, diff) in enumerate(CODE):
        starts = [ms + d for d in (-4, 0, 3, -1, 5)]
        v = {"n": 1, "id": "v1", "created": T0 + 130000 + i * 600, "agent": "fixture", "model": "none",
             "rationale": label + "\n" + "\n".join(diff),
             "score": {"name": "startup", "value": ms, "lower_is_better": True, "unit": "ms"}, "kept": kept,
             "measures": {"starts": " ".join(map(str, starts)), "best before": best},
             "media": {"still": "media/v1_stair.png"}, "parts": []}
        (cards / cid / "media").mkdir(parents=True, exist_ok=True)
        staircase.draw(cards / cid / "media" / "v1_stair.png", tries, i)
        if kept:
            best = ms
        card = {"id": cid, "type": "fx_code", "label": label, "created": v["created"], "created_from": "fixture",
                "agent": "fixture", "model": "none", "narrative": {"rationale": "a made-up try for the checks"},
                "lineage": {"parent": None, "refs": [], "why": None},
                "versions": [v], "media": v["media"], "origin": {"fixture": True}}
        _w(cards / cid / "card.json", json.dumps(card, indent=1))
        made["fx_code"].append(cid)


def _peaks(x: np.ndarray, n: int = 200) -> str:
    """picker/peaks.py's encoding: n buckets, each the peak |sample| scaled to 0..255, base64."""
    step = max(1, len(x) // n)
    pk = np.array([np.abs(x[k * step:(k + 1) * step]).max(initial=0) for k in range(n)])
    pk = pk / (pk.max() or 1)
    return base64.b64encode((pk * 255).astype(np.uint8).tobytes()).decode()



def _music_item(home: Path, iid: str, kind: str, how: str, pitches, secs: float, seed: int) -> dict:
    parts, mix = [], np.zeros(int(secs * RATE), np.float32)
    for j, f0 in enumerate(pitches):
        vid = ["kick", "pad", "bell"][j]
        x = _voice(f0, secs, seed=seed + j)
        _mp3(home / "media" / f"v1__{iid}__{vid}.mp3", x)
        _w(home / "media" / f"v1__{iid}__{vid}.scd", f"// fixture voice {iid}/{vid}: a sine at {f0:g} Hz\n")
        parts.append({"kind": "voice", "id": vid, "label": vid, "enabled": True, "group": seed % 7,
                      "src": f"media/v1__{iid}__{vid}.scd", "audio": f"media/v1__{iid}__{vid}.mp3", "peaks": _peaks(x)})
        mix += x
    mix = mix / max(1.0, float(np.abs(mix).max()) / 0.9)
    _mp3(home / "media" / f"v1__{iid}__mix.mp3", mix)
    return {"id": iid, "name": iid, "label": f"the {kind} take", "parts": parts, "duration": secs, "kind": kind,
            "how": how, "span": {"start": 0.0, "dur": secs}, "from": "fixture", "why": "made up",
            "plays_on": "piece", "media": {"audio": f"media/v1__{iid}__mix.mp3"}, "peaks": _peaks(mix)}


def _visual_card(cid: str, label: str, ns, a, b, seed: int, media_dir: Path, t: float) -> dict:
    versions = []
    for n in ns:
        stem = cid if n == 1 else f"{cid[:-1]}{n}"
        media = _pictures(media_dir, stem, a, b, seed=seed + n)
        _w(media_dir / f"{stem}.frag", f"// fixture shader {stem}: made up, never compiled\n")
        versions.append({"n": n, "id": f"v{n}", "created": t + n * 600, "rationale": f"{label}, take {n}",
                         "agent": "fixture", "model": "none", "media": media,
                         "parts": [{"kind": "shader", "id": stem, "label": stem, "enabled": True,
                                    "src": f"media/{stem}.frag", "mode": stem}]})
    return {"id": cid, "type": KINDS["visual"], "label": label, "created": t, "created_from": "fixture",
            "agent": "fixture", "model": "none", "narrative": {"idea": label, "rationale": "a made-up card for the checks"},
            "lineage": {"parent": None, "refs": [], "why": None}, "versions": versions,
            "media": versions[-1]["media"], "origin": {"fixture": True}}


def _hard_shapes(cards: Path, made: dict) -> None:
    # Bundles expose face-item parts while each item retains its own voices.
    cid, name, label = BUNDLE
    home = cards / cid
    items = [_music_item(home, "trans", "whole", "transcribe: made up", (110.0, 220.0), 16.0, 500),
             _music_item(home, "comp1", "comp", "compose", (330.0, 440.0, 550.0), 16.0, 510)]
    # The newest music card must be long enough for drag checks.
    v = {"n": 1, "id": "v1", "created": T0 + 190000, "parts": items[1]["parts"], "items": items, "face_item": "comp1",
         "duration": 16.0, "rationale": f"{label}, take 1", "agent": "fixture", "model": "none", "tags": ["bundle"],
         "media": {"audio": items[1]["media"]["audio"]}}
    _w(home / "card.json", json.dumps({
        "id": cid, "type": KINDS["music"], "label": label, "name": name, "created": T0 + 190000, "created_from": "fixture",
        "agent": "fixture", "model": "none", "narrative": {"rationale": "a made-up card for the checks"},
        "lineage": {"parent": None, "refs": [], "why": None}, "versions": [v], "media": v["media"],
        "origin": {"fixture": True}}, indent=1))
    made[KINDS["music"]].append(cid)

    # The face signal selects one of multiple renders of a version.
    cid, label = VIEWS
    card = _visual_card(cid, label, (1,), (40, 40, 100), (200, 180, 255), 60, cards / cid / "media", T0 + 20000)
    v = card["versions"][0]
    views = []
    for k, slug in enumerate(("wholebody", "newshort")):
        m = _pictures(cards / cid / "media", f"{cid}.{slug}", (40 + 80 * k, 40, 100), (200, 180 + 60 * k, 255), 61 + k)
        views.append({"slug": slug, "still": m["still"], "gif": m["gif"], **({"face": True} if k else {})})
    v["media"] = {"still": views[1]["still"], "gif": views[1]["gif"], "views": views}
    card["media"] = v["media"]
    _w(cards / cid / "card.json", json.dumps(card, indent=1))
    made[KINDS["visual"]].append(cid)

    # Selected versions and votes stay version-specific despite stable lane IDs.
    # Provenance covers missing and oversized settings.
    prov = {1: {"method": "transcribe", "settings": ["demucs", "snap"], "agent": "claude", "model": "claude-opus-5-5",
                "effort": "high"},
            2: {"method": "free", "settings": ["free"], "agent": "codex", "model": "gpt-6.1-sol",
                "notes": ["v16-parent", "a long note the agent wrote about the bassline, which is never a chip"]},
            3: {"agent": "fixture", "model": "none"},
            4: {"method": "explore", "settings": ["mode: demucs-bp", "bass: Basic Pitch", "snap", "plain voices",
                                                  "route 1 of 18", "route 2 of 18", "+vocals", "long tail"],
                "agent": "claude", "model": "claude-opus-5-5"}}
    cid, name, label = SAME
    home = cards / cid
    versions = []
    for n, secs in ((1, 8.0), (2, 10.0), (3, 12.0), (4, 9.0)):
        parts, mix = [], np.zeros(int(secs * RATE), np.float32)
        for k, (vid, f0) in enumerate((("drone", 110.0), ("pad", 220.0))):
            x = _voice(f0 * (1 + 0.05 * n), secs, seed=600 + n * 10 + k)
            _mp3(home / "media" / f"v{n}__{vid}.mp3", x)
            _w(home / "media" / f"v{n}__{vid}.scd", f"// fixture voice {vid}, take {n}\n")
            parts.append({"kind": "voice", "id": vid, "label": vid, "enabled": True, "group": 0,
                          "src": f"media/v{n}__{vid}.scd", "audio": f"media/v{n}__{vid}.mp3", "peaks": _peaks(x)})
            mix += x
        _mp3(home / "media" / f"v{n}__mix.mp3", mix / max(1.0, float(np.abs(mix).max()) / 0.9))
        versions.append({"n": n, "id": f"v{n}", "created": T0 + 150000 + n * 600, "parts": parts, "duration": secs,
                         "rationale": f"{label}, take {n}", **prov[n],
                         "media": {"audio": f"media/v{n}__mix.mp3"}})
    _w(home / "card.json", json.dumps({
        "id": cid, "type": KINDS["music"], "label": label, "name": name, "created": T0 + 150000, "created_from": "fixture",
        "agent": "fixture", "model": "none", "narrative": {"rationale": "a made-up card for the checks"},
        "lineage": {"parent": None, "refs": [], "why": None}, "versions": versions, "media": versions[-1]["media"],
        "origin": {"fixture": True}}, indent=1))
    made[KINDS["music"]].append(cid)

    # sparse version ids: v2 and v5, no v1, v3 or v4
    cid, label = SPARSE
    _w(cards / cid / "card.json", json.dumps(_visual_card(cid, label, (2, 5), (90, 20, 90), (250, 190, 240), 70,
                                                          cards / cid / "media", T0 + 30000), indent=1))
    made[KINDS["visual"]].append(cid)

    # Timeline cards may have no audio parts.
    cid, label = SHOW
    media = cards / cid / "media"
    media.mkdir(parents=True, exist_ok=True)
    frames = [_frame(320, 180, (10, 30, 60), (240, 200, 120), i / 12, 80) for i in range(12)]
    for i, f in enumerate(frames):
        f.save(media / f"_f{i:02d}.png")
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-framerate", "6", "-i", str(media / "_f%02d.png"),
                    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-threads", "1", "-fflags", "+bitexact",
                    "-flags:v", "+bitexact", "-map_metadata", "-1", str(media / "v1__video.mp4")], check=True)
    for f in media.glob("_f*.png"):
        f.unlink()
    frames[6].resize((320, 40)).save(media / "v1__poster.png")            # the take's timeline picture
    frames[3].save(media / "v1__still.webp")
    sections = [{"len": 2.0, "name": "a made-up opening", "start": 0.0}]
    _w(media / "v1__show.json", json.dumps({"sections": sections, "lanes": []}))
    m = {k: f"media/v1__{k}.{ext}" for k, ext in
         (("video", "mp4"), ("poster", "png"), ("still", "webp"), ("show", "json"))}
    v = {"n": 1, "id": "v1", "created": T0 + 160000, "duration": 2.0, "sections": sections, "parts": [],
         "rationale": f"{label}, take 1", "agent": "fixture", "model": None, "media": m}
    _w(cards / cid / "card.json", json.dumps({
        "id": cid, "type": KINDS["show"], "label": label, "created": T0 + 160000, "created_from": "fixture",
        "agent": "fixture", "model": None, "narrative": {"rationale": "a made-up card for the checks"},
        "lineage": {"parent": None, "refs": [], "why": None}, "versions": [v], "media": m,
        "origin": {"fixture": True}}, indent=1))
    made[KINDS["show"]].append(cid)


def _mkdir(p: Path) -> Path:
    p.mkdir(parents=True, exist_ok=True)
    return p



def build(out: Path) -> dict:
    if out.exists():
        shutil.rmtree(out)
    cards = out / "cards"
    made = {KINDS["visual"]: [], KINDS["music"]: []}

    for i, (cid, label, nv, (a, b)) in enumerate(VISUAL):
        home = cards / cid
        versions = []
        for n in range(1, nv + 1):
            stem = cid if n == 1 else f"{cid[:-1]}{n}"
            media = _pictures(home / "media", stem, a, b, seed=i * 10 + n)
            _w(home / "media" / f"{stem}.frag", f"// fixture shader {stem}: made up, never compiled\n"
                                                 f"void main() {{ gl_FragColor = vec4({n / 4:.2f}); }}\n")
            versions.append({"n": n, "id": f"v{n}", "created": T0 + i * 3600 + n * 600,
                             "rationale": f"{label}, take {n}", "agent": "fixture", "model": "none",
                             "media": media,
                             "parts": [{"kind": "shader", "id": stem, "label": stem, "enabled": True,
                                        "src": f"media/{stem}.frag", "mode": stem, "params": {"rate": 0.5}}]})
        card = {"id": cid, "type": KINDS["visual"], "label": label, "created": T0 + i * 3600,
                "created_from": "fixture", "agent": "fixture", "model": "none",
                "narrative": {"idea": label, "rationale": "a made-up card for the checks"},
                "lineage": {"parent": None, "refs": [], "why": None},
                "versions": versions, "media": versions[-1]["media"], "origin": {"fixture": True}}
        _w(home / "card.json", json.dumps(card, indent=1))
        made[KINDS["visual"]].append(cid)

    for i, (cid, name, label, nv, pitches, base) in enumerate(MUSIC):
        home = cards / cid
        versions = []
        for n in range(1, nv + 1):
            secs = base + n - 1
            parts, mix = [], np.zeros(int(secs * RATE), np.float32)
            for k, f0 in enumerate(pitches):
                x = _voice(f0 * (1 + 0.02 * (n - 1)), secs, seed=i * 31 + n * 7 + k)
                vid = f"v{n}_{['lead', 'pad', 'click'][k]}"
                _mp3(home / "media" / f"v{n}__{vid}.mp3", x)
                _w(home / "media" / f"v{n}__{vid}.scd", f"// fixture voice {vid}: a sine at {f0:g} Hz\n")
                parts.append({"kind": "voice", "id": vid, "label": vid.replace("_", " "), "enabled": True,
                              "group": 0, "src": f"media/v{n}__{vid}.scd", "audio": f"media/v{n}__{vid}.mp3",
                              "peaks": _peaks(x)})
                mix[:len(x)] += x
            _mp3(home / "media" / f"v{n}__mix.mp3", mix / max(1.0, float(np.abs(mix).max()) / 0.9))
            versions.append({"n": n, "id": f"v{n}", "created": T0 + 100000 + i * 3600 + n * 600,
                             "parts": parts, "duration": secs, "rationale": f"{label}, take {n}",
                             "agent": "fixture", "model": "none", "media": {"audio": f"media/v{n}__mix.mp3"}})
        card = {"id": cid, "type": KINDS["music"], "label": label, "name": name, "created": T0 + 100000 + i * 3600,
                "created_from": "fixture", "agent": "fixture", "model": "none",
                "narrative": {"rationale": "a made-up card for the checks"},
                "lineage": {"parent": None, "refs": [], "why": None},
                "versions": versions, "media": versions[-1]["media"], "origin": {"fixture": True}}
        _w(home / "card.json", json.dumps(card, indent=1))
        made[KINDS["music"]].append(cid)

    made[KINDS["show"]] = []
    if SUITE is None:                  # the made-up picker's own tabs; a suite has its own types
        _fits(cards, made)
        _code(cards, made)
    _hard_shapes(cards, made)
    if SUITE is not None and hasattr(SUITE, "extra"):
        SUITE.extra(cards, made, sys.modules[__name__])      # Add suite-specific fixture cards.

    # signals: an archive each, votes either way, a comment, the auto pool
    sig = {cid: [] for kind in made.values() for cid in kind}
    for cid in ARCHIVED:
        sig[cid].append({"kind": "archive", "value": True})
    sig["fxlat1"] += [{"kind": "vote", "value": 1, "version": 3}, {"kind": "pool", "pool": "auto", "value": True},
                      {"kind": "comment", "text": "the rings could be slower"}]
    sig["fxdun1"].append({"kind": "vote", "value": -1, "version": 2})
    sig["fx0a1b2c3d4e"].append({"kind": "vote", "value": 1, "version": 2})
    sig["fx1b2c3d4e5f"].append({"kind": "vote", "value": -1, "version": 2})
    sig[HIDDEN].append({"kind": "held", "version": 3})
    if SUITE is None:
        sig["fxfit01"].append({"kind": "vote", "value": 1, "version": 3})     # the kicks' bar: 0.19 is good
        sig["fxfit04"].append({"kind": "vote", "value": -1, "version": 1})    # the snares': 0.61 is not
    cid, n, item, voice = CUT_ITEM
    sig[cid].append({"kind": "archive", "value": True, "version": n, "item": item, "voice": voice})
    sig[CUT_VOICE[0]].append({"kind": "archive", "value": True, "voice": CUT_VOICE[1]})
    for k, (cid, rows) in enumerate(sig.items()):
        if rows:
            _jsonl(cards / cid / "signals.jsonl",
                   [{"ts": T0 + 200000 + k * 60 + j, **r, "by": "fixture"} for j, r in enumerate(rows)])

    prefs = [{"ts": T0 + 300000, "key": "filters", "value": [KINDS["visual"]]}]
    if os.environ.get("FIXTURE_PUBLIC"):                       # the example picker opens with its lead panels shut
        prefs.append({"ts": T0 + 300001, "key": "panels",
                      "value": {f"{s}:{t}": False for t in FIRST for s in ("auto", "cup", "timeline")}})
    _jsonl(out / "prefs.jsonl", prefs)
    _jsonl(out / "queue.jsonl", [
        {"event": "enqueue", "id": "fxjob000001", "created": T0 + 250000, "type": KINDS["visual"], "kind": "revise",
         "card": "fxlat1", "text": "slower rings", "backend": "claude", "group": None, "ts": T0 + 250000},
        {"event": "claim", "id": "fxjob000001", "researcher": "fixture", "attempt": 1, "ts": T0 + 250010},
        {"event": "done", "id": "fxjob000001", "result": "fxlat1", "attempt": 1, "ts": T0 + 250600},
        {"event": "enqueue", "id": "fxjob000002", "created": T0 + 260000, "type": KINDS["music"], "kind": "inspire",
         "card": "fx0a1b2c3d4e", "text": "", "backend": "codex", "group": None, "ts": T0 + 260000},
        {"event": "claim", "id": "fxjob000002", "researcher": "fixture", "attempt": 1, "ts": T0 + 260010},
        {"event": "failed", "id": "fxjob000002", "why": "made up: the agent said no", "attempt": 1, "ts": T0 + 260300},
    ])
    _w(out / "trace.jsonl", "")
    (out / "queue_media").mkdir(parents=True, exist_ok=True)
    _w(out / "README.md", "A made-up store, written by picker/tests/fixture/build.py. Rebuilt on every run.\n")
    return made



PROGRAM = """# {type}: a made-up program

This is the instructions file of the fixture's FAKE researcher for `{type}` (picker/tests/fixture). A real type's
program tells its agent what a card is, how to make one, how to judge it and where to write it. This one is read by
nobody: the fake runner copies a made-up card's files into a new version and never starts an agent.

## What a card is here

A card is a stack of versions. Each version has its media (a still and a gif for the visual kind, voices and a mix
for the music kind) and its parts. The operator votes on versions; the picker folds the votes into one rating.

## How to make one

Copy the newest version's files, number the new version one past the newest, and let the sync link it into
the store. That is all the fake does, and it is enough for the queue and the store diff to run.
"""
RUNNER_SHIM = """# a shim: move_check.sh mounts this folder over the type's own (the made-up picker's own types: it is their home); the
# fake lives in the picker's tests/fixture. Imported (the insight panel reads TYPE, cwd() and brief() this way) it only
# defines; run, it works the queue.
import os, sys
from pathlib import Path
here = Path(__file__).resolve().parent
os.environ["FAKE_HOME"] = str(here)
sys.path.insert(0, "@FIXTURE@")
from fake_runner import TYPE, brief, cwd, main  # noqa: E402,F401
if __name__ == "__main__":
    sys.exit(main())
"""
SYNC_SHIM = """# a shim: the fake researcher's sync, run by core/researcher.sync with no arguments
import runpy, sys
from pathlib import Path
here = Path(__file__).resolve().parent
sys.argv[1:1] = [str(here)]
runpy.run_path("@FIXTURE@/fake_sync.py", run_name="__main__")
"""


def _config():
    """core/config.py, loaded by path (the fixture is built before any picker module is imported)."""
    import importlib.util
    spec = importlib.util.spec_from_file_location("_picker_config",
                                                  Path(__file__).resolve().parents[2] / "core" / "config.py")
    mod = sys.modules[spec.name] = importlib.util.module_from_spec(spec)   # registered: its dataclass looks itself up
    spec.loader.exec_module(mod)
    return mod


def types_of(C, cfg) -> list:
    """Additional manifests are resolved against the fixture config, not a production config."""
    import dataclasses
    extra = tuple(Path(m).resolve() for m in os.environ.get("FIXTURE_TYPES", "").split(":") if m)
    if not cfg.types and not extra:       # no project's config, and nothing tried with --with
        return []
    out = C.types(dataclasses.replace(cfg, types=cfg.types + extra))
    ids = [t.get("type") for t in out]
    dup = sorted({i for i in ids if ids.count(i) > 1})
    if dup:
        raise SystemExit(f"type {', '.join(map(str, dup))} is in the config twice (--with a type it has already?)")
    return out


def _absolute(C, entry: dict, cfg) -> dict:
    """A served manifest entry with its paths absolute: a manifest written somewhere else (the fixture's copy)."""
    return C._paths(entry, lambda v: os.path.normpath(cfg.research / v))


def _shim(text: str) -> str:
    return text.replace("@FIXTURE@", str(Path(__file__).resolve().parent))


def _no_project(C):
    """Resolve external manifests against a config with no production types."""
    return C.Config(file=Path("/"), data=Path("/"), state=Path("/"), cache=Path("/"), agents=Path("/"), types=(),
                    research=Path("/"), downloads=Path("/"), band=None, plugins=(), host="", port=0)


def runners(out: Path, store: Path | None = None, dry: Path | None = None) -> dict:
    """Mount fake homes over runner folders; dry runs retain real manifests and write only copied stores."""
    C = _config()
    if out.exists():
        shutil.rmtree(out)
    homes, listed, dry_listed, mine = {}, [], [], []
    cfg = C.read(C.DEFAULT.resolve()) if SUITE is not None else _no_project(C)
    for t in types_of(C, cfg):
        home = out / t["type"]
        music = t["type"] == KINDS["music"]
        _w(home / "fake.json", json.dumps({"type": t["type"], "kind": "music" if music else "visual",
                                           "seed_from": MUSIC[3][0] if music else VISUAL[2][0]}))
        _w(home / "queue_runner.py", _shim(RUNNER_SHIM))
        _w(home / "sync.py", _shim(SYNC_SHIM))
        (home / "runs").mkdir()
        real = (cfg.research / t["researcher"]).resolve().parent
        homes[t["type"]] = str(real)
        prog = (cfg.research / (t.get("program") or "")).resolve()
        if prog.parent == real:                                # the instructions file, made up, where it is read
            _w(home / prog.name, PROGRAM.format(type=t["type"]))
        if t.get("plugin"):                                    # Copy plugin modules hidden by the fake runner mount.
            for f in (cfg.research / t["plugin"]).resolve().parent.glob("picker_*.*"):
                shutil.copy2(f, home / f.name)
        m = out / "types" / f"{t['type']}.json"
        fx = {**t, "label": LABELS.get(t["type"], t["label"]), "sync": {"argv": ["{python}", f"{real}/sync.py"], "cwd": "."}}
        if store is not None:
            fx["cards"] = str(store / "stores" / t["type"])
        _w(m, json.dumps(_absolute(C, fx, cfg), indent=1))
        if t["type"] not in UNSHOWN:
            listed.append(str(m))
        mine.append(t["type"])
        if dry is not None:
            dm = out / "dry" / f"{t['type']}.json"
            _w(dm, json.dumps(_absolute(C, {**t, "cards": str(dry / "stores" / t["type"])}, cfg), indent=1))
            dry_listed.append(str(dm))
    _w(out / "homes.json", json.dumps(homes))
    if SUITE is None:
        # Fixture-only types need no mounted production folder or real-runner dry run.
        for mf in sorted(OWN.glob("*.json")):
            t = json.loads(mf.read_text())
            home = out / t["type"]
            _w(home / "fake.json", json.dumps({"type": t["type"], "kind": t["type"][3:], "seed_from": OWN_SEED[t["type"]]}))
            _w(home / "queue_runner.py", _shim(RUNNER_SHIM))
            _w(home / "sync.py", _shim(SYNC_SHIM))
            _w(home / "program.md", PROGRAM.format(type=t["type"]))
            (home / "runs").mkdir()
            fx = {**t, "researcher": str(home / t["researcher"]), "program": str(home / "program.md"),
                  "outputs": [str(home / "runs")], "sync": {"argv": ["{python}", str(home / "sync.py")], "cwd": str(home)},
                  "cards": str((store / "stores" / t["type"]) if store is not None else home / "cards")}
            m = out / "types" / f"{t['type']}.json"
            _w(m, json.dumps(fx, indent=1))
            if not (os.environ.get("FIXTURE_PUBLIC") and t["type"] in STOOD_FOR):
                listed.append(str(m))
            mine.append(t["type"])
        for mf in EXAMPLES:
            t = json.loads(mf.read_text())
            home = out / t["type"]
            shutil.copytree(mf.parent, home, ignore=shutil.ignore_patterns("runs", "cards", "logs", "runner*.json",
                                                                          "__pycache__"))
            cards = (store / "stores" / t["type"]) if store is not None else home / "cards"
            # the checks want eight of each; the example picker shows what each example seeds by itself
            count = [] if os.environ.get("FIXTURE_PUBLIC") else ["8"]
            subprocess.run([sys.executable, "seed.py", *count, "--runs-only"], cwd=home, check=True, capture_output=True)
            subprocess.run([sys.executable, "-c", "import sys; sys.path[:0] = sys.argv[1:3]; import sync; "
                            "sync.project(sys.argv[3], sys.argv[4])",
                            str(home), str(Path(__file__).resolve().parents[2]), str(home / "runs"), str(cards)],
                           cwd=home, check=True, capture_output=True)
            fx = {**t, "researcher": str(home / t["researcher"]), "program": str(home / t["program"]),
                  **({"plugin": str(home / t["plugin"])} if t.get("plugin") else {}),
                  "outputs": [str(home / o) for o in t["outputs"]], "cards": str(cards),
                  "sync": {"argv": t["sync"]["argv"], "cwd": str(home)}}
            m = out / "types" / f"{t['type']}.json"
            _w(m, json.dumps(fx, indent=1))
            listed.append(str(m))
            mine.append(t["type"])
    rank = {t: i for i, t in enumerate(FIRST)}
    listed.sort(key=lambda m: rank.get(Path(m).stem, len(FIRST)))       # stable: the others keep the config's order
    _w(out / "types.toml", json.dumps(listed))
    if dry is not None:
        _w(out / "dry_types.toml", json.dumps(dry_listed))
    if store is not None:
        _by_type(store, mine)
        _linked(store, out, homes)
    return homes


def _by_type(store: Path, types: list) -> None:
    """Write each fixture card only into its fixture type store."""
    for d in sorted((store / "cards").iterdir()):
        t = json.loads((d / "card.json").read_text())["type"]
        if t not in types:
            raise SystemExit(f"{d.name}: type {t} is not in the config")
        (store / "stores" / t).mkdir(parents=True, exist_ok=True)
        d.rename(store / "stores" / t / d.name)
    (store / "cards").rmdir()


def _linked(store: Path, runners_dir: Path, homes: dict) -> None:
    """Resolve relative media links at sandbox mount paths, not at their build-time locations."""
    cid, label = LINKED
    v = KINDS["visual"]
    research = runners_dir / v / "runs" / cid / "v1"
    card = _visual_card(cid, label, (1,), (30, 90, 30), (200, 255, 120), 90, research, T0 + 50000)
    there = Path(homes.get(v, runners_dir / v)) / "runs" / cid / "v1"
    media = store / "stores" / v / cid / "media"
    media.mkdir(parents=True, exist_ok=True)
    for f in sorted(research.iterdir()):
        os.symlink(os.path.relpath(there / f.name, media), media / f.name)
    _w(store / "stores" / v / cid / "card.json", json.dumps(card, indent=1))


def use_suite(d: str | None) -> None:
    """Load suite-specific type mappings and extra fixture cards."""
    global SUITE
    if not d:
        return
    import importlib.util
    spec = importlib.util.spec_from_file_location("_suite_fixture", Path(d) / "fixture.py")
    SUITE = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(SUITE)
    KINDS.update(getattr(SUITE, "KINDS", {}))
    LABELS.update(getattr(SUITE, "LABELS", {}))
    UNSHOWN.update(getattr(SUITE, "UNSHOWN", set()))


if __name__ == "__main__":
    args = sys.argv[1:]
    if "--suite" in args:
        i = args.index("--suite")
        use_suite(args[i + 1])
        del args[i:i + 2]
    if len(args) not in (1, 3) or (len(args) == 3 and args[1] != "--runners"):
        sys.exit(__doc__)
    got = build(Path(args[0]).resolve())
    if len(args) == 3:                  # the dry runs' copy of the store beside it (move_check.sh: <work>/dry)
        store = Path(args[0]).resolve()
        runners(Path(args[2]).resolve(), store, store.parent / "dry")
    print(json.dumps({k: len(v) for k, v in got.items()}))
