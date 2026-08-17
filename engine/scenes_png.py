#!/usr/bin/env python3
"""video-style-match :: scenes_png.py

Render SPLIT-SCREEN explainer scenes (coral/ink/bone design) as full-frame PNG
sequences: bone background, the talking-head video card on the RIGHT (a transparent
rounded 'hole' the compositor drops the video into), and animated graphics on the
LEFT — editorial serif headline + rounded-sans pills / checklists / counters / bars /
strike-through reveals. Pillow-only (no browser). Composite per scene with ffmpeg:

  ffmpeg -ss S -t D -i graded_master.mp4 -framerate 30 -i scene/f_%04d.png \
    -filter_complex "[0:v]crop=CW:CH:CX:0,scale=cardW:cardH,pad=1920:1080:cardX:cardY:color=0x000000[v];[v][1:v]overlay=0:0[o]" \
    -map "[o]" -map 0:a -c:v h264_videotoolbox -b:v 14M -pix_fmt yuv420p -c:a aac scene_clip.mp4

Card geometry is emitted in the manifest so the compositor uses matching crop/scale/pos.
"""
import argparse, json, math, os
from PIL import Image, ImageDraw, ImageFont, ImageFilter

BONE=(241,239,231,255); INK=(26,26,24,255); CORAL=(229,83,61,255)
LIME=(196,216,46,255); SKY=(111,183,232,255); WHITE=(255,255,255,255)
GHOST=(26,26,24,60); GREY=(26,26,24,120)
ROUND="/System/Library/Fonts/Supplemental/Arial Rounded Bold.ttf"
SERIF_TTC="/System/Library/Fonts/Supplemental/Bodoni 72.ttc"
GEO="/System/Library/Fonts/Supplemental/Georgia Bold.ttf"

# card on the right
CARD=dict(x=1212, y=132, w=596, h=816, r=40)

def ease(t): t=max(0,min(1,t)); return 1-(1-t)**3
def back(t):  # slight overshoot pop
    t=max(0,min(1,t)); c=1.7; return 1+ (c+1)*((t-1)**3) + c*((t-1)**2)

def serif(size):
    size=max(1,int(size))
    for idx in range(6):
        try:
            f=ImageFont.truetype(SERIF_TTC,size,index=idx)
            if "bold" in "".join(f.getname()).lower(): return f
        except Exception: pass
    try: return ImageFont.truetype(SERIF_TTC,size,index=1)
    except Exception: return ImageFont.truetype(GEO,size)
def sans(size): return ImageFont.truetype(ROUND,max(1,int(size)))

def COLREF(name):
    return {"coral":CORAL,"lime":LIME,"sky":SKY,"white":WHITE,"ink":INK,
            "ghost":GHOST,"grey":GREY}.get(name,WHITE)

def base_frame(W,H):
    """bone bg + soft card shadow + transparent rounded hole for the video card."""
    img=Image.new("RGBA",(W,H),BONE)
    # shadow
    sh=Image.new("RGBA",(W,H),(0,0,0,0)); sd=ImageDraw.Draw(sh)
    sd.rounded_rectangle([CARD["x"]-6,CARD["y"]+16,CARD["x"]+CARD["w"]+6,CARD["y"]+CARD["h"]+26],
                         radius=CARD["r"]+6, fill=(20,20,20,150))
    sh=sh.filter(ImageFilter.GaussianBlur(22)); img.alpha_composite(sh)
    # thin ink outline around card
    d=ImageDraw.Draw(img)
    d.rounded_rectangle([CARD["x"]-3,CARD["y"]-3,CARD["x"]+CARD["w"]+3,CARD["y"]+CARD["h"]+3],
                        radius=CARD["r"]+3, outline=(20,20,20,255), width=5)
    # punch transparent hole
    alpha=Image.new("L",(W,H),255); ad=ImageDraw.Draw(alpha)
    ad.rounded_rectangle([CARD["x"],CARD["y"],CARD["x"]+CARD["w"],CARD["y"]+CARD["h"]],radius=CARD["r"],fill=0)
    img.putalpha(Image.composite(Image.new("L",(W,H),0), img.getchannel("A"), Image.eval(alpha,lambda v:255-v)))
    return img

def draw_headline(d,W,H,text,pr):
    f=serif(int(H*0.082)); LX=int(W*0.05); maxw=int(W*0.55)
    # wrap
    words=text.split(); lines=[]; cur=""
    for w in words:
        t=(cur+" "+w).strip()
        if d.textlength(t,font=f)>maxw and cur: lines.append(cur); cur=w
        else: cur=t
    if cur: lines.append(cur)
    e=ease(min(1,pr/0.5)); off=int((1-e)*60); a=int(255*e)
    lh=int(H*0.092); y=int(H*0.13)-off
    for ln in lines:
        d.text((LX,y),ln,font=f,fill=(INK[0],INK[1],INK[2],a)); y+=lh

