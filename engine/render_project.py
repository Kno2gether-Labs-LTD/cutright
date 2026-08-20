#!/usr/bin/env python3
"""render_project.py — render the final video FROM project.json (edit-as-data).

  python3 render_project.py --project project.json --out FINAL.mp4          # full (applies cuts)
  python3 render_project.py --project p.json --out preview.mp4 --preview --range 12 40   # what the editor shows
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

_ENCODER=None
def pick_encoder():
    """Which H.264 encoder to use.

    Every Mac with real hardware has VideoToolbox and it is by far the fastest, so it stays the
    default. But a virtualised Mac does not — a CI runner, a VM — and there the encoder opens and
    then fails with "Could not open encoder before EOF", which looks like a broken project rather
    than a missing GPU. So this asks rather than assumes, once per run.

    The fallback order deliberately does NOT bake x264 into anything we ship: this only chooses
    among the encoders the ffmpeg already on the machine happens to have (see
    docs/decisions/0003-ffmpeg-not-bundled.md — we do not ship ffmpeg at all).
    """
    global _ENCODER
    if _ENCODER: return _ENCODER
    forced=os.environ.get("CVE_VIDEO_ENCODER")
    if forced:
        _ENCODER=forced; return _ENCODER
    try:
        have=subprocess.run(["ffmpeg","-hide_banner","-encoders"],capture_output=True,text=True,timeout=20).stdout
    except Exception:
        have=""
    def works(name):
        if name not in have: return False
        # Listed is not the same as usable: VideoToolbox is listed on a VM and fails on first use.
        try:
            r=subprocess.run(["ffmpeg","-hide_banner","-loglevel","error","-y","-f","lavfi",
                              "-i","color=c=black:s=64x64:d=0.1","-c:v",name,"-f","null","-"],
                             capture_output=True,text=True,timeout=30)
            return r.returncode==0
        except Exception:
            return False
    for name in ("h264_videotoolbox","libx264","libopenh264"):
        if works(name):
            if name!="h264_videotoolbox":
                print(f"note: h264_videotoolbox is unavailable here, using {name}",file=sys.stderr)
            _ENCODER=name; return _ENCODER
    raise SystemExit("no usable H.264 encoder in this ffmpeg (tried videotoolbox, libx264, libopenh264)")


def even(v):
    """Round to an even number: yuv420p cannot represent an odd width or height."""
    n=int(round(float(v)));
    return max(2,n-(n%2))

def cut_cache_key(cuts,graded,camera,fps,dur,br):
    """Identity of a cut master: the cuts themselves plus the files they were made from."""
    import hashlib
    def stat(pth):
        try: st=os.stat(pth); return [os.path.basename(pth),st.st_size,int(st.st_mtime)]
        except OSError: return None
    payload=json.dumps({"cuts":sorted([[float(c.get("start",0)),float(c.get("end",0)),
                                        str(c.get("transition","") or ""),float(c.get("tdur",0.3) or 0)]
                                       for c in cuts]),
                        "graded":stat(graded),"camera":stat(camera) if camera else None,
                        "fps":fps,"dur":dur,"br":br},sort_keys=True)
    return hashlib.sha1(payload.encode()).hexdigest()[:16]

def prune_cache(cdir,keep=4):
    """Cut masters are big. Keep a few recent ones; the newest is the one being reused."""
    try: names=[n for n in os.listdir(cdir) if n.startswith(("cut_","cam_","meta_"))]
    except OSError: return
    keys=sorted({n.split("_",1)[1].rsplit(".",1)[0] for n in names},
                key=lambda k: max((os.path.getmtime(os.path.join(cdir,n)) for n in names if k in n),default=0),
                reverse=True)
    for k in keys[keep:]:
        for n in names:
            if k in n:
                try: os.remove(os.path.join(cdir,n))
                except OSError: pass

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
    # Write the edit as separate layers as well as the flat file, so it can be reviewed — or
    # finished — somewhere else. Off by default: it costs a second pass over the graphics.
    ap.add_argument("--layers",default="",help="directory to write base/graphics/captions/audio layers into")
    # Preview mode. The editor rebuilds a preview every time the edit changes, so the two things
    # that matter are that it tells the truth and that it is not expensive. Lower bitrate covers
    # the second cheaply; the first is why cuts now apply to ranged renders as well (see below).
    ap.add_argument("--preview",action="store_true",help="cheaper encode + reuse the cut master between runs")
    ap.add_argument("--no-cuts",action="store_true",help="render the ORIGINAL timeline, ignoring cuts[]")
    ap.add_argument("--cache",default="",help="where to keep the reusable cut master (default <project>/.preview-cache)")
    a=ap.parse_args()
    P=json.load(open(a.project)); W=os.path.dirname(os.path.abspath(a.project))
    m=P["meta"]; VW,VH,FPS,DUR=m["width"],m["height"],m["fps"],m["duration"]
    graded=os.path.join(W,m["graded"])
    # When --tmp is given the caller owns that directory and cleans it up. When it is not, this
    # made one inside the project folder and left it there — a couple of hundred megabytes of
    # intermediates per render, forever. The agent renders through this script directly, so that
    # was every render it ever ran.
    T=a.tmp or tempfile.mkdtemp(prefix="rp_",dir=W); os.makedirs(T,exist_ok=True)
    OWN_TMP=not a.tmp
    # A preview is watched once and thrown away; 14M would spend most of the render writing
    # bits nobody looks at, and leave >100MB intermediates behind for every rebuild.
    BR="3M" if a.preview else "14M"
    HW=["-c:v",pick_encoder(),"-b:v",BR,"-profile:v","high","-pix_fmt","yuv420p","-tag:v","avc1"]
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
    # A recording keeps the screen and the camera as SEPARATE files. The screen is the master;
    # the camera is composited on top by the framing stage, which is what lets the speaker be a
    # corner circle over the screen one moment and fill the frame the next. Both were started
    # together, so their clocks agree — but only if the camera lives through the same cuts.
    tracks=(P.get("meta",{}) or {}).get("tracks") or {}
    camera=tracks.get("camera")
    if camera and not os.path.isabs(camera): camera=os.path.join(os.path.dirname(os.path.abspath(a.project)),camera)
    if camera and not os.path.exists(camera): camera=None

    # Cuts used to be skipped whenever a range was given, so "preview this section" showed the
    # footage with the cuts still in it — the timeline said one thing and the picture said
    # another. A and B are on the OUTPUT timeline (every element is remapped before it is
    # compared against them), so applying cuts here needs nothing else. --no-cuts brings the old
    # behaviour back for anyone spot-checking the original.
    cuts=[] if a.no_cuts else P.get("cuts",[])
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
        # Rebuilding the cut master is the single most expensive thing a preview does — it
        # re-encodes every kept segment of the whole video before the range is even applied, so a
        # fifteen-second window cost twenty-two seconds instead of six. It only changes when the
        # cuts (or the footage) change, so a preview keeps it and reuses it.
        cached=False; cdir=""
        if a.preview:
            cdir=a.cache or os.path.join(W,".preview-cache")
            key=cut_cache_key(cuts,graded,camera,FPS,DUR,BR)
            ccut=os.path.join(cdir,f"cut_{key}.mp4"); ccam=os.path.join(cdir,f"cam_{key}.mp4")
            cmeta=os.path.join(cdir,f"meta_{key}.json")
            if os.path.exists(ccut) and os.path.exists(cmeta) and (not camera or os.path.exists(ccam)):
                try:
                    workDur=float(json.load(open(cmeta))["workDur"])
                    src=ccut
                    if camera: camera=ccam
                    cached=True
                except Exception:
                    cached=False        # a half-written cache entry is not worth a failed render

        if not cached:
            parts=[]; cam_parts=[]
            for i,(s0,e0) in enumerate(segs):
                seg=os.path.join(T,f"seg_{i:03d}.mp4")
                run(["ffmpeg","-hide_banner","-y","-ss",str(s0),"-to",str(e0),"-i",graded,*HW,
                     "-r",str(FPS),"-c:a","aac","-b:a","192k","-ar","48000","-ac","2",seg],log=os.path.join(T,f"seg_{i}.log"))
                parts.append(seg)
                if camera:
                    # the same seconds removed from the camera, or the speaker drifts out of sync
                    # with their own voice from the first cut onwards
                    cseg=os.path.join(T,f"cam_{i:03d}.mp4")
                    run(["ffmpeg","-hide_banner","-y","-ss",str(s0),"-to",str(e0),"-i",camera,*HW,
                         "-r",str(FPS),"-an",cseg],log=os.path.join(T,f"cam_seg_{i}.log"))
                    cam_parts.append(cseg)
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

            if camera and cam_parts:
                # The camera gets the cuts but never the transitions: it is composited on top, so a
                # crossfade on the picture underneath is the transition. Straight concat keeps it in
                # step with the audio, which is what matters.
                cl=os.path.join(T,"cam_segs.txt"); open(cl,"w").write("".join(f"file '{p}'\n" for p in cam_parts))
                camcut=os.path.join(T,"camera_cut.mp4")
                run(["ffmpeg","-hide_banner","-y","-f","concat","-safe","0","-i",cl,"-c","copy",
                     "-movflags","+faststart",camcut],log=os.path.join(T,"cam_concat.log"))
                camera=camcut

        if a.preview and not cached and cdir:
            try:
                os.makedirs(cdir,exist_ok=True)
                shutil.copy2(src,ccut)
                if camera: shutil.copy2(camera,ccam)
                json.dump({"workDur":workDur},open(cmeta,"w"))
                prune_cache(cdir)
            except Exception:
                pass                    # a cache that cannot be written is a slow render, not a broken one

    A,B=(a.range if a.range else [0.0,workDur]); span=B-A
    # A range that lies past the end of the video used to "succeed": ffmpeg produced a file with
    # an audio stream and no pictures, and nothing said so. Asking to preview seconds that do not
    # exist is a mistake worth being told about, not one to answer with a silent audio file.
    if a.range:
        if A >= workDur - 0.01:
            raise SystemExit(f"the range starts at {A:.2f}s but the video is only {workDur:.2f}s long")
        if B > workDur:
            B = workDur                     # a range that runs off the end is simply trimmed
        A = max(0.0, A); span = B - A
        if span <= 0.05:
            raise SystemExit(f"the range {A:.2f}-{B:.2f}s is too short to render")
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
    # A camera track always needs the framing pass, even with no moves in the project: without it
    # the speaker is a file nobody composited and the recording was pointless.
    if camera and not frames:
        frames=[{"id":"_camera_default","start":0.0,"dur":0.05,"to":"corner","shape":"circle",
                 "size":0.24,"corner":"br","margin":0.045,"_ns":0.0,"_dur":0.05,"_implicit":True}]
    if frames:
        sys.path.insert(0,os.path.dirname(os.path.abspath(__file__)))
        import frames_png as FP
        fdir=os.path.join(T,"frames"); os.makedirs(fdir,exist_ok=True)

        # What is being MOVED and what it sits ON.
        #
        #   a recording with a camera : the camera moves, the screen is what it sits on. "Full
        #                               frame" then means the speaker fills the screen — which is
        #                               exactly what you want when nothing on the desktop matters.
        #   anything else             : the picture itself moves, over a backdrop.
        #
        # One machinery, two readings, because a camera in a corner and a talking head shrinking
        # onto a brand wash are the same animation.
        picture=camera or src
        pict_ar=VW/float(VH)
        if camera:
            pr=subprocess.run(["ffprobe","-v","error","-select_streams","v:0","-show_entries",
                               "stream=width,height","-of","csv=p=0",camera],capture_output=True,text=True)
            try:
                cwv,chv=[int(x) for x in pr.stdout.strip().split(",")[:2]]
                if chv: pict_ar=cwv/float(chv)
            except Exception: pass

        # --- the picture's geometry over time: a chain of holds, latest wins
        # Where the picture starts. A camera starts where a camera belongs — small, in a corner —
        # and NOT wherever the first move happens to go, or a project whose first instruction is
        # "go full at 0:10" would have the speaker filling the screen for the ten seconds before it.
        start_state={"to":"full"}
        if camera:
            start_state=dict((P.get("meta",{}).get("tracks") or {}).get("cameraHome")
                             or {"to":"corner","shape":"circle","size":0.24,"corner":"br","margin":0.045})
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
        pw=f"({ph})*{pict_ar:.6f}"

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
        if camera:
            # the screen recording IS the backdrop — that is the whole point of keeping them apart
            bg_filter=f"[0:v]scale={VW}:{VH},fps={FPS}[bg];"
            bg_inputs=[]
        elif bd=="blur":
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
        # With a camera the screen is the base and the camera is the moving picture, so the
        # camera comes in as its own input; without one, input 0 is both.
        cam_inputs=(["-i",camera] if camera else [])
        pic_label="4:v" if (camera and bg_inputs) else ("3:v" if camera else "0:v")
        run(["ffmpeg","-hide_banner","-y",*vin_f,
             "-f","lavfi","-i",f"color=c=black@0.0:s={VW}x{VH}:r={FPS},format=rgba",
             "-i",maskmov,*bg_inputs,*cam_inputs,
             "-filter_complex",
             (bg_filter
              +f"[{pic_label}]scale=w='{pw}':h='{ph}':eval=frame[pic];"
              +f"[1:v][pic]overlay=x='({cx})-w/2':y='({cy})-h/2':eval=frame:shortest=1,format=rgba[canvas];"
              +f"[canvas][2:v]alphamerge[shaped];"
              +f"[bg][shaped]overlay=0:0:shortest=1,format=yuv420p[v]"),
             "-map","[v]","-map","0:a?",*HW,"-c:a","copy","-movflags","+faststart",framed],
            log=os.path.join(T,"frames.log"))
        src=framed; trimmed=trimmed or bool(a.range)

    # ---------- 0d. CLIPS (a second video track: b-roll, a screen recording, a cutaway) ----------
    # Until now a project held exactly ONE video, so a tutorial — talking head plus screen
    # capture — could only be decorated, not edited. A clip is another piece of footage placed on
    # the timeline: either filling the frame for its window, or sitting in a box over it.
    #
    # It composites on the PICTURE, before captions are burned in, so a caption sits on top of
    # b-roll rather than under it. Same cut rule as scenes and overlays: a clip that straddles a
    # cut is dropped rather than silently landing somewhere it was never meant to be.
    clips=[]
    for c in P.get("clips",[]):
        if c.get("enabled") is False: continue
        csrc=c.get("src") or ""
        csrc=csrc if os.path.isabs(csrc) else os.path.join(W,csrc)
        if not os.path.exists(csrc): continue
        st=float(c.get("start",0)); cd=float(c.get("dur",0)) or 0.0
        if cuts and (in_cut(st) or (cd and in_cut(st+cd))): continue
        ns=remap(st)
        if cd and ns+cd<=A: continue
        if ns>=B: continue
        clips.append({**c,"_src":csrc,"_ns":ns,"_dur":cd})

    if clips:
        args=["ffmpeg","-hide_banner","-y",*vin_for(src)]
        for c in clips:
            # -ss before -i seeks the SOURCE (which part of the clip to show); -itsoffset places
            # that on the output timeline.
            args+=["-itsoffset",str(round(c["_ns"]-A,3))]
            if float(c.get("in",0)): args+=["-ss",str(float(c["in"]))]
            args+=["-i",c["_src"]]

        fc=[]; prev="[0:v]"
        for i,c in enumerate(clips):
            st=round(c["_ns"]-A,3); en=round(st+(c["_dur"] or (B-A)),3)
            box=c.get("box") or {}
            if str(c.get("fit","full"))=="box":
                # Normalised, so the edit survives a change of resolution — same rule as zooms.
                bw=even(VW*float(box.get("w",0.36))); bh=even(VH*float(box.get("h",0.36)))
                bx=even(VW*float(box.get("x",0.6)));  by=even(VH*float(box.get("y",0.06)))
            else:
                bw,bh,bx,by=VW,VH,0,0
            # "contain" letterboxes and never crops, which is what a screen recording needs —
            # cropping a screen throws away the part someone is pointing at. "cover" fills.
            if str(c.get("fill","contain"))=="cover":
                fit=f"scale={bw}:{bh}:force_original_aspect_ratio=increase,crop={bw}:{bh}"
            else:
                fit=(f"scale={bw}:{bh}:force_original_aspect_ratio=decrease,"
                     f"pad={bw}:{bh}:(ow-iw)/2:(oh-ih)/2:color=black")
            out=f"[cl{i}]"
            # setsar=1 for the reason learned the hard way: scale adjusts the sample aspect to
            # preserve the display aspect, and an odd frame comes out of the far end of that.
            fc.append(f"[{i+1}:v]{fit},setsar=1,fps={FPS}[c{i}]")
            fc.append(f"{prev}[c{i}]overlay={bx}:{by}:eof_action=pass:enable='between(t,{st},{en})'{out}")
            prev=out
        clipped=os.path.join(T,"clips.mp4")
        args+=["-filter_complex",";".join(fc),"-map",prev,"-map","0:a?",*HW,
               "-movflags","+faststart","-c:a","copy",clipped]
        run(args,log=os.path.join(T,"clips.log"))
        src=clipped; trimmed=trimmed or bool(a.range)

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
             "-map","[v]","-map","0:a?",*HW,"-movflags","+faststart","-c:a","copy",base],log=os.path.join(T,"base.log"))
    else:
        # No captions in range — a screen recording being framed, say. Rendering a full clip of
        # transparent PNGs to composite nothing was both slow and a crash waiting to happen (it
        # needed a caption font the project had no reason to carry).
        if LOOK:
            run(["ffmpeg","-hide_banner","-y",*vin,"-filter_complex",f"{vpre}{vsrc}null[v]",
                 "-map","[v]","-map","0:a?",*HW,"-movflags","+faststart","-c:a","copy",base],
                log=os.path.join(T,"base.log"))
        else:
            run(["ffmpeg","-hide_banner","-y",*vin,"-map","0:v","-map","0:a?",*HW,
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
        cx,cy,cw,ch=man["x"],man["y"],man["w"],man["h"]
        # The crop that fills the card with the picture. This used to be written against 1920x1080
        # literally, which quietly meant the wrong region on any other frame size — and could come
        # out an ODD width, which yuv420p cannot represent, so libx264 refused the filter graph
        # while VideoToolbox happened to tolerate it. Even numbers, and the project's own size.
        crw=round(VH*cw/ch); crw-=crw%2; crx=max(0,(VW-crw)//2); crx-=crx%2
        clips=[]
        for s in scenes:
            clip=os.path.join(T,f"clip_{s['id']}.mp4")
            if s.get("enter")=="cut":
                # the original behaviour: the picture is cropped into the card inside the clip
                run(["ffmpeg","-hide_banner","-y","-ss",str(s["start"]),"-t",str(s["dur"]),"-i",graded,
                     "-framerate",str(FPS),"-i",os.path.join(T,"sf",s["id"],"f_%04d.png"),
                     # setsar=1 is not decoration. `scale` sets the output sample aspect ratio to PRESERVE the
                     # display aspect it was given, so scaling 788x1080 into a 596x816 card leaves SAR at
                     # ~0.999 — and the automatic pixel-format conversion then resizes to square pixels and
                     # asks the encoder for 1920x1081. VideoToolbox accepted the odd height; libx264 
                     # correctly refuses, which is how this surfaced. Square pixels, stated.
                     "-filter_complex",f"[0:v]crop={crw}:{VH}:{crx}:0,scale={cw}:{ch},setsar=1,pad={VW}:{VH}:{cx}:{cy}:color=black[v];[v][1:v]overlay=0:0[o]",
                     "-map","[o]","-an","-c:v",pick_encoder(),"-b:v","16M","-pix_fmt","yuv420p","-r",str(FPS),clip],
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
        args+=["-filter_complex",";".join(fc),"-map",prev,"-map","0:a?",*HW,"-movflags","+faststart","-c:a","copy",cur]
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
        args+=["-filter_complex",";".join(fc),"-map",prev,"-map","0:a?",*HW,"-movflags","+faststart","-c:a","copy",nxt]
        run(args,log=os.path.join(T,"overlays.log"))
        cur=nxt

    # ---------- 3. audio layers ----------
    # Music sits UNDER the voice, and a fixed gain is not how that is done: a bed that works in
    # the gaps is too loud under a sentence, and one that works under a sentence is inaudible in
    # the gaps. So each music layer is side-chained to the voice — it steps back while someone is
    # talking and comes up when they stop. Effects are left alone; they are meant to land.
    au=P.get("audio",{}); music=au.get("music",[]); sfx=au.get("sfx",[]); lufs=au.get("loudnessLUFS",-14)
    if music or sfx:
        def resolve(layer):
            sp=layer.get("src")
            if not sp: return None
            full=sp if os.path.isabs(sp) else os.path.join(W,sp)
            return full if os.path.exists(full) else None

        beds=[(l,resolve(l)) for l in music]; beds=[(l,f) for l,f in beds if f]
        hits=[(l,resolve(l)) for l in sfx];   hits=[(l,f) for l,f in hits if f]

        duck=au.get("duck",{}) if isinstance(au.get("duck"),dict) else ({} if au.get("duck",True) else None)
        ducking=duck is not None and bool(beds)

        inputs=["-i",cur]; parts=[]; idx=1; mix=[]
        voice="[0:a]"
        if ducking:
            # one copy of the voice for the mix, one key per bed
            keys=[f"[k{i}]" for i in range(len(beds))]
            parts.append(f"[0:a]asplit={len(beds)+1}[voice]"+"".join(keys))
            voice="[voice]"
        mix.append(voice)

        def layer_chain(layer,label):
            st=max(0.0,remap(float(layer.get("start",0)))-A); gain=float(layer.get("gain",-18))
            fi=float(layer.get("fadeIn",0)); fo=float(layer.get("fadeOut",0)); dl=float(layer.get("dur",span))
            ch=(f"[{label}:a]atrim=0:{dl},adelay={int(st*1000)}|{int(st*1000)},"
                f"volume={10**(gain/20):.4f}")
            if fi>0: ch+=f",afade=t=in:st=0:d={fi}"
            if fo>0: ch+=f",afade=t=out:st={max(0,dl-fo)}:d={fo}"
            return ch

        for i,(layer,full) in enumerate(beds):
            inputs+=["-i",full]
            lbl=f"[a{idx}]"; parts.append(layer_chain(layer,idx)+lbl)
            if ducking:
                # threshold/ratio chosen so speech pulls the bed down clearly without pumping;
                # the slow release keeps it from surging between words.
                th=float(duck.get("threshold",0.045)); ra=float(duck.get("ratio",8))
                at=float(duck.get("attack",15)); re=float(duck.get("release",350))
                out=f"[d{idx}]"
                parts.append(f"{lbl}[k{i}]sidechaincompress=threshold={th}:ratio={ra}"
                             f":attack={at}:release={re}:level_sc=1{out}")
                mix.append(out)
            else:
                mix.append(lbl)
            idx+=1

        for layer,full in hits:
            inputs+=["-i",full]
            lbl=f"[a{idx}]"; parts.append(layer_chain(layer,idx)+lbl); mix.append(lbl); idx+=1

        pol=au.get("polish")
        POLISH={"none":"", "voice":"highpass=f=80,acompressor=threshold=-18dB:ratio=3:attack=8:release=180",
                "warm":"highpass=f=70,equalizer=f=180:t=q:w=1:g=1.5,acompressor=threshold=-20dB:ratio=2.5",
                "podcast":"highpass=f=90,acompressor=threshold=-16dB:ratio=4:attack=5:release=150,alimiter=limit=0.95"}
        chain=POLISH.get(str(pol).lower(),"") if pol else ""
        post=(chain+",") if chain else ""
        filt=";".join(parts)+(";" if parts else "")+"".join(mix)+ \
             f"amix=inputs={len(mix)}:duration=first:normalize=0,{post}loudnorm=I={lufs}:TP=-1.5:LRA=11[aout]"
        run(["ffmpeg","-hide_banner","-y",*inputs,"-filter_complex",filt,"-map","0:v","-map","[aout]",
             "-c:v","copy","-c:a","aac","-b:a","192k","-movflags","+faststart",a.out],log=os.path.join(T,"audio_mix.log"))
    else:
        # No music and no effects — but the project still asks for a loudness, and until now that
        # was only honoured when something else happened to need the audio stage. The result was
        # that a video WITH a music bed came out at the target and the same video WITHOUT one came
        # out wherever the room happened to be: measured at -17.6 LUFS against a stated -14.
        # Loudness is not a side effect of having music.
        has_audio=False
        try:
            pr=subprocess.run(["ffprobe","-v","error","-select_streams","a","-show_entries",
                               "stream=index","-of","csv=p=0",cur],capture_output=True,text=True,timeout=30)
            has_audio=bool(pr.stdout.strip())
        except Exception:
            has_audio=False
        if has_audio and lufs is not None:
            pol=au.get("polish")
            POLISH={"clean":"highpass=f=80,acompressor=threshold=-18dB:ratio=3:attack=5:release=120",
                    "warm":"highpass=f=70,equalizer=f=180:t=q:w=1:g=1.5,acompressor=threshold=-20dB:ratio=2.5",
                    "podcast":"highpass=f=90,acompressor=threshold=-16dB:ratio=4:attack=5:release=150,alimiter=limit=0.95"}
            chain=POLISH.get(str(pol).lower(),"") if pol else ""
            pre=(chain+",") if chain else ""
            run(["ffmpeg","-hide_banner","-y","-i",cur,
                 "-af",f"{pre}loudnorm=I={lufs}:TP=-1.5:LRA=11",
                 "-map","0:v?","-map","0:a","-c:v","copy","-c:a","aac","-b:a","192k",
                 "-movflags","+faststart",a.out],log=os.path.join(T,"loudness.log"))
        else:
            shutil.move(cur,a.out)

    # ---------- 4. layers (optional): the same edit, taken apart ----------
    # A flat file is the deliverable; layers are how a person checks it, or finishes it in
    # something else. Each is the SAME material the flat render used, so what you review is what
    # was rendered, not a second interpretation of the project.
    layers={}
    if a.layers:
        LD=a.layers if os.path.isabs(a.layers) else os.path.join(os.path.dirname(os.path.abspath(a.project)),a.layers)
        os.makedirs(LD,exist_ok=True)

        # the picture with nothing drawn on it: cuts, zooms, framing and the grade
        picture=os.path.join(LD,"1-picture.mp4")
        vin_l=vin_for(src)
        pre=f"[0:v]{LOOK}[v]" if LOOK else "[0:v]null[v]"
        run(["ffmpeg","-hide_banner","-y",*vin_l,"-filter_complex",pre,"-map","[v]","-an",*HW,
             "-movflags","+faststart",picture],log=os.path.join(T,"layer_picture.log"))
        layers["picture"]=os.path.basename(picture)

        # captions, alone, with alpha — the layer people most often want to redo
        if cues:
            caps=os.path.join(LD,"3-captions.mov")
            run(["ffmpeg","-hide_banner","-y","-f","concat","-safe","0",
                 "-i",os.path.join(capdir,"concat.txt"),
                 "-filter_complex",f"[0:v]fps={FPS},format=rgba,scale={VW}:{VH}[c]",
                 "-map","[c]","-an","-c:v","qtrle","-pix_fmt","argb","-t",str(span),caps],
                log=os.path.join(T,"layer_captions.log"))
            layers["captions"]=os.path.basename(caps)

        # panels and overlays on one transparent layer, each at its own moment
        gfx_parts=[(s_["_ns"]-A,os.path.join(T,f"clip_{s_['id']}.mov"),float(s_["dur"]))
                   for s_ in scenes if os.path.exists(os.path.join(T,f"clip_{s_['id']}.mov"))]
        gfx_parts+=[(o["_ns"]-A,o["_src"],(o["_dur"] or span)) for o in ovs]
        if gfx_parts:
            gfile=os.path.join(LD,"2-graphics.mov")
            args=["ffmpeg","-hide_banner","-y","-f","lavfi","-i",
                  f"color=c=black@0.0:s={VW}x{VH}:r={FPS}:d={span:.3f},format=rgba"]
            # each piece starts at its own moment — the same -itsoffset the flat render uses.
            # Without it a panel is visible at the right time but playing the wrong frames.
            for st,pth,_d in gfx_parts: args+=["-itsoffset",f"{max(0.0,st):.3f}","-i",pth]
            fc=[]; prev="[0:v]"
            for i,(st,_pth,_d) in enumerate(gfx_parts):
                out=f"[g{i}]"
                fc.append(f"{prev}[{i+1}:v]overlay=0:0:eof_action=pass:enable=\'between(t,{max(0,st):.3f},{max(0,st)+_d:.3f})\'{out}")
                prev=out
            args+=["-filter_complex",";".join(fc),"-map",prev,"-an","-c:v","qtrle","-pix_fmt","argb",
                   "-t",str(span),gfile]
            run(args,log=os.path.join(T,"layer_graphics.log"))
            layers["graphics"]=os.path.basename(gfile)

        # the voice on its own, and every generated layer beside it
        voice=os.path.join(LD,"4-voice.wav")
        rc=subprocess.run(["ffmpeg","-hide_banner","-y",*vin_for(src),"-vn","-c:a","pcm_s16le",voice],
                          capture_output=True,text=True)
        if rc.returncode==0: layers["voice"]=os.path.basename(voice)
        stems=[]
        for kind in ("music","sfx"):
            for L in (P.get("audio") or {}).get(kind) or []:
                sp=L.get("src")
                if not sp: continue
                full=sp if os.path.isabs(sp) else os.path.join(os.path.dirname(os.path.abspath(a.project)),sp)
                if not os.path.exists(full): continue
                dest=os.path.join(LD,f"5-{kind}-{os.path.splitext(os.path.basename(full))[0]}.wav")
                r2=subprocess.run(["ffmpeg","-hide_banner","-y","-i",full,"-c:a","pcm_s16le",dest],
                                  capture_output=True,text=True)
                if r2.returncode==0: stems.append(os.path.basename(dest))
        if stems: layers["stems"]=stems

        # what they are and how they stack, for whoever opens the folder
        with open(os.path.join(LD,"README.txt"),"w") as f:
            f.write("The same edit, taken apart.\n\n"
                    "  1-picture.mp4    the video: cuts, camera moves, framing and the grade\n"
                    "  2-graphics.mov   panels and overlays, transparent (QuickTime RLE)\n"
                    "  3-captions.mov   captions, transparent\n"
                    "  4-voice.wav      the recorded audio after the cuts\n"
                    "  5-*.wav          each generated music or effects layer\n\n"
                    "Stack them in that order — picture at the bottom — and you have the flat render.\n"
                    "Timings are on the CUT timeline, so they line up as-is.\n")

    dur=subprocess.run(["ffprobe","-v","error","-show_entries","format=duration","-of","csv=p=0",a.out],capture_output=True,text=True).stdout.strip()
    # Only on success. A failed render's working files are the only way to find out why, and
    # the path is printed with the error so they can be found.
    if OWN_TMP: shutil.rmtree(T,ignore_errors=True)

    print(json.dumps({"ok":True,"out":a.out,"duration":dur,"captions":len(cues),"scenes":len(scenes),"look":LOOK or None,
                      "cuts_applied":len(cuts),"range":[A,B] if a.range else None,
                      **({"layers":layers} if a.layers else {})}))

if __name__=="__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception:
        # Say where the working files are before falling over, since that is what a diagnosis
        # needs and the success path deletes them.
        import traceback
        traceback.print_exc()
        sys.exit(1)
