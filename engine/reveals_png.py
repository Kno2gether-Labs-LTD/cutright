#!/usr/bin/env python3
"""video-style-match :: reveals_png.py

Render Sabri-style progressive-reveal graphics as animated transparent PNG sequences
(full-frame RGBA, 30fps) for compositing over a video with ffmpeg `overlay`.
Deterministic, Pillow-only — no browser/HyperFrames needed (works with minimal ffmpeg).

Patterns: counter · cards (numbered) · checklist · callout · seesaw · punch

  python3 reveals_png.py --spec reveals.json --outroot reveals_frames --frame 1920x1080 --fps 30
    → reveals_frames/<id>/f_%04d.png  +  prints a JSON manifest {id,start,dur,frames,dir}

spec.json: { "reveals": [ {id,type,start,dur, ...type params...}, ... ] }
Composite each with:  -framerate 30 -itsoffset <start> -i <dir>/f_%04d.png  then chained
overlay=0:0:enable='between(t,start,start+dur)'.
"""
import argparse, json, math, os
from PIL import Image, ImageDraw, ImageFont

DISPLAY = "/System/Library/Fonts/Supplemental/Impact.ttf"
BODY    = "/System/Library/Fonts/Helvetica.ttc"
RED=(228,50,43,255); ORANGE=(255,106,0,255); WHITE=(255,255,255,255)
GREEN=(57,211,83,255); DARK=(17,17,17,255); CARD=(248,248,248,255)

def ease(t): t=max(0,min(1,t)); return 1-(1-t)**3          # ease-out cubic
def font(path,size):
    try: return ImageFont.truetype(path,size)
    except: return ImageFont.truetype(DISPLAY,size)

def text_center(d, cx, y, s, f, fill, stroke=6, anchor_mid=True):
    w = d.textlength(s, font=f)
    x = cx - w/2
    d.text((x,y), s, font=f, fill=fill, stroke_width=stroke, stroke_fill=(0,0,0,255))
    return w

def commafmt(n): return f"{int(round(n)):,}"

