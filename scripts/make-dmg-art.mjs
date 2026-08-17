// Draw the disk-image background a user sees when they open Cutright.dmg.
//
//   node scripts/make-dmg-art.mjs
//
// Produces build/background.png (@1x), build/background@2x.png and build/background.tiff
// (the multi-resolution file macOS actually wants). The icon slots below MUST stay in sync
// with `build.dmg.contents` in package.json — the art draws the wells, Finder drops the
// icons into them.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FONT_DIR = '/tmp/cutright-fontsrc';
const FONTS = {
  'Anton-Regular.ttf': 'https://fonts.gstatic.com/s/anton/v27/1Ptgg87LROyAm3Kz-Co.ttf',
  'Archivo-Regular.ttf': 'https://fonts.gstatic.com/s/archivo/v25/k3k6o8UDI-1M0wlSV9XAw6lQkqWY8Q82sJaRE-NWIDdgffTTNDNZ9xds.ttf',
  'Archivo-Bold.ttf': 'https://fonts.gstatic.com/s/archivo/v25/k3k6o8UDI-1M0wlSV9XAw6lQkqWY8Q82sJaRE-NWIDdgffTT0zRZ9xds.ttf',
};

mkdirSync(FONT_DIR, { recursive: true });
for (const [name, url] of Object.entries(FONTS)) {
  const p = join(FONT_DIR, name);
  if (!existsSync(p)) {
    const r = spawnSync('curl', ['-sL', '-o', p, url]);
    if (r.status !== 0) { console.error('could not fetch ' + name); process.exit(1); }
  }
}

const py = `
import os
from PIL import Image, ImageDraw, ImageFont, ImageFilter

FD = "${FONT_DIR}"
OUT = "${join(ROOT, 'build')}"
S = 2                                  # draw at 2x, downsample for @1x
W, H = 560 * S, 400 * S

# brand tokens (same values the app uses)
INK      = (10, 10, 9)
INK_WARM = (20, 17, 12)
TEXT     = (245, 243, 238)
DIM      = (142, 139, 130)
AMBER    = (243, 176, 74)
VIOLET   = (168, 108, 247)

def font(name, size):
    return ImageFont.truetype(os.path.join(FD, name), size * S)

img = Image.new("RGB", (W, H), INK)
d = ImageDraw.Draw(img)

# --- warm vertical gradient
for y in range(H):
    t = y / H
    d.line([(0, y), (W, y)], fill=(
        int(INK[0] + (INK_WARM[0] - INK[0]) * t),
        int(INK[1] + (INK_WARM[1] - INK[1]) * t),
        int(INK[2] + (INK_WARM[2] - INK[2]) * t)))

# --- the two brand glows, blurred so they read as light not shapes
glow = Image.new("RGB", (W, H), (0, 0, 0))
gd = ImageDraw.Draw(glow)
gd.ellipse([-160*S, -220*S, 300*S, 160*S], fill=(70, 48, 16))     # amber, top-left
gd.ellipse([300*S, 230*S, 760*S, 560*S], fill=(48, 28, 74))       # violet, bottom-right
glow = glow.filter(ImageFilter.GaussianBlur(90 * S))
img = Image.blend(img, Image.blend(img, glow, 0.9), 0.55)
d = ImageDraw.Draw(img)

# --- header: logo mark + wordmark, centred
mark = Image.open(os.path.join(OUT, "icon.png")).convert("RGBA").resize((34*S, 34*S), Image.LANCZOS)
anton = font("Anton-Regular.ttf", 30)
title = "CUTRIGHT"
tw = d.textlength(title, font=anton)
block = 34*S + 14*S + tw
x0 = (W - block) / 2
img.paste(mark, (int(x0), int(34*S)), mark)
d.text((x0 + 34*S + 14*S, 34*S - 2*S), title, font=anton, fill=TEXT)

sub = font("Archivo-Regular.ttf", 10)
subtitle = "BY VIDDESCRIPTOR  —  AI MEDIA STUDIO"
# letter-spaced by hand: PIL has no tracking
def spaced(draw, xy, text, f, fill, extra):
    x, y = xy
    for ch in text:
        draw.text((x, y), ch, font=f, fill=fill)
        x += draw.textlength(ch, font=f) + extra
    return x
sw = sum(d.textlength(c, font=sub) + 2.2*S for c in subtitle)
spaced(d, ((W - sw) / 2, 78*S), subtitle, sub, DIM, 2.2*S)

# --- icon wells. These centres MUST match build.dmg.contents in package.json.
APP_C   = (150 * S, 200 * S)
APPS_C  = (410 * S, 200 * S)
WELL    = 124 * S
for cx, cy in (APP_C, APPS_C):
    box = [cx - WELL/2, cy - WELL/2, cx + WELL/2, cy + WELL/2]
    d.rounded_rectangle(box, radius=24*S, fill=(24, 22, 19))
    d.rounded_rectangle(box, radius=24*S, outline=(46, 42, 36), width=max(1, int(1.5*S)))

# --- arrow between the wells
ax0 = APP_C[0] + WELL/2 + 22*S
ax1 = APPS_C[0] - WELL/2 - 22*S
ay  = APP_C[1]
d.line([(ax0, ay), (ax1 - 12*S, ay)], fill=AMBER, width=max(2, int(3*S)))
d.polygon([(ax1, ay), (ax1 - 15*S, ay - 9*S), (ax1 - 15*S, ay + 9*S)], fill=AMBER)

# --- instruction + the one prerequisite worth saying up front
inst = font("Archivo-Bold.ttf", 13)
line = "Drag Cutright into your Applications folder"
d.text(((W - d.textlength(line, font=inst)) / 2, 302*S), line, font=inst, fill=TEXT)

note = font("Archivo-Regular.ttf", 10)
line2 = "Needs ffmpeg and Python 3 — the app checks on first launch and tells you how"
d.text(((W - d.textlength(line2, font=note)) / 2, 326*S), line2, font=note, fill=DIM)

# --- a hairline film strip at the very bottom, echoing the mark
sy = 356*S
d.rounded_rectangle([40*S, sy, W - 40*S, sy + 10*S], radius=3*S, fill=(30, 27, 23))
x = 52*S
while x < W - 52*S:
    d.rounded_rectangle([x, sy + 3*S, x + 7*S, sy + 7*S], radius=1*S, fill=(58, 52, 44))
    x += 20*S

img.save(os.path.join(OUT, "background@2x.png"))
img.resize((W // S, H // S), Image.LANCZOS).save(os.path.join(OUT, "background.png"))
print("wrote background.png (%dx%d) and background@2x.png (%dx%d)" % (W//S, H//S, W, H))
`;

const r = spawnSync('python3', ['-c', py], { encoding: 'utf8', stdio: 'inherit' });
if (r.status !== 0) process.exit(r.status || 1);

// macOS wants one multi-resolution TIFF for a HiDPI disk-image background
const tiff = spawnSync('tiffutil', ['-cathidpicheck',
  join(ROOT, 'build/background.png'), join(ROOT, 'build/background@2x.png'),
  '-out', join(ROOT, 'build/background.tiff')], { encoding: 'utf8' });
console.log(tiff.status === 0
  ? 'wrote background.tiff (1x + 2x)'
  : 'tiffutil failed, electron-builder will use the PNG:\n' + (tiff.stderr || ''));
