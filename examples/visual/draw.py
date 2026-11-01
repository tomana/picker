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


def glass(p: dict, t: float, n: int, ss: int = 2) -> Image.Image:
    """A "glass" card: grey rings on black with light breaking through. A lumpy shape (as in contours) in front of a
    far, tilted wall; both are combed by two sheets of fine rings round a point on the shape, the second shifted by
    the surface's tilt, so where the sheets beat they draw tilt rings (Newton's rings), and the lines glint where the
    two agree, brighter where a surface faces the viewer. A dim light above the shape's top lights a thin rim on it;
    then its rays: from each pixel toward the light, the picture summed with a decaying weight and added back. The
    shape comes from the card's name; count sets the ring pitch, twist the wall, warp the wave; over a loop the rings
    move out one ring."""
    rnd = random.Random(hashlib.sha256(p["name"].encode()).hexdigest())
    bumps = [(rnd.uniform(-.5, .5), rnd.uniform(-.25, .75), rnd.uniform(.12, .34), rnd.uniform(.15, .43),
              rnd.uniform(.5, 1.0)) for _ in range(rnd.randint(3, 6))]
    ph0 = rnd.uniform(0, 6)

    def height(x, y):
        h = np.zeros_like(x)
        for cx, cy, sx, sy, a in bumps:
            h += a * np.exp(-((x - cx) ** 2 / (2 * sx * sx) + (y - cy) ** 2 / (2 * sy * sy)))
        return h + .05 * (1 + p["warp"]) * np.sin(4.3 * x + 2.1 * y + ph0) * np.sin(3.1 * y - 1.7 * x)

    N = n * ss
    y, x = np.mgrid[-1:1:N * 1j, -1:1:N * 1j]
    h = height(x, y)
    on = h > .3
    e = .004
    gx = np.where(on, (height(x + e, y) - h) / e, 1.1 * np.cos(p["twist"]))
    gy = np.where(on, (height(x, y + e) - h) / e, 1.1 * np.sin(p["twist"]))
    z = np.where(on, 1.2 - h, 3 + .5 * (x * np.cos(p["twist"]) + y * np.sin(p["twist"])))
    alpha = np.minimum(1.25, np.arctan(np.hypot(gx, gy) * .8))
    top = min(bumps, key=lambda b: b[1] - b[3])                  # the light: above the shape's highest edge
    lx, ly = top[0] + rnd.uniform(-.1, .1), top[1] - top[3] * .55
    ax, ay = bumps[0][0] + rnd.uniform(-.15, .15), bumps[0][1] + rnd.uniform(-.15, .15)   # the rings' centre
    pitch = .032 + .004 * (8 - p["count"] % 8)
    d1 = np.sqrt((x - ax) ** 2 + (y - ay) ** 2 + .3 * (z - .6) ** 2)
    phase_a = d1 / pitch - t                                     # one ring outward over the loop
    phase_b = phase_a + alpha * 14 / (2 * np.pi)
    crest = lambda ph: (.5 + .5 * np.cos(2 * np.pi * ph)) ** 6   # a thin line each cycle
    glint = (.5 * (crest(phase_a) + crest(phase_b))) ** 3
    dl = np.hypot(x - lx, y - ly)
    behind = (~on).astype(float)
    halo, back, pearl = np.exp(-dl / .09), np.exp(-dl / .16), np.exp(-alpha ** 2 / .26 ** 2)
    lit = .9 * (1 + .9 * pearl) * np.where(on, 1.35, .72 * .75) * (1 + 5.5 * halo * behind)
    L = .004 + lit * glint * 2.2 + .24 * np.exp(-dl / .05) * behind
    rim = np.clip((.42 - h) / .12, 0, 1) * on
    L = L * (1 - rim * .6) + np.minimum(.38 * (1 + 1.8 * back), 1) * rim * .6
    base = L.reshape(n, ss, n, ss).mean(axis=(1, 3))
    # the rays: 48 taps toward the light, each weighted .94 of the last, the floor taken off
    j, i = np.mgrid[0:n, 0:n].astype(float)
    LX, LY = (lx + 1) / 2 * n, (ly + 1) / 2 * n
    taps, density, decay, gain, floor = 48, .6, .94, 1.6, .02
    dx, dy = (i - LX) * density / taps, (j - LY) * density / taps
    acc, ws, w = np.zeros((n, n)), 0.0, 1.0
    for k in range(taps):
        qx, qy = (i - k * dx).astype(int), (j - k * dy).astype(int)
        ok = (qx >= 0) & (qy >= 0) & (qx < n) & (qy < n)
        acc += np.where(ok, np.maximum(base[np.clip(qy, 0, n - 1), np.clip(qx, 0, n - 1)] - floor, 0), 0) * w
        ws += w
        w *= decay
    L = base + acc / ws * gain
    L = np.where(L > .6, .6 + .4 * (1 - np.exp(-(L - .6) / .4)), L)   # keep the rings through the bright parts
    v = (np.clip(L, 0, 1) * 255).astype(np.uint8)
    return Image.fromarray(np.stack([v, v, v], -1), "RGB")


def picture(p: dict, t: float, n: int) -> Image.Image:
    """The field through the colours, dark to light: two colours blend, more are stops along the way; an "orig01"
    card is contours, a "glass" card glass (above)."""
    if p["colors"] == "orig01":
        return contours(p, t, n)
    if p["colors"] == "glass":
        return glass(p, t, n)
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
