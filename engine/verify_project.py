"""Check a project for the mistakes that only show up after a twenty-minute render.

    python3 verify_project.py --project project.json [--json]

Everything here is a rule the engine actually enforces at render time, or a rule of taste the
packs are built on. The point is that an agent — or a person — can find out in a second, rather
than watching an export to discover a scene straddling a cut was silently dropped.

Exit code is 0 when nothing is wrong, 1 when something is.
"""
import argparse, json, os, sys

def load(path):
    with open(path) as f: return json.load(f)

def overlaps(a0, a1, b0, b1): return a0 < b1 - 1e-6 and b0 < a1 - 1e-6

def check(P, root="."):
    issues = []
    def bad(sev, what, detail, fix): issues.append(dict(severity=sev, what=what, detail=detail, fix=fix))
    check_hand_edits(P, root, bad)

    meta = P.get("meta") or {}
    dur = float(meta.get("duration") or 0)
    cuts = sorted([(float(c["start"]), float(c["end"])) for c in P.get("cuts") or []])
    def in_cut(t): return any(s < t < e for s, e in cuts)
    def straddles(s, e): return any(overlaps(s, e, cs, ce) for cs, ce in cuts)

    # ---- the media the project claims to be made of
    for label, rel in [("graded master", meta.get("graded")),
                       ("screen track", (meta.get("tracks") or {}).get("screen")),
                       ("camera track", (meta.get("tracks") or {}).get("camera"))]:
        if rel and not os.path.exists(os.path.join(root, rel)):
            bad("error", f"the {label} is missing", rel, "re-record, or point meta at the file that exists")

    # ---- cuts
    for i, (s, e) in enumerate(cuts):
        if e <= s: bad("error", "a cut ends before it starts", f"{s}s → {e}s", "swap them or delete the cut")
        if dur and e > dur + 0.05:
            bad("error", "a cut runs past the end of the video", f"{s}s → {e}s of {dur}s", "trim it")
        if i and cuts[i - 1][1] > s + 1e-6:
            bad("warn", "two cuts overlap", f"{cuts[i-1]} and {(s, e)}",
                "merge them — the engine will, but then the numbers you see are not the ones it used")

    # ---- anything the engine drops silently
    for sc in P.get("scenes") or []:
        s, e = float(sc.get("start", 0)), float(sc.get("start", 0)) + float(sc.get("dur", 0))
        if straddles(s, e):
            bad("error", "a scene straddles a cut and will be dropped at render",
                f"{sc.get('id')} at {s}s", "move it clear of the cut, or remove the cut")
    for ov in P.get("overlays") or []:
        if ov.get("enabled") is False: continue
        s, e = float(ov.get("start", 0)), float(ov.get("start", 0)) + float(ov.get("dur", 0))
        if straddles(s, e):
            bad("error", "an overlay straddles a cut and will be dropped at render",
                f"{ov.get('id')} at {s}s", "move it clear of the cut")
        src = ov.get("src")
        if src and not os.path.exists(os.path.join(root, src)):
            bad("error", "an overlay file is missing", src, "render the preset again, or fix the path")

    # ---- clips (the second video track)
    for cl in P.get("clips") or []:
        if cl.get("enabled") is False: continue
        cid = cl.get("id") or "(no id)"
        s0 = float(cl.get("start", 0)); d0 = float(cl.get("dur", 0) or 0)
        if straddles(s0, s0 + d0):
            bad("error", "a clip straddles a cut and will be dropped at render",
                f"{cid} at {s0}s", "move it clear of the cut, or remove the cut")
        src = cl.get("src")
        if not src:
            bad("error", "a clip has no file", cid, "point it at a video in the project folder")
        elif not os.path.isabs(src) and not os.path.exists(os.path.join(root, src)):
            bad("error", "a clip's file is missing", src, "put the file back, or fix the path")
        if d0 <= 0:
            bad("error", "a clip has no length", f"{cid} at {s0}s", "give it a dur in seconds")
        if str(cl.get("fit")) == "box":
            b = cl.get("box") or {}
            for k, dflt in (("x", 0.6), ("y", 0.06), ("w", 0.36), ("h", 0.36)):
                v = float(b.get(k, dflt))
                if not 0 <= v <= 1:
                    bad("error", "a clip's box is outside the frame",
                        f"{cid}: {k}={v}", "box values are fractions of the frame, 0..1 — not pixels")
            if float(b.get("x", 0.6)) + float(b.get("w", 0.36)) > 1.001 or \
               float(b.get("y", 0.06)) + float(b.get("h", 0.36)) > 1.001:
                bad("warn", "a clip's box runs off the edge of the frame",
                    cid, "x+w and y+h should be at most 1")

    # ---- panels
    pacing = P.get("pacing") or {}
    lo, hi = float(pacing.get("minPanel", 2.0)), float(pacing.get("maxPanel", 9.0))
    scenes = sorted(P.get("scenes") or [], key=lambda s: float(s.get("start", 0)))
    for i, sc in enumerate(scenes):
        d = float(sc.get("dur", 0))
        if d < lo - 0.01:
            bad("warn", "a panel is up for less time than the pack allows",
                f"{sc.get('id')} {d}s < {lo}s", "give it more time, or say less on it")
        if d > hi + 0.01:
            bad("warn", "a panel outstays the pack's limit", f"{sc.get('id')} {d}s > {hi}s",
                "split it, or let it go sooner")
        if i and overlaps(float(scenes[i-1]["start"]), float(scenes[i-1]["start"]) + float(scenes[i-1].get("dur", 0)),
                          float(sc["start"]), float(sc["start"]) + d):
            bad("error", "two panels are on screen at once", f"{scenes[i-1].get('id')} and {sc.get('id')}",
                "they share one card — move one")

    # ---- camera moves
    frames = sorted(P.get("frames") or [], key=lambda f: float(f.get("start", 0)))
    for i, f in enumerate(frames):
        s = float(f.get("start", 0))
        if in_cut(s):
            bad("warn", "a framing move sits inside a cut and will never happen", f"{f.get('id')} at {s}s",
                "move it outside the cut")
        if i and s - float(frames[i-1].get("start", 0)) < 1.2:
            bad("warn", "two framing moves land on top of each other",
                f"{frames[i-1].get('id')} and {f.get('id')}", "leave at least a second and a half between them")
    if frames:
        last = frames[-1]
        if last.get("to") != "full" and dur and dur - float(last.get("start", 0)) > 12:
            bad("warn", "the picture never comes back to full frame",
                f"last move is {last.get('to')} at {last.get('start')}s of {dur}s",
                'add a move with "to":"full" — a framing move holds until the next one')
    if (meta.get("tracks") or {}).get("camera") and not frames:
        bad("warn", "there is a camera track and nothing ever moves it",
            "the speaker will sit in one place for the whole video", "run Prepare, or add frames[]")

    # ---- zooms
    zooms = sorted(P.get("zooms") or [], key=lambda z: float(z.get("start", 0)))
    for i, z in enumerate(zooms):
        s = float(z.get("start", 0)); d = float(z.get("dur", 0))
        if d <= 0: bad("error", "a zoom has no duration", str(z.get("id")), "give it one, or delete it")
        for k in ("x", "y"):
            v = float(z.get(k, 0.5))
            if not 0 <= v <= 1:
                bad("error", f"a zoom's {k} is not between 0 and 1", f"{z.get('id')} {k}={v}",
                    "centres are normalised, not pixels")
        if float(z.get("scale", 1.3)) > 2.5:
            bad("warn", "a zoom is very tight", f"{z.get('id')} {z.get('scale')}x",
                "anything past about 2x on 1080p starts to show")
        if i and s - float(zooms[i-1].get("start", 0)) < 1.5:
            bad("warn", "two zooms land within a second and a half", f"{zooms[i-1].get('id')} and {z.get('id')}",
                "space them out")

    # ---- captions
    cues = (P.get("captions") or {}).get("cues") or []
    for i, c in enumerate(cues):
        s, e = float(c.get("start", 0)), float(c.get("end", 0))
        if e <= s: bad("error", "a caption ends before it starts", str(c.get("id")), "fix its timing")
        if i and float(cues[i-1].get("end", 0)) > s + 0.02:
            bad("warn", "two captions overlap", f"{cues[i-1].get('id')} and {c.get('id')}",
                "they will draw on top of each other")
        if not (c.get("tokens") or []): bad("warn", "a caption has no words", str(c.get("id")), "delete it")

    # ---- audio
    audio = P.get("audio") or {}
    for kind in ("music", "sfx"):
        for L in audio.get(kind) or []:
            src = L.get("src")
            if not src:
                bad("warn", f"a {kind} layer has no source", str(L.get("id")), "generate or point it at a file")
            elif not os.path.exists(os.path.join(root, src)):
                bad("error", f"a {kind} file is missing", src, "generate it again, or fix the path")
            if float(L.get("gain", -18)) > 0:
                bad("warn", f"a {kind} layer is boosted above unity", f"{L.get('id')} {L.get('gain')}dB",
                    "music sits around -18dB under a voice")

    return issues