# ---------------- pattern renderers: draw one frame ----------------
def r_counter(d,W,H,p,pr):
    prefix=p.get("prefix",""); target=float(p.get("target",100000))
    # count during first 55% then hold + a pop
    cp=min(1, pr/0.55); val=target*ease(cp)
    num=f"{prefix}{commafmt(val)}"
    base=int(H*0.14); pop=1+0.12*max(0,1-abs(pr-0.55)/0.15) if pr>=0.4 else 1
    f=font(DISPLAY,int(base*pop))
    cy=int(H*0.30)
    # red underline accent grows with progress
    text_center(d,W//2,cy,num,f,WHITE,stroke=int(H*0.006))
    uw=min(1,pr/0.4)*W*0.22
    d.rounded_rectangle([W/2-uw, cy+base*1.02, W/2+uw, cy+base*1.02+int(H*0.012)],
                        radius=6, fill=RED)
    if p.get("sub"):
        fs=font(DISPLAY,int(H*0.045)); text_center(d,W//2,cy+int(base*1.25),p["sub"].upper(),fs,WHITE,stroke=4)

def r_punch(d,W,H,p,pr):
    bg=p.get("bg","#000000").lstrip("#")
    col=(int(bg[0:2],16),int(bg[2:4],16),int(bg[4:6],16),255)
    d.rectangle([0,0,W,H],fill=col)
    f=font(DISPLAY,int(H*0.16))
    lines=p["text"].upper().split("\n")
    total=len(lines)*int(H*0.17); y=(H-total)//2
    for ln in lines:
        text_center(d,W//2,y,ln,f,WHITE,stroke=int(H*0.007)); y+=int(H*0.17)

def r_cards(d,W,H,p,pr,dur):
    items=p["items"]; n=len(items)
    hdr=p.get("header","")
    stagger=min(1.4, (dur*0.6)/max(1,n))     # seconds between cards
    cw,ch=int(W*0.46),int(H*0.115); gap=int(H*0.02)
    x0=(W-cw)//2; y0=int(H*0.14)
    fh=font(DISPLAY,int(H*0.05)); ft=font(BODY,int(H*0.045)); fb=font(BODY,int(H*0.032)); fn=font(DISPLAY,int(H*0.05))
    if hdr: text_center(d,W//2,int(H*0.06),hdr.upper(),fh,WHITE,stroke=5)
    t=pr*dur
    for i,it in enumerate(items):
        ap=(t-i*stagger)/0.35
        if ap<=0: continue
        e=ease(min(1,ap)); off=int((1-e)*W*0.5)   # slide in from right
        alpha=int(255*min(1,ap))
        y=y0+i*(ch+gap)
        card=Image.new("RGBA",(cw+off if False else cw,ch),(0,0,0,0))
        cd=ImageDraw.Draw(card)
        cd.rounded_rectangle([0,0,cw-1,ch-1],radius=int(ch*0.18),fill=(CARD[0],CARD[1],CARD[2],alpha))
        # red number badge
        bs=int(ch*0.62); bx=int(ch*0.2); by=(ch-bs)//2
        cd.rounded_rectangle([bx,by,bx+bs,by+bs],radius=int(bs*0.28),fill=(RED[0],RED[1],RED[2],alpha))
        nw=cd.textlength(str(i+1),font=fn); cd.text((bx+(bs-nw)/2,by+bs*0.12),str(i+1),font=fn,fill=(255,255,255,alpha))
        tx=bx+bs+int(ch*0.25)
        cd.text((tx,ch*0.16),it["title"].upper(),font=ft,fill=(DARK[0],DARK[1],DARK[2],alpha))
        if it.get("sub"): cd.text((tx,ch*0.56),it["sub"],font=fb,fill=(90,90,90,alpha))
        d.im.paste(card, (x0+off, y), card) if hasattr(d,'im') else None
        # safe paste on the base image via alpha_composite handled by caller; fallback:
    return

def r_checklist(d,W,H,p,pr,dur,base_img):
    items=p["items"]; n=len(items); neg=p.get("style")=="negate"
    hdr=p.get("header",""); stagger=min(1.2,(dur*0.6)/max(1,n))
    fh=font(DISPLAY,int(H*0.055)); fi=font(DISPLAY,int(H*0.05))
    x=int(W*0.10); y0=int(H*0.24); lh=int(H*0.10)
    if hdr: d.text((x,int(H*0.12)),hdr.upper(),font=fh,fill=WHITE,stroke_width=5,stroke_fill=(0,0,0,255))
    t=pr*dur; m=int(H*0.05); lwd=int(H*0.009)
    for i,it in enumerate(items):
        ap=(t-i*stagger)/0.3
        if ap<=0: continue
        y=y0+i*lh; mc=RED if neg else GREEN
        cym=y+m*0.55
        if neg:  # draw an X
            d.line([x,y+m*0.1,x+m*0.8,y+m*0.9],fill=mc,width=lwd)
            d.line([x+m*0.8,y+m*0.1,x,y+m*0.9],fill=mc,width=lwd)
        else:    # draw a checkmark
            d.line([x,cym,x+m*0.32,y+m*0.85],fill=mc,width=lwd)
            d.line([x+m*0.32,y+m*0.85,x+m*0.9,y+m*0.05],fill=mc,width=lwd)
        tx=x+int(W*0.05)
        label=it if isinstance(it,str) else it.get("text","")
        d.text((tx,y),label.upper(),font=fi,fill=WHITE,stroke_width=4,stroke_fill=(0,0,0,255))
        if neg:  # strike-through
            lw=d.textlength(label.upper(),font=fi)
            d.line([tx,y+lh*0.32,tx+lw,y+lh*0.32],fill=RED,width=int(H*0.006))

def r_callout(d,W,H,p,pr,dur):
    hdr=p.get("header",""); rows=p["rows"]; n=len(rows)
    e=ease(min(1,pr/0.25)); off=int((1-e)*W*0.4)
    bx=int(W*0.60)+off; bw=int(W*0.36); by=int(H*0.22); bh=int(H*0.5)
    d.rounded_rectangle([bx,by,bx+bw,by+bh],radius=int(H*0.02),
                        fill=(10,10,10,int(220*min(1,pr/0.25))), outline=RED, width=int(H*0.006))
    fh=font(DISPLAY,int(H*0.045)); fr=font(DISPLAY,int(H*0.04))
    d.text((bx+int(bw*0.08),by+int(bh*0.06)),hdr.upper(),font=fh,fill=RED,stroke_width=3,stroke_fill=(0,0,0,255))
    stagger=min(1.0,(dur*0.6)/max(1,n)); t=pr*dur
    for i,row in enumerate(rows):
        if (t-0.4-i*stagger)<=0: continue
        ry=by+int(bh*0.28)+i*int(bh*0.22)
        d.text((bx+int(bw*0.08),ry),row.upper(),font=fr,fill=WHITE,stroke_width=3,stroke_fill=(0,0,0,255))

def r_seesaw(d,W,H,p,pr):
    cx,cy=W//2,int(H*0.5); beam=int(W*0.30)
    # locked deadlock: small oscillation
    ang=math.radians(7*math.sin(pr*math.pi*3))
    dx,dy=math.cos(ang)*beam, math.sin(ang)*beam
    # fulcrum
    d.polygon([(cx-40,cy+70),(cx+40,cy+70),(cx,cy)],fill=WHITE)
    d.line([cx-dx,cy-dy,cx+dx,cy+dy],fill=WHITE,width=int(H*0.012))
    f=font(DISPLAY,int(H*0.05))
    for sign,label in ((-1,p.get("left","")),(1,p.get("right",""))):
        ex,ey=cx+sign*dx, cy+sign*dy
        d.ellipse([ex-14,ey-14,ex+14,ey+14],fill=RED)
        text_center(d,int(cx+sign*beam*1.0),int(cy-dy*sign)- (int(H*0.12) if sign<0 else -int(H*0.06)),label.upper(),f,WHITE,stroke=5)

# ---------------- driver ----------------
def render_reveal(rev,W,H,fps,outroot):
    rid=rev["id"]; dur=float(rev["dur"]); nf=max(1,int(round(dur*fps)))
    d_out=os.path.join(outroot,rid); os.makedirs(d_out,exist_ok=True)
    for k in range(nf):
        pr=k/max(1,nf-1)
        img=Image.new("RGBA",(W,H),(0,0,0,0)); dr=ImageDraw.Draw(img)
        typ=rev["type"]
        if typ=="counter": r_counter(dr,W,H,rev,pr)
        elif typ=="punch": r_punch(dr,W,H,rev,pr)
        elif typ=="cards":
            # cards need per-card alpha compositing → render onto img via helper that pastes
            _cards_composite(img,W,H,rev,pr,dur)
        elif typ=="checklist": r_checklist(dr,W,H,rev,pr,dur,img)
        elif typ=="callout": r_callout(dr,W,H,rev,pr,dur)
        elif typ=="seesaw": r_seesaw(dr,W,H,rev,pr)
        img.save(os.path.join(d_out,f"f_{k:04d}.png"))
    return {"id":rid,"start":float(rev["start"]),"dur":dur,"frames":nf,"dir":d_out}

def _cards_composite(base,W,H,p,pr,dur):
    items=p["items"]; n=len(items); hdr=p.get("header","")
    d=ImageDraw.Draw(base)
    fh=font(DISPLAY,int(H*0.05))
    if hdr: text_center(d,W//2,int(H*0.06),hdr.upper(),fh,WHITE,stroke=5)
    cw,ch=int(W*0.46),int(H*0.115); gap=int(H*0.02); x0=(W-cw)//2; y0=int(H*0.15)
    ft=font(BODY,int(H*0.042)); fb=font(BODY,int(H*0.030)); fn=font(DISPLAY,int(H*0.05))
    stagger=min(1.4,(dur*0.6)/max(1,n)); t=pr*dur
    for i,it in enumerate(items):
        ap=(t-i*stagger)/0.35
        if ap<=0: continue
        e=ease(min(1,ap)); off=int((1-e)*W*0.5); alpha=int(255*min(1,ap))
        y=y0+i*(ch+gap)
        card=Image.new("RGBA",(cw,ch),(0,0,0,0)); cd=ImageDraw.Draw(card)
        cd.rounded_rectangle([0,0,cw-1,ch-1],radius=int(ch*0.18),fill=(CARD[0],CARD[1],CARD[2],alpha))
        bs=int(ch*0.62); bx=int(ch*0.2); by=(ch-bs)//2
        cd.rounded_rectangle([bx,by,bx+bs,by+bs],radius=int(bs*0.28),fill=(RED[0],RED[1],RED[2],alpha))
        nw=cd.textlength(str(i+1),font=fn); cd.text((bx+(bs-nw)/2,by+bs*0.10),str(i+1),font=fn,fill=(255,255,255,alpha))
        tx=bx+bs+int(ch*0.25)
        cd.text((tx,ch*0.14),it["title"].upper(),font=ft,fill=(DARK[0],DARK[1],DARK[2],alpha))
        if it.get("sub"): cd.text((tx,ch*0.58),it["sub"],font=fb,fill=(90,90,90,alpha))
        base.alpha_composite(card,(x0+off,y))

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--spec",required=True); ap.add_argument("--outroot",required=True)
    ap.add_argument("--frame",default="1920x1080"); ap.add_argument("--fps",type=int,default=30)
    a=ap.parse_args()
    W,H=(int(x) for x in a.frame.lower().split("x"))
    spec=json.load(open(a.spec)); man=[]
    for rev in spec["reveals"]:
        man.append(render_reveal(rev,W,H,a.fps,a.outroot))
        print(f"[reveal] {rev['id']} ({rev['type']}) {man[-1]['frames']}f @ {rev['start']}s")
    json.dump(man,open(os.path.join(a.outroot,"manifest.json"),"w"),indent=2)
    print(json.dumps({"ok":True,"count":len(man)}))

if __name__=="__main__": main()
