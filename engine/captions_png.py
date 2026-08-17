#!/usr/bin/env python3
"""video-style-match :: captions_png.py

Render word-by-word captions as transparent PNGs (one per cue) + an ffmpeg concat
file, for environments whose ffmpeg lacks libass/drawtext. Pillow only.

Two styles:
  --style highlight  (DEFAULT, coral/ink/bone system): rounded-sans, mixed case, white
      words with a CORAL highlight box + black text on the key word (MrBeast/editorial look).
  --style caps       : heavy Impact UPPERCASE, white + red emphasis word (older Sabri look).

Overlay with:
  ffmpeg -i graded.mp4 -f concat -safe 0 -i cap/concat.txt \
    -filter_complex "[1:v]fps=30,format=rgba,scale=1920:1080[c];[0:v][c]overlay=0:0:eof_action=pass[v]" \
    -map "[v]" -map 0:a -c:v h264_videotoolbox -b:v 14M -c:a copy final.mp4
"""
import argparse, json, os, sys
from PIL import Image, ImageDraw, ImageFont

STOP = {"the","a","an","and","or","but","of","to","in","on","for","is","it","i","you","that",
        "this","so","we","my","your","are","be","do","if","at","as","was","with","have","not","it's",
        "how","would","will","can","just","they","them","he","she","from","all","get","got","up","out"}
CORAL=(229,83,61,255); INK=(24,24,24,255); WHITE=(255,255,255,255); RED=(228,50,43,255)
ROUND="/System/Library/Fonts/Supplemental/Arial Rounded Bold.ttf"
IMPACT="/System/Library/Fonts/Supplemental/Impact.ttf"

def clean(t): return "".join(ch for ch in t.lower() if ch.isalnum() or ch in "'$%-.")

# ---------------------------------------------------------------- emoji
# Apple Color Emoji is a bitmap font: PIL will only open it at one of its strike sizes
# (137 on macOS), so emoji are drawn at that size into their own RGBA tile and scaled to
# the caption's line height. Everything else stays vector text.
EMOJI_FONT_PATHS = ["/System/Library/Fonts/Apple Color Emoji.ttc",
                    "/usr/share/fonts/truetype/noto/NotoColorEmoji.ttf",
                    "C:/Windows/Fonts/seguiemj.ttf"]
EMOJI_STRIKE = 137
_emoji_font = None
def emoji_font():
    global _emoji_font
    if _emoji_font is None:
        _emoji_font = False
        for p in EMOJI_FONT_PATHS:
            if os.path.exists(p):
                for size in (EMOJI_STRIKE, 109, 96, 64, 40, 32):
                    try: _emoji_font = ImageFont.truetype(p, size); break
                    except Exception: continue
                if _emoji_font: break
    return _emoji_font or None

def is_emoji(ch):
    o = ord(ch)
    return (0x1F000 <= o <= 0x1FAFF or 0x2600 <= o <= 0x27BF or 0x2B00 <= o <= 0x2BFF
            or 0xFE00 <= o <= 0xFE0F or 0x1F1E6 <= o <= 0x1F1FF or o == 0x200D or 0x2190 <= o <= 0x21FF)

def split_emoji(word):
    """['plain text', ('emoji','🔥'), …] preserving order, keeping ZWJ sequences together."""
    runs, buf, kind = [], "", None
    for ch in word:
        k = "emoji" if is_emoji(ch) else "text"
        if kind is None: kind = k
        if k != kind and not (k == "emoji" and kind == "emoji"):
            runs.append((kind, buf)); buf, kind = "", k
        buf += ch
    if buf: runs.append((kind, buf))
    # merge adjacent emoji runs (skin tones / ZWJ join into one glyph)
    merged = []
    for k, v in runs:
        if merged and merged[-1][0] == k == "emoji": merged[-1] = (k, merged[-1][1] + v)
        else: merged.append((k, v))
    return merged

def emoji_tile(seq, px):
    """Render an emoji sequence to an RGBA image `px` tall (None if unsupported)."""
    f = emoji_font()
    if not f: return None
    try:
        tile = Image.new("RGBA", (EMOJI_STRIKE * 2, EMOJI_STRIKE * 2), (0, 0, 0, 0))
        ImageDraw.Draw(tile).text((0, 0), seq, font=f, embedded_color=True)
        bbox = tile.getbbox()
        if not bbox: return None
        tile = tile.crop(bbox)
        scale = px / tile.height
        return tile.resize((max(1, int(tile.width * scale)), max(1, int(px))), Image.LANCZOS)
    except Exception:
        return None

def word_width(word, font, d):
    """Text width that accounts for emoji tiles (which are square-ish at line height)."""
    asc, desc = font.getmetrics(); lh = asc + desc
    w = 0
    for kind, run in split_emoji(word):
        if kind == "emoji":
            t = emoji_tile(run, int(lh * 0.86))
            w += (t.width + int(lh * 0.12)) if t else d.textlength(run, font=font)
        else:
            w += d.textlength(run, font=font)
    return w

