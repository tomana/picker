"""Draws a pattern (program.md) as the picker shows it: a still, 360 px square, and a gif of one loop, 180 px."""
import hashlib
import random
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
    # rings: twist squashes them into ovals (whole twists here made spiral arms)
    q = np.hypot(x, y * (1 + .35 * p["twist"]))
    return np.sin(2 * np.pi * p["count"] * q + ph + wob)


def orig01(v: np.ndarray) -> np.ndarray:
    """orig01: the hue wheel at saturation 0.85, value 220/255, wrapping with v."""
    h, s, val = (v % 1.0) * 6, 0.85, 220 / 255
    i, f = np.floor(h).astype(int) % 6, h - np.floor(h)
    p, q, t = val * (1 - s), val * (1 - s * f), val * (1 - s * (1 - f))
    ch = [(val, t, p), (q, val, p), (p, val, t), (p, q, val), (t, p, val), (val, p, q)]
    rgb = np.zeros(v.shape + (3,))
    for k, c in enumerate(ch):
        m = i == k
        for j in range(3):
            rgb[..., j][m] = (c[j][m] if np.ndim(c[j]) else c[j]) * 255
    return rgb


def contours(p: dict, t: float, n: int, ss: int = 3) -> Image.Image:
    """An "orig01" card: a depth camera's view coloured by depth through the hue wheel, wrapping many times, so the
    bands are contour lines. A lumpy surface in front (soft bumps summed, a slow wave over them; where it rises past a
    level is the shape, its height its depth); a steep wall behind, whose hue wraps faster than the pixels, so it
    reads grey; and a shadow beside the shape where the camera sees no depth, black. Drawn at ss× and boxed down.
    The shape comes from the card's name, so its versions keep it; count sets the bands, twist the wall, warp the
    wave; over a loop the bands flow one whole turn of the wheel."""
    rnd = random.Random(hashlib.sha256(p["name"].encode()).hexdigest())
    N = n * ss
    y, x = np.mgrid[-1:1:N * 1j, -1:1:N * 1j]
    h = np.zeros_like(x)
    for _ in range(rnd.randint(3, 6)):
        cx, cy = rnd.uniform(-.5, .5), rnd.uniform(-.35, .65)
        sx, sy = rnd.uniform(.12, .35), rnd.uniform(.15, .45)
        h += rnd.uniform(.5, 1.0) * np.exp(-((x - cx) ** 2 / (2 * sx * sx) + (y - cy) ** 2 / (2 * sy * sy)))
    h += .06 * (1 + p["warp"]) * np.sin(4.3 * x + 2.1 * y + rnd.uniform(0, 6)) * np.sin(3.1 * y - 1.7 * x)
    shape = h > .3
    k = 2 + .7 * p["count"]                                  # wraps per unit of depth: bands a few pixels wide
    a = p["twist"]
    wall = 9 + 55 / k * (x * np.cos(a) + y * np.sin(a))     # steep enough to wrap faster than a pixel
    z = np.where(shape, 2 - h, wall)
    rgb = orig01(z * k + t)
    dx, dy = int(.09 * N), int(.03 * N)                      # the shadow: the shape moved right and down, outside it
    shadow = np.zeros_like(shape)
    shadow[dy:, dx:] = shape[:N - dy, :N - dx]
    rgb[shadow & ~shape] = 0
    return Image.fromarray(rgb.astype(np.uint8), "RGB").resize((n, n), Image.BOX)


def picture(p: dict, t: float, n: int) -> Image.Image:
    """The field through the colours, dark to light: two colours blend, more are stops along the way; an "orig01"
    card is contours (above)."""
    if p["colors"] == "orig01":
        return contours(p, t, n)
    v = (field(p, t, n) + 1) / 2
    stops = np.array([_rgb(c) for c in p["colors"]])
    x = v * (len(stops) - 1)
    i = np.clip(np.floor(x).astype(int), 0, len(stops) - 2)
    f = (x - i)[..., None]
    return Image.fromarray((stops[i] * (1 - f) + stops[i + 1] * f).astype(np.uint8), "RGB")


def draw(p: dict, out: Path, frames: int = 20) -> dict:
    """still.png and anim.gif into `out`; returns the version's media."""
    out = Path(out)
    picture(p, 0, 360).save(out / "still.png")
    gif = [picture(p, k / frames, 180).convert("P", palette=Image.ADAPTIVE, colors=64) for k in range(frames)]
    gif[0].save(out / "anim.gif", save_all=True, append_images=gif[1:], duration=80, loop=0, optimize=True)
    return {"still": "still.png", "gif": "anim.gif"}