def pill(d,cx_left,y,w,h,text,fill,outline,tcol,alpha=255,scale=1.0):
    # rounded pill with heavy ink outline + subtle shadow (draw on a transparent layer)
    r=h//2
    x0=cx_left; x1=cx_left+w
    if fill:  # filled pills get a soft shadow
        d.rounded_rectangle([x0+4,y+7,x1+4,y+h+7],radius=r,fill=(20,20,20,int(60*alpha/255)))
    if fill:
        d.rounded_rectangle([x0,y,x1,y+h],radius=r,fill=(fill[0],fill[1],fill[2],alpha),
                            outline=(outline[0],outline[1],outline[2],alpha) if outline else None,width=5)
    else:     # ghost / outline-only pill (bone shows through)
        oc=outline or (INK[0],INK[1],INK[2],90)
        d.rounded_rectangle([x0,y,x1,y+h],radius=r,outline=(oc[0],oc[1],oc[2],min(alpha,oc[3] if len(oc)>3 else alpha)),width=5)
    f=sans(int(h*0.42)); tw=d.textlength(text,font=f)
    ta=alpha if fill else int(alpha*0.5)
    d.text((x0+(w-tw)/2, y+h*0.27), text, font=f, fill=(tcol[0],tcol[1],tcol[2],ta))

# ---------------- scene type renderers (draw LEFT graphics for progress pr) ----------------
def s_pills(d,W,H,p,pr):
    draw_headline(d,W,H,p["headline"],pr)
    items=p["items"]; LX=int(W*0.05); y0=int(H*0.42); h=int(H*0.088); gap=int(H*0.032)
    dur=p["_dur"]; t=pr*dur; stg=min(0.55,(dur*0.6)/max(1,len(items)))
    x=LX; y=y0; rowmax=int(W*0.56)
    for i,it in enumerate(items):
        f=sans(int(h*0.42)); tw=d.textlength(it["text"],font=f); w=int(tw+h*1.1)
        if x+w>LX+rowmax: x=LX; y+=h+gap
        ap=(t-i*stg)/0.3
        if ap>0:
            sc=back(min(1,ap)); a=int(255*min(1,ap))
            col=COLREF(it.get("color","white"))
            oc=INK if it.get("color","white") in ("white","coral","lime","sky") else (INK[0],INK[1],INK[2],120)
            fillcol=col if it.get("color","white")!="white" else WHITE
            if it.get("color")=="ghost": fillcol=None; oc=(INK[0],INK[1],INK[2],90)
            tcol=INK
            pill(d,x,y,w,h,it["text"],fillcol,oc,tcol,alpha=a)
        x+=w+int(W*0.02)

def s_checklist(d,W,H,p,pr):
    draw_headline(d,W,H,p["headline"],pr)
    items=p["items"]; neg=p.get("neg",False); LX=int(W*0.05); y0=int(H*0.42); lh=int(H*0.115)
    dur=p["_dur"]; t=pr*dur; stg=min(0.7,(dur*0.6)/max(1,len(items)))
    f=sans(int(H*0.05)); m=int(H*0.06); lw=int(H*0.011)
    for i,it in enumerate(items):
        ap=(t-i*stg)/0.3
        if ap<=0: continue
        a=int(255*min(1,ap)); e=ease(min(1,ap)); off=int((1-e)*40)
        y=y0+i*lh - off
        mc=CORAL if neg else (60,170,90,255)
        if neg:
            d.line([LX,y+m*0.15,LX+m*0.8,y+m*0.9],fill=(mc[0],mc[1],mc[2],a),width=lw)
            d.line([LX+m*0.8,y+m*0.15,LX,y+m*0.9],fill=(mc[0],mc[1],mc[2],a),width=lw)
        else:
            d.line([LX,y+m*0.55,LX+m*0.32,y+m*0.85],fill=(mc[0],mc[1],mc[2],a),width=lw)
            d.line([LX+m*0.32,y+m*0.85,LX+m*0.9,y+m*0.1],fill=(mc[0],mc[1],mc[2],a),width=lw)
        tx=LX+int(m*1.5)
        d.text((tx,y),it,font=f,fill=(INK[0],INK[1],INK[2],a))
        if neg:
            tl=d.textlength(it,font=f); d.line([tx,y+lh*0.28,tx+tl,y+lh*0.28],fill=(CORAL[0],CORAL[1],CORAL[2],a),width=int(H*0.007))