def check_hand_edits(P, root, bad):
    """Is this still the edit the user made?

    A different question from the rest of this file. Everything else asks whether the project will
    render correctly; this asks whether the agent, in the course of rewriting it, dropped
    something a person did by hand. The app records those in .cutright/handoff.json at the moment
    it hands the project over, which is the last point they are known to be intact.

    Silent about anything the agent ADDS or re-times of its own — that is its job. It speaks up
    only when a hand edit is gone, or has moved far enough to no longer be doing its job.
    """
    path = os.path.join(root, ".cutright", "handoff.json")
    if not os.path.exists(path): return
    try:
        with open(path) as f: before = json.load(f)
    except Exception:
        return                       # an unreadable snapshot is not the project's fault

    tol = {"cuts": 0.25, "zooms": 1.0, "frames": 1.0, "scenes": 1.5, "overlays": 1.5}
    for kind, items in (before.get("lists") or {}).items():
        now = P.get(kind) or []
        for was in items:
            still = next((e for e in now if e.get("id") and e.get("id") == was.get("id")), None)
            where = f'at {float(was.get("start", 0)):.1f}s'
            if still is None:
                bad("error", f"a {kind[:-1]} you made by hand is gone",
                    f'the {kind[:-1]} {where} is not in the project any more',
                    "run Check in the app and press “Put back”, or re-add it — do not just render")
                continue
            t = tol.get(kind, 1.0)
            if abs(float(still.get("start", 0)) - float(was.get("start", 0))) > t:
                bad("error", f"a {kind[:-1]} you made by hand has moved",
                    f'it was {where}, it is now at {float(still.get("start", 0)):.1f}s',
                    f"put it back within {t}s of where it was, or leave it where the user placed it")
            if kind == "cuts" and abs(float(still.get("end", 0)) - float(was.get("end", 0))) > t:
                bad("error", "a cut you made by hand no longer removes the same span",
                    f'{where}: it ended at {float(was.get("end", 0)):.1f}s, now {float(still.get("end", 0)):.1f}s',
                    "restore the original end, or ask before changing what a hand-made cut removes")

    cues = (P.get("captions") or {}).get("cues") or []
    def key(c): return "%.2f|%s" % (float(c.get("start", 0)), " ".join(t.get("t", "") for t in (c.get("tokens") or []))[:40])
    for was in before.get("captions") or []:
        still = next((c for c in cues if key(c) == was.get("key")), None)
        if still is None:
            bad("error", "a caption you edited by hand is gone",
                f'the cue "{(was.get("text") or "")[:40]}" is not there any more',
                "restore the cue, or leave hand-edited captions alone")
            continue
        o = still.get("overrides") or {}
        if was.get("cy") is not None and o.get("cy") != was.get("cy"):
            bad("warn", "a caption height you set was overwritten",
                f'"{(was.get("text") or "")[:30]}" was at y={was.get("cy")}, now {o.get("cy")}',
                "put the height back, or change the default rather than the cue")
        if was.get("fontsize") is not None and o.get("fontsize") != was.get("fontsize"):
            bad("warn", "a caption size you set was overwritten",
                f'"{(was.get("text") or "")[:30]}" was {was.get("fontsize")}px, now {o.get("fontsize")}px',
                "put the size back, or change the default rather than the cue")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--project", required=True)
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args()
    P = load(a.project)
    issues = check(P, os.path.dirname(os.path.abspath(a.project)))
    errors = [i for i in issues if i["severity"] == "error"]

    if a.json:
        print(json.dumps({"ok": not errors, "errors": len(errors),
                          "warnings": len(issues) - len(errors), "issues": issues}, indent=1))
    elif not issues:
        print("✓ nothing to fix — no dropped elements, no clashes, panels within the pack's pacing")
    else:
        for i in issues:
            mark = "✗" if i["severity"] == "error" else "!"
            print(f"{mark} {i['what']}: {i['detail']}\n    → {i['fix']}")
        print(f"\n{len(errors)} error(s), {len(issues)-len(errors)} warning(s)")
    sys.exit(1 if errors else 0)

if __name__ == "__main__": main()
