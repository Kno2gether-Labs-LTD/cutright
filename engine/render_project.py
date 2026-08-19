#!/usr/bin/env python3
"""render_project.py — render the final video FROM project.json (edit-as-data).

  python3 render_project.py --project project.json --out FINAL.mp4          # full (applies cuts)
  python3 render_project.py --project project.json --range 190 210 --out preview.mp4

Honors: CUTS (removed ranges → video spliced + captions/scenes/audio re-timed),
caption cues (+per-cue cy/fontsize/color/highlight), split-screen scenes, and audio
layers (voice + music[] + sfx[] mixed + loudnorm). Preview (--range) renders on the
ORIGINAL timeline (cuts not applied) for quick spot checks. Deterministic; re-run safe.
"""
import argparse, json, os, subprocess, sys, tempfile, shutil

# Only used when a project has cues but no font of its own — the packs all set one.
DEFAULT_FONT="/System/Library/Fonts/Supplemental/Arial Rounded Bold.ttf"
# Renderers live next to this file when bundled with the app; fall back to the
# video-style-match skill so the same script still works standalone from the skill.
SKILL=os.path.dirname(os.path.abspath(__file__))
if not os.path.exists(os.path.join(SKILL,"captions_png.py")):
    SKILL=os.path.expanduser("~/.claude/skills/video-style-match/scripts")

def run(a,log=None):
    r=subprocess.run(a,stdout=(open(log,"wb") if log else subprocess.PIPE),
                     stderr=subprocess.STDOUT,text=(log is None))
    if r.returncode!=0:
        sys.exit(f"CMD FAILED: {' '.join(str(x) for x in a[:6])}…\n{(r.stdout or '')[-1200:] if log is None else open(log).read()[-1200:]}")
    return r.stdout

def keep_segments(cuts,dur):
    cuts=sorted([(max(0,float(c['start'])),min(dur,float(c['end']))) for c in cuts if float(c['end'])>float(c['start'])])
    segs=[]; cur=0.0
    for a,b in cuts:
        if a>cur: segs.append((cur,a))
        cur=max(cur,b)
    if cur<dur: segs.append((cur,dur))
    return segs,cuts