def s_counter(d,W,H,p,pr):
    draw_headline(d,W,H,p["headline"],pr)
    prefix=p.get("prefix",""); target=float(p["target"]); LX=int(W*0.05)
    cp=min(1,pr/0.55); val=target*ease(cp)
    num=f"{prefix}{int(round(val)):,}"
    f=serif(int(H*0.17)); y=int(H*0.46)
    d.text((LX,y),num,font=f,fill=INK)
    # growing coral bar under number
    bw=int(W*0.5*min(1,pr/0.6)); d.rounded_rectangle([LX,y+int(H*0.19),LX+bw,y+int(H*0.225)],radius=12,fill=CORAL)
    if p.get("sub"):
        fs=sans(int(H*0.038)); d.text((LX,y+int(H*0.25)),p["sub"],font=fs,fill=(INK[0],INK[1],INK[2],230))

def s_strike(d,W,H,p,pr):
    draw_headline(d,W,H,p["headline"],pr)
    LX=int(W*0.05); y=int(H*0.46); f=sans(int(H*0.07))
    old=p["old"]; new=p["new"]
    d.text((LX,y),old,font=f,fill=(INK[0],INK[1],INK[2],200))
    ow=d.textlength(old,font=f)
    sp=ease(min(1,pr/0.4)); d.line([LX,y+int(H*0.05),LX+int(ow*sp),y+int(H*0.05)],fill=CORAL,width=int(H*0.012))
    if pr>0.45:
        a=int(255*ease(min(1,(pr-0.45)/0.35))); y2=y+int(H*0.13)
        # drawn right-arrow (glyph-free)
        ay=y2+int(H*0.045); ax0=LX; ax1=LX+int(H*0.08); aw=int(H*0.010)
        d.line([ax0,ay,ax1,ay],fill=(CORAL[0],CORAL[1],CORAL[2],a),width=aw)
        d.line([ax1-int(H*0.02),ay-int(H*0.02),ax1,ay],fill=(CORAL[0],CORAL[1],CORAL[2],a),width=aw)
        d.line([ax1-int(H*0.02),ay+int(H*0.02),ax1,ay],fill=(CORAL[0],CORAL[1],CORAL[2],a),width=aw)
        pill(d,ax1+int(H*0.03),y2,int(d.textlength(new,font=f)+H*0.11),int(H*0.09),new,CORAL,INK,INK,alpha=a)

def s_stat(d,W,H,p,pr):
    draw_headline(d,W,H,p["headline"],pr)
    LX=int(W*0.05); a=int(255*ease(min(1,pr/0.4))); sc=max(0.15,min(1.04,back(min(1,pr/0.5))))
    maxw=int(W*0.56); base=int(H*0.20)
    while base>24 and d.textlength(p["big"],font=serif(base))>maxw: base=int(base*0.94)
    f=serif(int(base*sc)); d.text((LX,int(H*0.45)),p["big"],font=f,fill=(CORAL[0],CORAL[1],CORAL[2],a))
    if p.get("sub"):
        fs=sans(int(H*0.045)); d.text((LX,int(H*0.72)),p["sub"],font=fs,fill=(INK[0],INK[1],INK[2],a))

RENDER={"pills":s_pills,"checklist":s_checklist,"counter":s_counter,"strike":s_strike,"stat":s_stat}

def render_scene(sc,W,H,fps,outroot):
    sid=sc["id"]; dur=float(sc["dur"]); nf=max(1,int(round(dur*fps)))
    sc["_dur"]=dur
    d_out=os.path.join(outroot,sid); os.makedirs(d_out,exist_ok=True)
    bf=base_frame(W,H)
    for k in range(nf):
        pr=k/max(1,nf-1)
        gfx=Image.new("RGBA",(W,H),(0,0,0,0)); d=ImageDraw.Draw(gfx)
        RENDER[sc["type"]](d,W,H,sc,pr)   # graphics on a transparent layer → blends onto bone
        img=bf.copy(); img.alpha_composite(gfx)
        img.save(os.path.join(d_out,f"f_{k:04d}.png"))
    return {"id":sid,"start":float(sc["start"]),"dur":dur,"frames":nf,"dir":d_out,
            "card":CARD}

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--spec",required=True); ap.add_argument("--outroot",required=True)
    ap.add_argument("--frame",default="1920x1080"); ap.add_argument("--fps",type=int,default=30)
    ap.add_argument("--only")
    a=ap.parse_args()
    W,H=(int(x) for x in a.frame.lower().split("x"))
    spec=json.load(open(a.spec)); man=[]
    for sc in spec["scenes"]:
        if a.only and sc["id"]!=a.only: continue
        man.append(render_scene(sc,W,H,a.fps,a.outroot))
        print(f"[scene] {sc['id']} ({sc['type']}) {man[-1]['frames']}f @ {sc['start']}s")
    json.dump({"card":CARD,"scenes":man},open(os.path.join(a.outroot,"manifest.json"),"w"),indent=2)
    print(json.dumps({"ok":True,"count":len(man)}))

if __name__=="__main__": main()