def draw_word(img, d, xy, word, font, fill, stroke_width=0, stroke_fill=None):
    """Draw a word that may mix text and colour emoji. Returns the advance width."""
    x, y = xy
    asc, desc = font.getmetrics(); lh = asc + desc
    start = x
    for kind, run in split_emoji(word):
        if kind == "emoji":
            t = emoji_tile(run, int(lh * 0.86))
            if t is not None:
                img.alpha_composite(t, (int(x), int(y + lh * 0.10)))
                x += t.width + int(lh * 0.12)
                continue
            run = run  # fall through and let the text font try
        if stroke_width:
            d.text((x, y), run, font=font, fill=fill, stroke_width=stroke_width, stroke_fill=stroke_fill)
        else:
            d.text((x, y), run, font=font, fill=fill)
        x += d.textlength(run, font=font)
    return x - start

def load_words(path):
    raw = json.load(open(path))
    words = raw if isinstance(raw, list) else (raw.get("words") or raw.get("transcript") or [])
    out = []
    for w in words:
        t = str(w.get("text", w.get("word",""))).strip()
        s = w.get("start", w.get("from")); e = w.get("end", w.get("to"))
        if t and s is not None and e is not None:
            out.append({"text": t, "start": float(s), "end": float(e)})
    return out

def group_cues(words, per_cue):
    cues, cur = [], []
    for i, w in enumerate(words):
        cur.append(w)
        ends = any(p in w["text"] for p in ".!?")
        gap = (words[i+1]["start"] - w["end"]) if i+1 < len(words) else 999
        if len(cur) >= per_cue or ends or gap > 0.5:
            cues.append(cur); cur = []
    if cur: cues.append(cur)
    return cues

def emphasis_index(cue):
    idx, best = -1, 1
    for i, w in enumerate(cue):
        c = clean(w["text"])
        if c not in STOP and len(c) > best:
            best, idx = len(c), i
    return idx

def wrap(tokens, font, draw, max_w):
    lines, cur = [], []
    sp = draw.textlength(" ", font=font)
    def lw(ws): return sum(word_width(x[0], font, draw) for x in ws) + sp*(len(ws)-1 if ws else 0)
    for tk in tokens:
        if cur and lw(cur+[tk]) > max_w: lines.append(cur); cur=[tk]
        else: cur.append(tk)
    if cur: lines.append(cur)
    return lines

def render_highlight(tokens, W, H, font, cy, out, color=WHITE, highlight=CORAL, cx=None):
    """white words + coral highlight box (black text) on the emphasis word. mixed case.
       Per-cue editable: font size, cy (vertical pos), cx (horiz center), color, highlight."""
    img = Image.new("RGBA",(W,H),(0,0,0,0)); d = ImageDraw.Draw(img)
    CENTER = cx if cx is not None else W//2
    asc, desc = font.getmetrics(); lh = asc+desc
    sp = d.textlength(" ", font=font)
    pad_x = int(lh*0.16); pad_y = int(lh*0.06); rad = int(lh*0.30)
    lines = wrap(tokens, font, d, int(W*0.72))
    total_h = lh*len(lines) + int(lh*0.25)*(len(lines)-1)
    y = cy - total_h//2
    for ln in lines:
        lw = sum(word_width(w[0], font, d) for w in ln) + sp*(len(ln)-1)
        x = CENTER - lw/2
        for word, emph in ln:
            ww = word_width(word, font, d)
            if emph:
                d.rounded_rectangle([x-pad_x, y-pad_y, x+ww+pad_x, y+lh+pad_y], radius=rad, fill=highlight)
                draw_word(img, d, (x,y), word, font, INK)
            else:
                draw_word(img, d, (x+2,y+3), word, font, (0,0,0,150))   # soft shadow
                draw_word(img, d, (x,y), word, font, color,
                          stroke_width=max(2,int(lh*0.03)), stroke_fill=(0,0,0,200))
            x += ww + sp
        y += lh + int(lh*0.25)
    img.save(out)

