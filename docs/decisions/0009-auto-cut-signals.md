# 0009 — Auto-cut trusts the audio, not the transcript

**Status:** Accepted (2026-08-17)

## Context
"Make the auto cut as perfect as it can be." Two signals are available: ffmpeg
`silencedetect` (measured from the waveform) and the word-level transcript (Whisper).
The first implementation used the transcript as a **veto** — a silence was only cut if no
word overlapped it. On the real test video that produced **one** proposal (0.26s), because
Whisper stretches word boundaries across the pause that follows them: the transcript
claimed "for your business" spanned 55.16–57.81 while ffmpeg measured 55.99–57.76 as
silent at −99 dB. The safety rule was deleting every genuine cut.

## Decision
- **The waveform decides what is audible.** A silence proposal is the detected range shrunk
  by `pad` at both ends (so a breath and the attack of the next word survive), dropped if
  it ends up shorter than `minCut`.
- **The transcript decides what is filler.** Fillers (`um`, `uh`, …), soft fillers
  (`like`, `actually`, opt-in, only when standing alone between pauses) and stutters
  (immediate repeats within 0.6s) come from word timings.
- A word wholly inside a "silent" range does not veto the cut — it lowers its confidence to
  `low` so it is listed but unticked.
- Head/tail dead air (before the first word, after the last) is proposed at high confidence.
- Nothing is applied automatically: proposals are reviewed, auditioned (click to hear) and
  ticked. Applying merges overlapping cuts so the engine never sees nested ranges.

## Consequences
- On the test video this went from 1 proposal (0.26s) to 5 (2.65s), and the test suite now
  **measures each proposed silence with `volumedetect`** — every one comes back at −99 dB.
- The test asserts against the audio, not against the transcript, so it cannot re-enshrine
  the bug it was written to catch.
- Presets (Gentle / Balanced / Tight) map to `minSilence` + `pad` + noise floor.
