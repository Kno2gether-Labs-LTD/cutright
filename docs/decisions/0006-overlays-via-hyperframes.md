# 0006 — Motion graphics = `overlays[]` of alpha clips, authored in HyperFrames

**Status:** Accepted (2026-08-17)

## Context
The Pillow scene renderer covers the split-screen explainer cards (pills / checklist / counter /
stat / strike) and animates them, but it is a fixed set of templates. Richer motion graphics —
lower thirds, kinetic titles, callouts — need a real layout/animation engine. Both HyperFrames
(HTML → video, already installed and used by the other skills here) and Remotion (React → video)
can produce them.

## Decision
Add a first-class **`overlays[]`** array to `project.json` and composite it in the render engine:

```json
"overlays": [
  { "id": "lower3", "src": "overlays/lower_third.mov", "start": 38.5, "dur": 4.0, "x": 0, "y": 0 }
]
```

Any clip **with an alpha channel** works — the engine just composites it (`overlay` filter, same
cut/re-time rules as scenes, `enabled: false` to mute one). **HyperFrames is the recommended
authoring path** (`npx hyperframes render --format mov` → ProRes 4444 with alpha; `--format
png-sequence` also works). Remotion would fit the same slot; it is not adopted because HyperFrames is
already installed, already skill-driven, and rendered this in ~9 seconds.

## Consequences
- The agent can now author motion graphics as HTML and place them on the timeline as data — no engine
  change per design.
- The app shows an **Overlays** track with a picker, start/dur/x/y and enable/disable.
- Verified: a coral/ink/bone lower-third rendered in HyperFrames composites correctly over the graded
  footage *and* survives a ripple cut re-time.
- Overlays are rendered assets, not live HTML: changing the text means re-rendering the composition.
  Fine for now; a "re-render this overlay" button is a later convenience.

## Reversing it
`overlays[]` is additive — projects without it are unchanged. Dropping the feature means deleting one
block in `render_project.py` and one track in the UI.
