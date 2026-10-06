"""Home-screen icons: the Corpus mark (a label line and the yellow mask that covers it) on the app's green."""
from PIL import Image, ImageDraw
import os
OUT = os.path.join(os.path.dirname(__file__), '..', 'icons')
BG, LINE, MASK, EDGE = (30, 90, 84), (237, 240, 238), (243, 184, 63), (198, 138, 13)

def mark(size, scale, rounded):
    S = size * 4                                   # draw large, downsample for smooth edges
    im = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    if rounded: d.rounded_rectangle([0, 0, S - 1, S - 1], radius=int(S * 0.225), fill=BG)
    else: d.rectangle([0, 0, S, S], fill=BG)
    w = S * scale                                  # width of the whole mark
    lw, mw, mh, gap = w * 0.36, w * 0.52, w * 0.32, w * 0.12
    x0 = (S - (lw + gap + mw)) / 2; cy = S / 2
    th = max(4, w * 0.055)
    d.rounded_rectangle([x0, cy - th / 2, x0 + lw, cy + th / 2], radius=th / 2, fill=LINE)
    mx = x0 + lw + gap; r = mh * 0.18; e = max(3, w * 0.03)
    d.rounded_rectangle([mx, cy - mh / 2, mx + mw, cy + mh / 2], radius=r, fill=EDGE)
    d.rounded_rectangle([mx + e, cy - mh / 2 + e, mx + mw - e, cy + mh / 2 - e], radius=max(1, r - e), fill=MASK)
    return im.resize((size, size), Image.LANCZOS)

os.makedirs(OUT, exist_ok=True)
mark(192, 0.70, True).save(os.path.join(OUT, 'icon-192.png'))
mark(512, 0.70, True).save(os.path.join(OUT, 'icon-512.png'))
mark(512, 0.56, False).save(os.path.join(OUT, 'icon-maskable-512.png'))
mark(180, 0.66, False).convert('RGB').save(os.path.join(OUT, 'apple-touch-icon.png'))   # iOS rounds the corners itself
print('icons written')