def make_remap(cuts,xfades=None):
    """original t -> new t. Subtracts removed time before t, plus any transition overlap
    (an xfade of D seconds at a seam pulls everything after it D earlier)."""
    cuts=sorted(cuts); xf=xfades or {}
    def remap(t):
        removed=0.0
        for a,b in cuts:
            if t>=b: removed+=(b-a)+xf.get((a,b),0.0)
            elif t>a: removed+=(t-a)  # inside cut → clamps to a
        return t-removed
    def in_cut(t):
        return any(a<=t<b for a,b in cuts)
    return remap,in_cut

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--project",required=True); ap.add_argument("--out",default="FINAL.mp4")
    ap.add_argument("--range",nargs=2,type=float); ap.add_argument("--tmp",default="")
    a=ap.parse_args()
    P=json.load(open(a.project)); W=os.path.dirname(os.path.abspath(a.project))
    m=P["meta"]; VW,VH,FPS,DUR=m["width"],m["height"],m["fps"],m["duration"]
    graded=os.path.join(W,m["graded"])
    T=a.tmp or tempfile.mkdtemp(prefix="rp_",dir=W); os.makedirs(T,exist_ok=True)
    HW=["-c:v","h264_videotoolbox","-b:v","14M","-profile:v","high","-pix_fmt","yuv420p","-tag:v","avc1"]
    d=P["captions"]["defaults"]
    def hxa(s): return s

    # ---------- LOOK: render-time film grade (does not touch graded_master) ----------
    # project.grade.look = {"preset":"film","grain":6,"vignette":0.3,"filter":"<extra>"}
    LOOKS={
      "none":"",
      "film":"curves=preset=medium_contrast,eq=saturation=0.94:gamma=1.02",
      "warm":"eq=saturation=1.05:gamma=1.02,colorbalance=rm=0.05:bm=-0.04",
      "cool":"eq=saturation=0.98,colorbalance=rm=-0.05:bm=0.06",
      "teal-orange":"colorbalance=rs=0.06:bs=-0.04:rh=-0.05:bh=0.08,eq=saturation=1.06",
      "bleach":"eq=saturation=0.55:contrast=1.18",
      "noir":"hue=s=0,curves=preset=strong_contrast",
      "vhs":"eq=saturation=1.15:contrast=0.94,noise=alls=14:allf=t,gblur=sigma=0.35",
    }
    def look_chain():
        L=(P.get("grade") or {}).get("look") or {}
        if isinstance(L,str): L={"preset":L}
        parts=[]
        base=LOOKS.get(str(L.get("preset","none")).lower(),"")
        if base: parts.append(base)
        g=float(L.get("grain",0) or 0)
        if g>0: parts.append(f"noise=alls={int(max(1,min(40,g)))}:allf=t+u")
        v=float(L.get("vignette",0) or 0)
        if v>0: parts.append(f"vignette=angle=PI/{max(2.0,6.0-4.0*min(1.0,v)):.2f}")
        b=float(L.get("bloom",0) or 0)
        if b>0: parts.append(f"gblur=sigma={0.4+1.6*min(1.0,b):.2f}:steps=1")
        extra=str(L.get("filter","") or "").strip()
        if extra: parts.append(extra)
        return ",".join(parts)
    LOOK=look_chain()

    # ---------- 0. CUTS → working video + remap (full render only) ----------
    cuts=P.get("cuts",[]) if not a.range else []
    remap=lambda t:t; in_cut=lambda t:False; workDur=DUR; src=graded
    if cuts:
        # A cut may ask for a TRANSITION at its seam: {"start":..,"end":..,"transition":"fade",
        # "tdur":0.3}. xfade blends the two segments, which also shortens the result by tdur —
        # remap() accounts for that so captions/scenes/overlays stay in sync.
        XF={"crossfade":"fade","fade":"fade","dip":"fadeblack","dipwhite":"fadewhite",
            "whip":"slideleft","slide":"slideleft","wiperight":"wiperight","circle":"circleopen",
            "smooth":"smoothleft","pixel":"pixelize"}
        segs,cutpairs=keep_segments(cuts,DUR)
        # map each kept seam (the boundary between segment i and i+1) to its transition
        xf_by_pair={}
        for c in cuts:
            tname=str(c.get("transition","") or "").lower()
            if tname in ("","none","hard"): continue
            xf_by_pair[(max(0.0,float(c["start"])),min(DUR,float(c["end"])))]=float(c.get("tdur",0.3))
        remap,in_cut=make_remap(cutpairs,xf_by_pair)
        parts=[]
        for i,(s0,e0) in enumerate(segs):
            seg=os.path.join(T,f"seg_{i:03d}.mp4")
            run(["ffmpeg","-hide_banner","-y","-ss",str(s0),"-to",str(e0),"-i",graded,*HW,
                 "-r",str(FPS),"-c:a","aac","-b:a","192k","-ar","48000","-ac","2",seg],log=os.path.join(T,f"seg_{i}.log"))
            parts.append(seg)
        src=os.path.join(T,"graded_cut.mp4")
        seam_x=[]   # transition duration + ffmpeg name for the seam after segment i
        for i in range(len(segs)-1):
            gap_start,gap_end=segs[i][1],segs[i+1][0]
            xdur=xf_by_pair.get((round(gap_start,6),round(gap_end,6)))
            if xdur is None:
                for (ca,cb),dd in xf_by_pair.items():
                    if abs(ca-gap_start)<0.05 and abs(cb-gap_end)<0.05: xdur=dd; break
            if xdur:
                tname=next((c.get("transition","fade") for c in cuts
                            if abs(float(c["start"])-gap_start)<0.05), "fade")
                seam_x.append((xdur,XF.get(str(tname).lower(),"fade")))
            else: seam_x.append(None)

        if any(seam_x):
            # xfade chain: every transition costs `d` seconds of overlap
            args=["ffmpeg","-hide_banner","-y"]
            for pth in parts: args+=["-i",pth]
            durs=[e0-s0 for s0,e0 in segs]
            fc=[]; vprev="[0:v]"; aprev="[0:a]"; off=0.0
            for i in range(1,len(parts)):
                x=seam_x[i-1]; xdur,tname=(x if x else (0.0,"fade"))
                off+=durs[i-1]-(xdur if x else 0.0)
                vout=f"[vx{i}]"; aout=f"[ax{i}]"
                if x:
                    fc.append(f"{vprev}[{i}:v]xfade=transition={tname}:duration={xdur}:offset={off:.3f}{vout}")
                    fc.append(f"{aprev}[{i}:a]acrossfade=d={xdur}:c1=tri:c2=tri{aout}")
                else:
                    fc.append(f"{vprev}[{i}:v]xfade=transition=fade:duration=0.001:offset={off:.3f}{vout}")
                    fc.append(f"{aprev}[{i}:a]acrossfade=d=0.001{aout}")
                vprev,aprev=vout,aout
            args+=["-filter_complex",";".join(fc),"-map",vprev,"-map",aprev,*HW,
                   "-c:a","aac","-b:a","192k","-movflags","+faststart",src]
            run(args,log=os.path.join(T,"cut_xfade.log"))
            workDur=sum(durs)-sum(xd for xd,_ in [x for x in seam_x if x])
        else:
            lst=os.path.join(T,"segs.txt"); open(lst,"w").write("".join(f"file '{p}'\n" for p in parts))
            run(["ffmpeg","-hide_banner","-y","-f","concat","-safe","0","-i",lst,"-c","copy","-movflags","+faststart",src],log=os.path.join(T,"cut_concat.log"))
            workDur=sum(e-s for s,e in segs)

    A,B=(a.range if a.range else [0.0,workDur]); span=B-A
    # A and B stay on the ORIGINAL timeline for the whole render, because every element's times
    # are on that timeline and get mapped with `- A`. What changes is whether the video handed to
    # the next stage has already been trimmed to the range; that is this flag, and only it.
    # (Resetting A,B to 0,span instead — which is what the zoom pass used to do — silently dropped
    # every caption and scene from any ranged preview that also had a zoom in it.)
    trimmed=False
    def vin_for(path): return ["-i",path] if (trimmed or not a.range) else ["-ss",str(A),"-t",str(span),"-i",path]

    # ---------- 0b. ZOOMS (animated punch-in, applied before anything is drawn on top) ----------
    # zooms[] = [{start,dur,x,y,scale,ease}] with x/y NORMALISED 0..1 so they survive a
    # resolution change. crop cannot animate w/h (evaluated once), so this uses zoompan,
    # whose z/x/y are per-frame expressions. Captions and scenes are composited afterwards
    # so they stay sharp and unzoomed.
    zooms=[]
    for z in P.get("zooms",[]):
        if z.get("enabled") is False: continue
        zs=float(z.get("start",0)); zd=float(z.get("dur",0) or 0)
        if zd<=0: continue
        if cuts and (in_cut(zs) or in_cut(zs+zd)): continue
        ns=remap(zs)
        if ns+zd<=A or ns>=B: continue
        zooms.append({**z,"_ns":ns-A,"_dur":zd,
                      "_x":min(1.0,max(0.0,float(z.get("x",0.5)))),
                      "_y":min(1.0,max(0.0,float(z.get("y",0.5)))),
                      "_s":min(4.0,max(1.0,float(z.get("scale",1.8))))})
    if zooms:
        # zoompan's expression context is NOT the usual filter one: there is no `t` and no
        # `between()`. It exposes `time` and the basic comparators, so build a nested if-chain
        # over `time` with gte/lte. Outside every zoom window the expression is 1, i.e. the
        # untouched picture.
        RAMP=0.5   # ease in/out, seconds
        zooms.sort(key=lambda z: z["_ns"])
        zexpr="1"; cxexpr="0.5"; cyexpr="0.5"
        for z in reversed(zooms):
            s0=z["_ns"]; s1=s0+z["_dur"]; sc=z["_s"]
            e0=s0+RAMP; e1=max(e0, s1-RAMP)
            cond=f"gte(time,{s0:.3f})*lte(time,{s1:.3f})"
            ramp=(f"if(lt(time,{e0:.3f}),1+({sc-1:.4f})*(time-{s0:.3f})/{RAMP},"
                  f"if(gt(time,{e1:.3f}),1+({sc-1:.4f})*({s1:.3f}-time)/{RAMP},{sc:.4f}))")
            zexpr=f"if({cond},{ramp},{zexpr})"
            cxexpr=f"if({cond},{z['_x']:.4f},{cxexpr})"
            cyexpr=f"if({cond},{z['_y']:.4f},{cyexpr})"
        zoomed=os.path.join(T,"zoomed.mp4")
        vin_z=vin_for(src)
        run(["ffmpeg","-hide_banner","-y",*vin_z,
             "-vf",(f"zoompan=z='{zexpr}':x='(iw-iw/zoom)*({cxexpr})':y='(ih-ih/zoom)*({cyexpr})'"
                    f":d=1:s={VW}x{VH}:fps={FPS}"),
             *HW,"-movflags","+faststart","-c:a","copy",zoomed],log=os.path.join(T,"zoom.log"))
        src=zoomed; trimmed=trimmed or bool(a.range)


    # ---------- 0c. FRAMING (the picture moves and changes shape: full ⇄ side ⇄ corner) ----------
    # frames[] = [{start, dur, to:"full"|"side"|"corner", shape, size, corner, side, margin,
    #              radius, backdrop, ease}]. Sizes and margins are fractions of the frame WIDTH,
    # so a project survives a change of resolution.
    #
    # Two halves. ffmpeg moves and scales the picture, because scale and overlay both evaluate
    # their expressions per frame. It cannot animate the SHAPE of the visible area — a rectangle
    # rounding into a circle — and geq, which can express it, needs minutes per second of 1080p
    # (measured). So the mask is drawn with Pillow for the frames of each move and held as a
    # still in between, then applied with alphamerge.
    # A scene leaves a portrait card empty on the right for the picture. That used to be a hard
    # cut: one frame full-screen, the next in the card. Unless a scene asks for "enter":"cut",
    # the picture now glides in and back out, which is what the layout always wanted.
    SLIDE=0.55
    frames=[]
    for sc in P.get("scenes",[]):
        if sc.get("enter")=="cut": continue
        st=float(sc["start"]); en=st+float(sc["dur"])
        if cuts and (in_cut(st) or in_cut(en)): continue
        ns=remap(st)
        if ns+float(sc["dur"])<=A or ns>=B: continue
        frames.append({"id":f"_scene_in_{sc.get('id','')}","start":st-SLIDE,"dur":SLIDE,"to":"card",
                       "_ns":max(0.0,ns-A-SLIDE),"_dur":SLIDE,"_implicit":True})
        frames.append({"id":f"_scene_out_{sc.get('id','')}","start":en,"dur":SLIDE,"to":"full",
                       "_ns":max(0.0,remap(en)-A),"_dur":SLIDE,"_implicit":True})
    for f in P.get("frames",[]):
        if f.get("enabled") is False: continue
        fs=float(f.get("start",0)); fd=float(f.get("dur",0.8) or 0.8)
        if cuts and in_cut(fs): continue
        ns=remap(fs)
        if ns>=B: continue
        frames.append({**f,"_ns":max(0.0,ns-A),"_dur":max(0.05,fd)})
    frames.sort(key=lambda f: f["_ns"])
    if frames:
        sys.path.insert(0,os.path.dirname(os.path.abspath(__file__)))
        import frames_png as FP
        fdir=os.path.join(T,"frames"); os.makedirs(fdir,exist_ok=True)

        # --- the picture's geometry over time: a chain of holds, latest wins
        start_state={"to":"full"}
        states=[start_state]+[f for f in frames]
        def geom(st): return FP.state_geometry(st,VW,VH)
        def ease_expr(f):
            p=f"clip((t-{f['_ns']:.3f})/{f['_dur']:.3f},0,1)"
            k=f.get("ease","inout")
            if k=="linear": return p
            if k=="out":    return f"(1-pow(1-{p},3))"
            if k=="in":     return f"pow({p},3)"
            return f"(0.5-0.5*cos(PI*{p}))"
        def track(key):
            expr=f"{geom(start_state)[key]:.3f}"
            prev=geom(start_state)[key]
            for f in frames:
                tgt=geom(f)[key]
                expr=f"if(gte(t,{f['_ns']:.3f}),({prev:.3f}+({tgt-prev:.3f})*{ease_expr(f)}),{expr})"
                prev=tgt
            return expr
        ph=track("ph"); cx=track("cx"); cy=track("cy")
        pw=f"({ph})*{VW}/{VH}"

        # --- the mask: drawn frames for each move, stills for the holds, concatenated
        segs=[]; prev=start_state; cursor=0.0
        still0=os.path.join(fdir,"still_start.png"); FP.write_still(still0,start_state,VW,VH)
        for i,f in enumerate(frames):
            hold=f["_ns"]-cursor
            if hold>0.001:
                segs.append(("still",os.path.join(fdir,f"still_{i}.png"),hold))
                FP.write_still(segs[-1][1],prev,VW,VH)
            n=FP.write_transition(fdir,f"t{i}_",prev,f,f["_dur"],FPS,VW,VH,f.get("ease","inout"))
            segs.append(("seq",os.path.join(fdir,f"t{i}_%05d.png"),n/float(FPS)))
            cursor=f["_ns"]+f["_dur"]; prev=f
        tail=max(0.05,span-cursor)
        segs.append(("still",os.path.join(fdir,"still_end.png"),tail))
        FP.write_still(segs[-1][1],prev,VW,VH)

        mins=[]; mfilt=[]
        for i,(kind,path,secs) in enumerate(segs):
            if kind=="still": mins+= ["-loop","1","-t",f"{secs:.3f}","-r",str(FPS),"-i",path]
            else:             mins+= ["-framerate",str(FPS),"-i",path]
            mfilt.append(f"[{i}:v]format=gray,fps={FPS}[m{i}];")
        maskmov=os.path.join(fdir,"mask.mkv")
        run(["ffmpeg","-hide_banner","-y",*mins,"-filter_complex",
             "".join(mfilt)+"".join(f"[m{i}]" for i in range(len(segs)))+f"concat=n={len(segs)}:v=1:a=0[m]",
             "-map","[m]","-c:v","ffv1","-pix_fmt","gray",maskmov],log=os.path.join(T,"frames_mask.log"))

        # --- the backdrop the picture sits on
        # One backdrop for the whole render: switching it mid-clip would mean switching video
        # streams mid-graph. An explicit framing move decides it; when every move came from a
        # scene sliding into its card, the picture's own blurred frame is the quiet choice.
        explicit=[f for f in frames if not f.get("_implicit") and f.get("to")!="full"]
        bd=str((explicit[0] if explicit else {}).get("backdrop","blur" if not explicit else "brand"))
        vin_f=vin_for(src)
        if bd=="blur":
            bg_filter=f"[0:v]scale={VW//4}:{VH//4},boxblur=12:2,scale={VW}:{VH},eq=brightness=-0.12[bg];"
            bg_inputs=[]
        else:
            bgpng=os.path.join(fdir,"backdrop.png")
            spec=explicit[0] if explicit else {}
            if bd.startswith("#"):
                FP.write_backdrop(bgpng,VW,VH,base=bd,glow1=bd,glow2=bd,strength=0.0)
            else:
                FP.write_backdrop(bgpng,VW,VH,
                                  base=spec.get("backdropBase","#0a0a09"),
                                  glow1=spec.get("backdropGlow","#f3b04a"),
                                  glow2=spec.get("backdropGlow2","#a86cf7"))
            bg_inputs=["-loop","1","-i",bgpng]
            bg_filter=f"[3:v]scale={VW}:{VH},fps={FPS}[bg];"

        framed=os.path.join(T,"framed.mp4")
        run(["ffmpeg","-hide_banner","-y",*vin_f,
             "-f","lavfi","-i",f"color=c=black@0.0:s={VW}x{VH}:r={FPS},format=rgba",
             "-i",maskmov,*bg_inputs,
             "-filter_complex",
             (bg_filter
              +f"[0:v]scale=w='{pw}':h='{ph}':eval=frame[pic];"
              +f"[1:v][pic]overlay=x='({cx})-w/2':y='({cy})-h/2':eval=frame:shortest=1,format=rgba[canvas];"
              +f"[canvas][2:v]alphamerge[shaped];"
              +f"[bg][shaped]overlay=0:0:shortest=1,format=yuv420p[v]"),
             "-map","[v]","-map","0:a?",*HW,"-c:a","copy","-movflags","+faststart",framed],
            log=os.path.join(T,"frames.log"))
        src=framed; trimmed=trimmed or bool(a.range)

    # ---------- 1. captions (resolve overrides, drop inside-cut, remap) ----------
    cues=[]
    for c in P["captions"]["cues"]:
        s,e=float(c["start"]),float(c["end"])
        if cuts and (in_cut(s) or in_cut(e)): continue
        s,e=remap(s),remap(e)
        if e<=A or s>=B: continue
        o=c.get("overrides",{})
        cues.append({"start":round(s-A,3),"end":round(min(e,B)-A,3),"tokens":c["tokens"],
                     "fontsize":int(o.get("fontsize",d["fontsize"])),"cy":int(o.get("cy",d["cy"])),
                     "color":o.get("color",d["color"]),"highlight":o.get("highlight",d["highlight"]),
                     **({"cx":o["cx"]} if "cx" in o else {})})
    base=os.path.join(T,"base.mp4")
    vin=vin_for(src)
    vpre=f"[0:v]{LOOK}[g];" if LOOK else ""
    vsrc="[g]" if LOOK else "[0:v]"
    if cues:
        capdir=os.path.join(T,"cap"); os.makedirs(capdir,exist_ok=True)
        json.dump(cues,open(os.path.join(T,"cues.json"),"w"))
        run(["python3",f"{SKILL}/captions_png.py","--cues",os.path.join(T,"cues.json"),"--outdir",capdir,
             "--concat",os.path.join(capdir,"concat.txt"),"--frame",f"{VW}x{VH}",
             "--font",d.get("font",DEFAULT_FONT),"--end",str(span)])
        run(["ffmpeg","-hide_banner","-y",*vin,"-f","concat","-safe","0","-i",os.path.join(capdir,"concat.txt"),
             "-filter_complex",f"{vpre}[1:v]fps={FPS},format=rgba,scale={VW}:{VH}[c];{vsrc}[c]overlay=0:0:eof_action=pass[v]",
             "-map","[v]","-map","0:a",*HW,"-movflags","+faststart","-c:a","copy",base],log=os.path.join(T,"base.log"))
    else:
        # No captions in range — a screen recording being framed, say. Rendering a full clip of
        # transparent PNGs to composite nothing was both slow and a crash waiting to happen (it
        # needed a caption font the project had no reason to carry).
        if LOOK:
            run(["ffmpeg","-hide_banner","-y",*vin,"-filter_complex",f"{vpre}{vsrc}null[v]",
                 "-map","[v]","-map","0:a",*HW,"-movflags","+faststart","-c:a","copy",base],
                log=os.path.join(T,"base.log"))
        else:
            run(["ffmpeg","-hide_banner","-y",*vin,"-map","0:v","-map","0:a",*HW,
                 "-movflags","+faststart","-c:a","copy",base],log=os.path.join(T,"base.log"))

    # ---------- 2. scenes (drop if straddles a cut; remap start) ----------
    scenes=[]
    for s in P.get("scenes",[]):
        st,en=s["start"],s["start"]+s["dur"]
        if cuts and (in_cut(st) or in_cut(en) or any(st<ca and en>cb for ca,cb in [(c['start'],c['end']) for c in cuts])): continue
        ns=remap(st)
        if ns+s["dur"]<=A or ns>=B: continue
        scenes.append({**s,"_ns":ns})
    cur=base
    if scenes:
        spec={"scenes":[{k:v for k,v in s.items() if k!="_ns"} for s in scenes]}
        json.dump(spec,open(os.path.join(T,"scenes.json"),"w"))
        run(["python3",f"{SKILL}/scenes_png.py","--spec",os.path.join(T,"scenes.json"),
             "--outroot",os.path.join(T,"sf"),"--frame",f"{VW}x{VH}","--fps",str(FPS)])
        man=json.load(open(os.path.join(T,"sf","manifest.json")))["card"]
        cx,cy,cw,ch=man["x"],man["y"],man["w"],man["h"]; crw=round(1080*cw/ch); crx=(1920-crw)//2
        clips=[]
        for s in scenes:
            clip=os.path.join(T,f"clip_{s['id']}.mp4")
            if s.get("enter")=="cut":
                # the original behaviour: the picture is cropped into the card inside the clip
                run(["ffmpeg","-hide_banner","-y","-ss",str(s["start"]),"-t",str(s["dur"]),"-i",graded,
                     "-framerate",str(FPS),"-i",os.path.join(T,"sf",s["id"],"f_%04d.png"),
                     "-filter_complex",f"[0:v]crop={crw}:1080:{crx}:0,scale={cw}:{ch},pad={VW}:{VH}:{cx}:{cy}:color=black[v];[v][1:v]overlay=0:0[o]",
                     "-map","[o]","-an","-c:v","h264_videotoolbox","-b:v","16M","-pix_fmt","yuv420p","-r",str(FPS),clip],
                    log=os.path.join(T,f"clip_{s['id']}.log"))
            else:
                # the framing stage has already moved the picture into the card, so the scene is
                # just its graphics — composited straight over the frame, showing through the hole.
                # The panel fades up over the second half of the move, by which point the picture
                # is small enough that it reads as sliding into place rather than being covered.
                fade=SLIDE*0.5
                run(["ffmpeg","-hide_banner","-y","-framerate",str(FPS),
                     "-i",os.path.join(T,"sf",s["id"],"f_%04d.png"),
                     "-filter_complex",(f"[0:v]format=rgba,fade=t=in:st=0:d={fade:.2f}:alpha=1,"
                                        f"fade=t=out:st={max(0.0,float(s['dur'])-fade):.2f}:d={fade:.2f}:alpha=1[o]"),
                     "-map","[o]","-an","-c:v","qtrle","-pix_fmt","argb","-r",str(FPS),
                     clip.replace(".mp4",".mov")],log=os.path.join(T,f"clip_{s['id']}.log"))
                clip=clip.replace(".mp4",".mov")
            clips.append((s,clip))
        args=["ffmpeg","-hide_banner","-y","-i",base]
        for s,clip in clips: args+=["-itsoffset",str(s["_ns"]-A),"-i",clip]
        fc=[];prev="[0:v]"
        for i,(s,clip) in enumerate(clips):
            st=s["_ns"]-A; en=st+s["dur"]; out=f"[v{i}]"
            fc.append(f"{prev}[{i+1}:v]overlay=0:0:eof_action=pass:enable='between(t,{st},{en})'{out}");prev=out
            # (an animated scene carries its own alpha fade, so the window stays the scene's own)
        cur=os.path.join(T,"withscenes.mp4")
        args+=["-filter_complex",";".join(fc),"-map",prev,"-map","0:a",*HW,"-movflags","+faststart","-c:a","copy",cur]
        run(args,log=os.path.join(T,"scenes_overlay.log"))

    # ---------- 2b. OVERLAYS (RGBA clips: HyperFrames MOV/WebM, PNG seq, any alpha video) ----------
    # An overlay is composited on top of the frame for its window — lower thirds, kinetic
    # titles, callouts. Same cut/remap rules as scenes. Authored anywhere (HyperFrames
    # `render --format mov` gives ProRes 4444 with alpha); the engine just composites.
    ovs=[]
    for o in P.get("overlays",[]):
        if o.get("enabled") is False: continue
        osrc=o["src"] if os.path.isabs(o["src"]) else os.path.join(W,o["src"])
        if not os.path.exists(osrc): continue
        st=float(o.get("start",0)); od=float(o.get("dur",0)) or 0.0
        if cuts and (in_cut(st) or (od and in_cut(st+od))): continue
        ns=remap(st)
        if od and ns+od<=A: continue
        if ns>=B: continue
        ovs.append({**o,"_src":osrc,"_ns":ns,"_dur":od})
    if ovs:
        args=["ffmpeg","-hide_banner","-y","-i",cur]
        for o in ovs: args+=["-itsoffset",str(round(o["_ns"]-A,3)),"-i",o["_src"]]
        fc=[]; prev="[0:v]"
        for i,o in enumerate(ovs):
            st=round(o["_ns"]-A,3); en=round(st+(o["_dur"] or (B-A)),3); out=f"[ov{i}]"
            x=int(o.get("x",0)); y=int(o.get("y",0))
            fc.append(f"{prev}[{i+1}:v]overlay={x}:{y}:eof_action=pass:enable='between(t,{st},{en})'{out}")
            prev=out
        nxt=os.path.join(T,"withoverlays.mp4")
        args+=["-filter_complex",";".join(fc),"-map",prev,"-map","0:a",*HW,"-movflags","+faststart","-c:a","copy",nxt]
        run(args,log=os.path.join(T,"overlays.log"))
        cur=nxt

    # ---------- 3. audio layers ----------
    au=P.get("audio",{}); music=au.get("music",[]); sfx=au.get("sfx",[]); lufs=au.get("loudnessLUFS",-14)
    if music or sfx:
        inputs=["-i",cur]; parts=[]; idx=1; mix=["[0:a]"]
        for layer in (music+sfx):
            src2=layer["src"] if os.path.isabs(layer["src"]) else os.path.join(W,layer["src"])
            if not os.path.exists(src2): continue
            st=max(0.0,remap(float(layer.get("start",0)))-A); gain=float(layer.get("gain",-18))
            fi=float(layer.get("fadeIn",0)); fo=float(layer.get("fadeOut",0)); dl=float(layer.get("dur",span))
            inputs+=["-i",src2]
            ch=f"[{idx}:a]atrim=0:{dl},adelay={int(st*1000)}|{int(st*1000)},volume={10**(gain/20):.4f}"
            if fi>0: ch+=f",afade=t=in:st=0:d={fi}"
            if fo>0: ch+=f",afade=t=out:st={max(0,dl-fo)}:d={fo}"
            lbl=f"[a{idx}]"; parts.append(ch+lbl); mix.append(lbl); idx+=1
        pol=au.get("polish")
        POLISH={"none":"", "voice":"highpass=f=80,acompressor=threshold=-18dB:ratio=3:attack=8:release=180",
                "warm":"highpass=f=70,equalizer=f=180:t=q:w=1:g=1.5,acompressor=threshold=-20dB:ratio=2.5",
                "podcast":"highpass=f=90,acompressor=threshold=-16dB:ratio=4:attack=5:release=150,alimiter=limit=0.95"}
        chain=POLISH.get(str(pol).lower(),"") if pol else ""
        post=(chain+",") if chain else ""
        filt=";".join(parts)+(";" if parts else "")+"".join(mix)+f"amix=inputs={len(mix)}:duration=first:normalize=0,{post}loudnorm=I={lufs}:TP=-1.5:LRA=11[aout]"
        run(["ffmpeg","-hide_banner","-y",*inputs,"-filter_complex",filt,"-map","0:v","-map","[aout]",
             "-c:v","copy","-c:a","aac","-b:a","192k","-movflags","+faststart",a.out],log=os.path.join(T,"audio_mix.log"))
    else:
        shutil.move(cur,a.out)

    dur=subprocess.run(["ffprobe","-v","error","-show_entries","format=duration","-of","csv=p=0",a.out],capture_output=True,text=True).stdout.strip()
    print(json.dumps({"ok":True,"out":a.out,"duration":dur,"captions":len(cues),"scenes":len(scenes),"look":LOOK or None,
                      "cuts_applied":len(cuts),"range":[A,B] if a.range else None}))

if __name__=="__main__": main()
