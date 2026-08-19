"""Camera framing: the masks and backdrops that let the picture move and change shape.

The picture itself is moved by ffmpeg (scale + overlay, both evaluated per frame). What ffmpeg
cannot do is change the SHAPE of the visible area over time: a rectangle that rounds off into a
circle. geq can express it, but at 1080p it takes minutes per second of video — measured. So the
shape is drawn here with Pillow, one PNG per frame of the move (a 0.8s move is 24 frames, about
half a second of work), and held as a still for as long as the framing stays put.

Everything is in canvas space (the full 1920x1080 frame), which is what lets a 16:9 picture be
cropped to a square or a circle without distorting it: the picture is scaled so it always fills
the mask, and the mask decides what you see.
"""
import math, os
from PIL import Image, ImageDraw, ImageFilter

SS = 2                      # supersample, then downsample — Pillow has no antialiased shapes


def ease(p, kind="inout"):
    p = min(1.0, max(0.0, p))
    if kind == "linear": return p
    if kind == "out":    return 1 - (1 - p) ** 3
    if kind == "in":     return p ** 3
    return 0.5 - 0.5 * math.cos(math.pi * p)          # inout, the default


def card_geometry(VW, VH):
    """The scene layout's video card — the portrait panel a scene leaves empty on the right.

    Imported from scenes_png so there is one definition of where the card is: if that moves and
    this does not, the picture animates into a hole that is no longer there.
    """
    from scenes_png import CARD
    sx, sy = VW / 1920.0, VH / 1080.0
    return dict(x=CARD["x"] * sx, y=CARD["y"] * sy, w=CARD["w"] * sx, h=CARD["h"] * sy,
                r=CARD["r"] * min(sx, sy))


def state_geometry(st, VW, VH):
    """Where the picture sits and what shape it is, for one framing state.

    Returns picture height (the picture keeps 16:9 and always covers the mask), the centre both
    share, the mask's width/height, and its corner radius. Sizes and margins are fractions of the
    frame width so a project survives a change of resolution.
    """
    mode = st.get("to", "full")
    margin = float(st.get("margin", 0.04)) * VW

    if mode == "full":
        return dict(ph=VH, cx=VW / 2, cy=VH / 2, mw=VW, mh=VH, r=0.0)

    if mode == "card":
        # Into the scene layout's card. The picture is scaled so it COVERS the card (the card is
        # portrait, the picture is 16:9, so height decides), and the mask crops the sides —
        # which is what the old static version did with a centre crop, only now it can move.
        c = card_geometry(VW, VH)
        return dict(ph=c["h"], cx=c["x"] + c["w"] / 2, cy=c["y"] + c["h"] / 2,
                    mw=c["w"], mh=c["h"], r=c["r"])

    if mode == "side":
        pw = float(st.get("size", 0.42)) * VW
        ph = pw * VH / VW
        cx = margin + pw / 2 if st.get("side", "right") == "left" else VW - margin - pw / 2
        r = 0.0 if st.get("shape") == "rect" else float(st.get("radius", 28))
        return dict(ph=ph, cx=cx, cy=VH / 2, mw=pw, mh=ph, r=r)

    # corner: a square/rounded/circular window. The picture is scaled so its HEIGHT matches the
    # window; being 16:9 it is wider than the window, and the mask crops the sides.
    d = float(st.get("size", 0.26)) * VW
    shape = st.get("shape", "circle")
    r = d / 2 if shape == "circle" else (0.0 if shape == "rect" else float(st.get("radius", 26)))
    corner = st.get("corner", "br")
    cx = margin + d / 2 if corner in ("tl", "bl") else VW - margin - d / 2
    cy = margin + d / 2 if corner in ("tl", "tr") else VH - margin - d / 2
    return dict(ph=d, cx=cx, cy=cy, mw=d, mh=d, r=r)


def lerp(a, b, e):
    return a + (b - a) * e


def draw_mask(g, VW, VH):
    """One mask frame: white where the picture shows through, black elsewhere."""
    img = Image.new("L", (VW * SS, VH * SS), 0)
    d = ImageDraw.Draw(img)
    box = [(g["cx"] - g["mw"] / 2) * SS, (g["cy"] - g["mh"] / 2) * SS,
           (g["cx"] + g["mw"] / 2) * SS, (g["cy"] + g["mh"] / 2) * SS]
    r = g["r"] * SS
    # a radius at or beyond half the smaller side is a circle; Pillow refuses radii that big
    r = min(r, min(box[2] - box[0], box[3] - box[1]) / 2)
    if r < 1: d.rectangle(box, fill=255)
    else:     d.rounded_rectangle(box, radius=r, fill=255)
    return img.resize((VW, VH), Image.LANCZOS)


def write_transition(outdir, prefix, frm, to, seconds, fps, VW, VH, kind="inout"):
    """Draw every frame of one move. Returns the number of frames written."""
    os.makedirs(outdir, exist_ok=True)
    a, b = state_geometry(frm, VW, VH), state_geometry(to, VW, VH)
    n = max(1, int(round(seconds * fps)))
    for i in range(n):
        e = ease(i / n, kind)
        g = {k: lerp(a[k], b[k], e) for k in a}
        draw_mask(g, VW, VH).save(os.path.join(outdir, f"{prefix}{i:05d}.png"))
    return n


def write_still(path, st, VW, VH):
    draw_mask(state_geometry(st, VW, VH), VW, VH).save(path)


def write_backdrop(path, VW, VH, base="#0a0a09", glow1="#f3b04a", glow2="#a86cf7", strength=0.55):
    """The branded wash the picture sits on: two soft glows over a near-black ground.

    Deliberately low contrast — it is behind a talking head and a slab of motion graphics, and
    anything livelier fights both.
    """
    def rgb(h):
        h = h.lstrip("#")
        return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))

    img = Image.new("RGB", (VW, VH), rgb(base))
    glow = Image.new("RGB", (VW, VH), (0, 0, 0))
    g = ImageDraw.Draw(glow)
    c1, c2 = rgb(glow1), rgb(glow2)
    # top-left and bottom-right, well off the edges so no hard boundary shows
    g.ellipse([-VW * 0.25, -VH * 0.45, VW * 0.55, VH * 0.5],
              fill=tuple(int(c * 0.32) for c in c1))
    g.ellipse([VW * 0.45, VH * 0.4, VW * 1.3, VH * 1.5],
              fill=tuple(int(c * 0.30) for c in c2))
    glow = glow.filter(ImageFilter.GaussianBlur(VW * 0.09))
    Image.blend(img, Image.blend(img, glow, 0.9), strength).save(path)