def render_caps(tokens, W, H, font, cy, out):
    img = Image.new("RGBA",(W,H),(0,0,0,0)); d = ImageDraw.Draw(img)
    asc, desc = font.getmetrics(); lh = asc+desc
    sp = d.textlength(" ", font=font)
    toks=[(w.upper(), e) for w,e in tokens]
    lines = wrap(toks, font, d, int(W*0.9))
    total = lh*len(lines); y = cy - total//2
    for ln in lines:
        lw = sum(d.textlength(w[0], font=font) for w in ln)+sp*(len(ln)-1); x=(W-lw)/2
        for word, emph in ln:
            d.text((x,y), word, font=font, fill=(RED if emph else WHITE), stroke_width=int(lh*0.05), stroke_fill=(0,0,0,255))
            x += d.textlength(word,font=font)+sp
        y += lh

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--transcript", required=False)
    ap.add_argument("--outdir", required=True)
    ap.add_argument("--concat")
    ap.add_argument("--frame", default="1920x1080")
    ap.add_argument("--style", default="highlight", choices=["highlight","caps"])
    ap.add_argument("--font", default="")
    ap.add_argument("--fontsize", type=int, default=0)
    ap.add_argument("--cy", type=int, default=0, help="caption center Y (px)")
    ap.add_argument("--words-per-cue", type=int, default=3)
    ap.add_argument("--end", type=float, default=0.0)
    ap.add_argument("--max-seconds", type=float, default=0.0)
    ap.add_argument("--cues", help="resolved cue list json: [{start,end,tokens:[{t,e}],cy?,fontsize?,color?,highlight?,cx?}]")
    a = ap.parse_args()

    W,H = (int(x) for x in a.frame.lower().split("x"))
    def hexrgba(s,default):
        if not s: return default
        s=s.lstrip("#"); return (int(s[0:2],16),int(s[2:4],16),int(s[4:6],16),255)

    # ---- editable cue list (from project.json) ----
    if a.cues:
        cues_in=json.load(open(a.cues))
        os.makedirs(a.outdir, exist_ok=True)
        Image.new("RGBA",(W,H),(0,0,0,0)).save(os.path.join(a.outdir,"blank.png"))
        end=a.end or (cues_in[-1]["end"]+0.5 if cues_in else 0)
        entries=[]; cursor=0.0
        for n,c in enumerate(cues_in,1):
            fs=int(c.get("fontsize", a.fontsize or int(H*0.056)))
            cy=int(c.get("cy", a.cy or int(H*0.66)))
            cx=c.get("cx"); font=ImageFont.truetype(a.font or ROUND, max(1,fs))
            col=hexrgba(c.get("color"),WHITE); hl=hexrgba(c.get("highlight"),CORAL)
            toks=[(t["t"], bool(t.get("e"))) for t in c["tokens"]]
            png=os.path.join(a.outdir,f"cue_{n:04d}.png")
            render_highlight(toks,W,H,font,cy,png,color=col,highlight=hl,cx=cx)
            s,e=float(c["start"]),max(float(c["end"]),float(c["start"])+0.2)
            if s>cursor+0.02: entries.append(("blank.png",s-cursor))
            entries.append((f"cue_{n:04d}.png",max(0.2,e-s))); cursor=e
        if end>cursor: entries.append(("blank.png",end-cursor))
        if a.concat:
            with open(a.concat,"w") as f:
                for fn,dur in entries: f.write(f"file '{fn}'\nduration {dur:.3f}\n")
                if entries: f.write(f"file '{entries[-1][0]}'\n")
        print(json.dumps({"ok":True,"mode":"cues","cues":len(cues_in),"entries":len(entries),"end":round(end,2)}))
        return

    if a.style=="highlight":
        fp = a.font or ROUND; fs = a.fontsize or int(H*0.056); cy = a.cy or int(H*0.66)
    else:
        fp = a.font or IMPACT; fs = a.fontsize or int(H*0.075); cy = a.cy or int(H*0.80)
    font = ImageFont.truetype(fp, fs)

    words = load_words(a.transcript)
    if a.max_seconds: words = [w for w in words if w["start"] < a.max_seconds]
    if not words: sys.exit("no words")
    cues = group_cues(words, a.words_per_cue)
    os.makedirs(a.outdir, exist_ok=True)
    Image.new("RGBA",(W,H),(0,0,0,0)).save(os.path.join(a.outdir,"blank.png"))

    end = a.end or (words[-1]["end"]+0.5)
    entries=[]; cursor=0.0
    for n, cue in enumerate(cues,1):
        ei = emphasis_index(cue)
        toks = [(w["text"], i==ei) for i,w in enumerate(cue)]
        png = os.path.join(a.outdir, f"cue_{n:04d}.png")
        (render_highlight if a.style=="highlight" else render_caps)(toks, W, H, font, cy, png)
        s,e = cue[0]["start"], max(cue[-1]["end"], cue[0]["start"]+0.25)
        if s > cursor+0.02: entries.append(("blank.png", s-cursor))
        entries.append((f"cue_{n:04d}.png", max(0.2, e-s))); cursor=e
    if end>cursor: entries.append(("blank.png", end-cursor))

    if a.concat:
        with open(a.concat,"w") as f:
            for fn,dur in entries:
                f.write(f"file '{fn}'\nduration {dur:.3f}\n")
            f.write(f"file '{entries[-1][0]}'\n")
    print(json.dumps({"ok":True,"style":a.style,"cues":len(cues),"entries":len(entries),"end":round(end,2)}))

if __name__=="__main__": main()
