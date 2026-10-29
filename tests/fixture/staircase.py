"""The scored example's picture: the loop's staircase, one try marked."""
from PIL import Image, ImageDraw, ImageFont

G, R, MUT, FG, DOT, LINE, BG = ((143, 199, 154), (201, 139, 139), (149, 149, 149), (235, 235, 235), (109, 109, 109),
                                (90, 90, 90), (20, 20, 20))


def draw(path, tries: list[dict], me: int, unit: str = "ms", S: int = 2) -> None:
    """`tries` in the order made, each {"value", "kept", "label"}: every try's value, the best so far as a step line
    (lower is better, so drawn higher), try `me` marked: filled if kept, hollow if reverted."""
    im = Image.new("RGB", (240 * S, 240 * S), BG)
    d = ImageDraw.Draw(im)
    ks = [t["value"] for t in tries]
    pad = (max(ks) - min(ks)) * 0.08 or 1
    lo, hi = min(ks) - pad, max(ks) + pad
    x = (lambda i: S * (18 + i * 204 / (len(tries) - 1))) if len(tries) > 1 else (lambda i: S * 120)
    y = lambda k: S * (56 + (k - lo) / (hi - lo) * 124)
    pts, best = [], None
    for i, t in enumerate(tries):
        if t["kept"]:
            if best is not None:
                pts.append((x(i), y(best)))
            pts.append((x(i), y(t["value"])))
            best = t["value"]
    if best is not None:
        d.line(pts + [(x(len(tries) - 1) + 6 * S, y(best))], fill=LINE, width=2 * S)

    def dot(i, r, fill, ring, w):
        cx, cy = x(i), y(tries[i]["value"])
        d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=fill, outline=ring, width=w)

    for i, t in enumerate(tries):
        if i != me:
            dot(i, 3.4 * S, DOT if t["kept"] else None, DOT, round(1.6 * S))
    t = tries[me]
    dot(me, 7.5 * S, G if t["kept"] else BG, G if t["kept"] else R, 3 * S)
    f = lambda size: ImageFont.load_default(size=size * S)
    d.text((12 * S, 32 * S), f"{t['value']:.4g} {unit}", font=f(21), fill=FG, anchor="ls")
    d.text((228 * S, 30 * S), "KEPT" if t["kept"] else "REVERTED", font=f(15), fill=G if t["kept"] else R, anchor="rs")
    words = f"{me + 1}. {t['label']}"
    d.text((12 * S, 224 * S), words if len(words) <= 24 else words[:23].rstrip() + "…", font=f(20), fill=MUT, anchor="ls")
    im.save(path)
