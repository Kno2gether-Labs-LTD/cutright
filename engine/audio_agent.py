#!/usr/bin/env python3
"""audio_agent.py — generate audio via ElevenLabs and ADD it to project.json as an
editable layer (agent auto-adds; you finalize in the timeline).

  python3 audio_agent.py sfx   --prompt "whoosh transition" --at 195 --dur 2 --project project.json
  python3 audio_agent.py voice --text "Here's the catch" --at 30 --project project.json [--voice <id>]
  python3 audio_agent.py music --prompt "tense cinematic underscore" --start 0 --dur 60 --project project.json

Key: ~/.config/kno/elevenlabs.env (ELEVENLABS_API_KEY=...) or $ELEVENLABS_API_KEY.
SFX  → POST /v1/sound-generation   VOICE → POST /v1/text-to-speech/{voice}   MUSIC → POST /v1/music (best-effort; falls back to a long SFX).
"""
import argparse, json, os, re, sys, urllib.request, urllib.error

def api_key():
    if os.environ.get("ELEVENLABS_API_KEY"): return os.environ["ELEVENLABS_API_KEY"]
    p=os.path.expanduser("~/.config/kno/elevenlabs.env")
    if os.path.exists(p):
        for line in open(p):
            m=re.match(r'\s*(?:export\s+)?ELEVENLABS_API_KEY\s*=\s*"?([^"\n]+)"?',line)
            if m: return m.group(1).strip()
    sys.exit("no ELEVENLABS_API_KEY (set env or ~/.config/kno/elevenlabs.env)")

def post(url,key,body,ctype="application/json"):
    data=json.dumps(body).encode() if ctype=="application/json" else body
    req=urllib.request.Request(url,data=data,method="POST",
        headers={"xi-api-key":key,"Content-Type":ctype,"Accept":"audio/mpeg"})
    try:
        with urllib.request.urlopen(req,timeout=180) as r: return r.read(),None
    except urllib.error.HTTPError as e:
        return None,f"HTTP {e.code}: {e.read().decode()[:300]}"
    except Exception as e:
        return None,str(e)

def slug(s): return re.sub(r'[^a-z0-9]+','-',s.lower()).strip('-')[:40] or "clip"

def add_layer(project_path, kind, entry):
    P=json.load(open(project_path)); P.setdefault("audio",{}).setdefault("music",[]).__len__()
    P["audio"].setdefault("music",[]); P["audio"].setdefault("sfx",[])
    bucket = "music" if kind=="music" else "sfx"
    P["audio"][bucket].append(entry); json.dump(P,open(project_path,"w"),indent=2,ensure_ascii=False)
    return bucket

def main():
    ap=argparse.ArgumentParser(); sub=ap.add_subparsers(dest="cmd",required=True)
    for c in ("sfx","voice","music"):
        s=sub.add_parser(c); s.add_argument("--project",required=True)
        s.add_argument("--gain",type=float,default=(-6 if c=="sfx" else -2 if c=="voice" else -18))
        s.add_argument("--fadeIn",type=float,default=(0 if c!="music" else 2))
        s.add_argument("--fadeOut",type=float,default=(0 if c!="music" else 3))
        if c=="sfx": s.add_argument("--prompt",required=True); s.add_argument("--at",type=float,required=True); s.add_argument("--dur",type=float,default=2.0)
        if c=="voice": s.add_argument("--text",required=True); s.add_argument("--at",type=float,required=True); s.add_argument("--voice",default="5KyvtNPqLffyBP2XGCDc")
        if c=="music": s.add_argument("--prompt",required=True); s.add_argument("--start",type=float,default=0); s.add_argument("--dur",type=float,default=30.0)
    a=ap.parse_args(); key=api_key()
    W=os.path.dirname(os.path.abspath(a.project))

    if a.cmd=="sfx":
        audio,err=post("https://api.elevenlabs.io/v1/sound-generation",key,
            {"text":a.prompt,"duration_seconds":max(0.5,min(22,a.dur)),"prompt_influence":0.4})
        if err: sys.exit("sfx failed: "+err)
        outdir=os.path.join(W,"audio","sfx"); os.makedirs(outdir,exist_ok=True)
        fn=os.path.join(outdir,f"{slug(a.prompt)}.mp3"); open(fn,"wb").write(audio)
        e={"id":"sfx_"+slug(a.prompt),"src":os.path.relpath(fn,W),"start":a.at,"dur":a.dur,"gain":a.gain,"fadeIn":a.fadeIn,"fadeOut":a.fadeOut}
        b=add_layer(a.project,"sfx",e); print(json.dumps({"ok":True,"kind":"sfx","file":fn,"added_to":b,"at":a.at}))

    elif a.cmd=="voice":
        audio,err=post(f"https://api.elevenlabs.io/v1/text-to-speech/{a.voice}?output_format=mp3_44100_128",key,
            {"text":a.text,"model_id":"eleven_multilingual_v2"})
        if err: sys.exit("voice failed: "+err)
        outdir=os.path.join(W,"audio","voice"); os.makedirs(outdir,exist_ok=True)
        fn=os.path.join(outdir,f"{slug(a.text)}.mp3"); open(fn,"wb").write(audio)
        e={"id":"vo_"+slug(a.text),"src":os.path.relpath(fn,W),"start":a.at,"dur":30,"gain":a.gain,"fadeIn":0,"fadeOut":0}
        b=add_layer(a.project,"sfx",e); print(json.dumps({"ok":True,"kind":"voice","file":fn,"added_to":b,"at":a.at}))

    else:  # music (best-effort: /v1/music, fall back to long sound-generation)
        audio,err=post("https://api.elevenlabs.io/v1/music",key,{"prompt":a.prompt,"music_length_ms":int(min(a.dur,300)*1000)})
        if err:
            audio,err2=post("https://api.elevenlabs.io/v1/sound-generation",key,
                {"text":a.prompt+" (looping background music bed)","duration_seconds":22,"prompt_influence":0.3})
            if err2: sys.exit(f"music failed: {err} / fallback: {err2}")
        outdir=os.path.join(W,"audio","music"); os.makedirs(outdir,exist_ok=True)
        fn=os.path.join(outdir,f"{slug(a.prompt)}.mp3"); open(fn,"wb").write(audio)
        e={"id":"music_"+slug(a.prompt),"src":os.path.relpath(fn,W),"start":a.start,"dur":a.dur,"gain":a.gain,"fadeIn":a.fadeIn,"fadeOut":a.fadeOut}
        b=add_layer(a.project,"music",e); print(json.dumps({"ok":True,"kind":"music","file":fn,"added_to":b,"start":a.start}))

if __name__=="__main__": main()
