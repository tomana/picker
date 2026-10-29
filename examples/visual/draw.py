"""Draws a pattern (program.md) as the picker shows it: a still, 360 px square, and a gif of one loop, 180 px."""
from pathlib import Path

import numpy as np
from PIL import Image


def _rgb(c: str) -> np.ndarray:
    c = c.lstrip("#")
    return np.array([int(c[i:i + 2], 16) for i in (0, 2, 4)], float)


def field(p: dict, t: float, n: int) -> np.ndarray:
    """The pattern at time t (0..1, one loop) on an n×n grid, −1..1."""
    y, x = np.mgrid[-1:1:n * 1j, -1:1:n * 1j]
    r, a = np.hypot(x, y), np.arctan2(y, x)
    ph = 2 * np.pi * t * round(p["speed"] * 4) / 4 or 2 * np.pi * t     # whole turns, so the loop closes
    wob = p["warp"] * np.sin(3 * a + ph)
    if p["shape"] == "bands":
        return np.sin(np.pi * p["count"] * (x * np.cos(p["twist"]) + y * np.sin(p["twist"])) + ph + 2 * wob)
    if p["shape"] == "spiral":
        return np.sin(p["count"] * a + 6 * np.pi * p["twist"] * r + ph + wob)
    return np.sin(2 * np.pi * p["count"] * r + round(p["twist"]) * a + ph + wob)    # a whole twist: no seam where it meets


def picture(p: dict, t: float, n: int) -> Image.Image:
    v = (field(p, t, n)[..., None] + 1) / 2
    dark, light = _rgb(p["colors"][0]), _rgb(p["colors"][1])
    return Image.fromarray((dark * (1 - v) + light * v).astype(np.uint8), "RGB")


def draw(p: dict, out: Path, frames: int = 20) -> dict:
    """still.png and anim.gif into `out`; returns the version's media."""
    out = Path(out)
    picture(p, 0, 360).save(out / "still.png")
    gif = [picture(p, k / frames, 180).convert("P", palette=Image.ADAPTIVE, colors=64) for k in range(frames)]
    gif[0].save(out / "anim.gif", save_all=True, append_images=gif[1:], duration=80, loop=0, optimize=True)
    return {"still": "still.png", "gif": "anim.gif"}
