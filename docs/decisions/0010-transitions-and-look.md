# 0010 — Transitions at cut seams, and looks applied at render time

**Status:** Accepted (2026-08-17)

## Context
Cuts were hard splices (concat with `-c copy`). The ask was "some really nice and smooth
cut sequence and effects" plus film-grade treatment.

## Decision
**Transitions** are a property of a cut: `{"start":…, "end":…, "transition":"crossfade",
"tdur":0.35}`. When any cut carries one, the engine stops using the concat demuxer and
builds an `xfade` + `acrossfade` chain across the kept segments. Types map to ffmpeg xfade
modes (crossfade, dip to black/white, whip/slide, wipe, circle open, smooth, pixelize).

The subtle part: **an xfade of D seconds shortens the timeline by D**, so `make_remap()`
now subtracts the removed range *plus* the transition overlap. Captions, scenes, overlays
and audio layers all re-time through that one function, so they stay in sync. Verified on
a synthetic fixture: 12s − 1s − 1s − 0.4s crossfade = 9.6s, rendered 9.625s (frame rounding).

**Looks** are applied at render time from `grade.look`, on top of the graded master:
presets (film, warm, cool, teal & orange, bleach bypass, noir, VHS) plus grain, vignette
and bloom amounts, and an escape hatch for a raw ffmpeg filter string. Audio gets an
optional polish chain (voice / warm / podcast) before loudnorm.

## Consequences
- Looks are free to change and never destroy the grade — the master is untouched, so the
  decision stays reversible for the life of the project.
- The look costs nothing extra: it rides the caption-overlay pass, which already re-encodes.
- Transitions cost a full re-encode of the cut assembly (no stream copy), so a project with
  many transitions exports slower than one with hard cuts. Accepted.
