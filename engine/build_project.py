#!/usr/bin/env python3
"""build_project.py — convert an edit's artifacts (transcript + scenes + grade) into
ONE editable project.json (the edit-as-data model the editor app + agents both use).

  python3 build_project.py --work /Users/avijit/Pre_final_edit --out project.json

Every visual/audio decision becomes an addressable, editable element:
  captions.cues[]  (text, timing, emphasis, and per-cue position/size/color overrides)
  scenes[]         (split-screen explainer scenes)
  audio.music[] / audio.sfx[]  (mixable layers agents can add, you can finalize)
"""
import argparse, json, os, subprocess

STOP=set("the a an and or but of to in on for is it i you that this so we my your are be do if at as was with have not it's how would will can just they them he she from all get got up out".split())
def clean(t): return "".join(c for c in t.lower() if c.isalnum() or c in "'$%-.")

def load_words(p):
    raw=json.load(open(p)); ws=raw if isinstance(raw,list) else raw.get("words",[])
    return [{"text":str(w.get("text","")).strip(),"start":float(w["start"]),"end":float(w["end"])}
            for w in ws if w.get("text") and w.get("start") is not None]

def group(words,per=3):
    cues,cur=[],[]
    for i,w in enumerate(words):
        cur.append(w)
        ends=any(p in w["text"] for p in ".!?")
        gap=(words[i+1]["start"]-w["end"]) if i+1<len(words) else 9
        if len(cur)>=per or ends or gap>0.5: cues.append(cur); cur=[]
    if cur: cues.append(cur)
    return cues

def emph_idx(cue):
    idx,best=-1,1
    for i,w in enumerate(cue):
        c=clean(w["text"])
        if c not in STOP and len(c)>best: best,idx=len(c),i
    return idx

def probe(f):
    r=subprocess.run(["ffprobe","-v","error","-select_streams","v:0","-show_entries",
        "stream=width,height,r_frame_rate:format=duration","-of","json",f],capture_output=True,text=True)
    j=json.loads(r.stdout); st=j["streams"][0]; n,d=(st["r_frame_rate"].split("/")+["1"])[:2]
    return int(st["width"]),int(st["height"]),round(int(n)/int(d)),float(j["format"]["duration"])

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--work",required=True); ap.add_argument("--out",default="project.json")
    ap.add_argument("--source",default="/Users/avijit/Pre_final_draft.mov")
    a=ap.parse_args(); W=a.work
    graded=os.path.join(W,"graded_master.mp4")
    vw,vh,fps,dur=probe(graded)

    # captions
    words=load_words(os.path.join(W,"transcript.json"))
    cues=[]
    for n,cue in enumerate(group(words),1):
        ei=emph_idx(cue)
        cues.append({"id":f"c{n:04d}","start":round(cue[0]['start'],3),
                     "end":round(max(cue[-1]['end'],cue[0]['start']+0.25),3),
                     "tokens":[{"t":w["text"],"e":(i==ei)} for i,w in enumerate(cue)]})
    # scenes
    scenes=json.load(open(os.path.join(W,"scenes_full.json")))["scenes"] if os.path.exists(os.path.join(W,"scenes_full.json")) else []
    # grade
    grade={}
    gj=os.path.join(W,"grade.json")
    if os.path.exists(gj):
        try: grade={"filter":json.load(open(gj)).get("filter","")}
        except Exception: pass

    project={
      "version":1,
      "meta":{"source":a.source,"graded":"graded_master.mp4","width":vw,"height":vh,"fps":fps,
              "duration":round(dur,3),"style":"coral-ink-bone"},
      "grade":grade,
      "captions":{
        "defaults":{"style":"highlight","font":"/System/Library/Fonts/Supplemental/Arial Rounded Bold.ttf",
                    "fontsize":int(vh*0.056),"cy":int(vh*0.66),"color":"#FFFFFF","highlight":"#E5533D"},
        "cues":cues
      },
      "scenes":scenes,
      "cuts":[],
      "audio":{"loudnessLUFS":-14,"voice":{"source":"graded"},"music":[],"sfx":[]}
    }
    json.dump(project,open(a.out,"w"),indent=2,ensure_ascii=False)
    print(json.dumps({"ok":True,"captions":len(cues),"scenes":len(scenes),"out":a.out,
                      "duration":round(dur,1)}))

if __name__=="__main__": main()
