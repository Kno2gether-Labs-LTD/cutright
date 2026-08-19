"""How long a panel should stay up.

A scene's duration is not a number someone should be typing. It is the answer to two questions:
how long does this take to read, and how long is the speaker still talking about it? Whichever is
longer wins, bounded by the template's taste.

Used by the preprocess pass (to propose durations) and by the app (to show why).
"""

# Reading speed for on-screen text set large. Deliberately slower than prose reading: a viewer is
# listening at the same time, and the panel is not the only thing moving.
WORDS_PER_SECOND = 2.2
NOTICE = 0.45          # a beat before anyone starts reading at all
AFTER = 0.35           # a beat after the last word before it goes


def reading_time(scene, wps=WORDS_PER_SECOND):
    """The floor: long enough to read what is on it."""
    text = [scene.get("headline") or "", scene.get("big") or "", scene.get("sub") or "",
            scene.get("old") or "", scene.get("new") or ""]
    for it in scene.get("items") or []:
        text.append(it if isinstance(it, str) else (it.get("text") or ""))
    words = sum(len([w for w in str(t).split() if w]) for t in text)
    return NOTICE + words / max(0.5, wps) + AFTER


def spoken_span(start, words, gap=1.6, limit=None):
    """How long the speaker keeps talking from `start` without a real break.

    The panel belongs to a passage, not a timestamp: it should come down when the subject changes,
    which in a transcript looks like a gap. Returns None when there is nothing to go on.
    """
    if not words: return None
    run = [w for w in words if float(w.get("end", 0)) > start]
    if not run: return None
    end = max(start, float(run[0].get("end", start)))
    for w in run:
        s = float(w.get("start", 0))
        if s - end > gap: break                      # a pause long enough to be a new thought
        end = max(end, float(w.get("end", s)))
        if limit and end - start >= limit: break
    span = end - start
    return span if span > 0.3 else None


def panel_duration(scene, words=None, pacing=None):
    """What a panel's duration should be, and why — the reason is shown in the app."""
    p = dict(minPanel=2.4, maxPanel=8.0, wordsPerSecond=WORDS_PER_SECOND, followSpeech=True)
    p.update(pacing or {})

    read = reading_time(scene, p["wordsPerSecond"])
    spoken = spoken_span(float(scene.get("start", 0)), words or [], limit=p["maxPanel"]) \
        if p.get("followSpeech") else None

    if spoken and spoken > read:
        dur, why = spoken, "as long as the speaker stays on it"
    else:
        dur, why = read, "long enough to read"

    clamped = max(p["minPanel"], min(p["maxPanel"], dur))
    if clamped != dur:
        why += f" (held to the pack's {p['minPanel']:g}–{p['maxPanel']:g}s)"
    return round(clamped, 2), why
