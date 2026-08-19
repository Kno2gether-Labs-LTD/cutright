# The pipeline, and where the gaps are

The intended flow, and what actually exists today.

| # | Step | Today |
|---|------|-------|
| 1 | **Record** — screen, camera, mic | ✅ screen and camera are captured to **separate files** (`recording/screen.mp4`, `recording/camera.mp4`), cursor sampled at 60 Hz |
| 2 | **Transcribe + mark cuts** | ✅ local Whisper; auto-cut reads the waveform (`silencedetect`) and the word-level transcript (fillers, stutters) |
| 3 | **Template + grade** | ✅ template packs set caption style, scene types, overlay presets; looks and audio polish are separate |
| 4 | **Preprocess — one action that does 2 and 3 and writes it all down** | ✅ **Prepare** in the toolbar: transcribe → cut → decide who has the frame → apply the pack → size the panels, every decision written into `project.json` with its reason |
| 5 | **Final edit — motion graphics, music, SFX** | ⚠️ the agent does this from the brief; audio generation exists but is not part of a flow |
| 6 | **Agent verification** | ✅ `engine/verify_project.py` — the mistakes only a render would otherwise reveal, each with what to do about it. **Check** in the toolbar; the agent is told to run it before saying it is finished |
| 7 | **Layered save, then render** | ❌ the render is flattened |

## The camera is a track

A recording with a camera writes `meta.tracks`:

```json
"tracks": { "screen": "graded_master.mp4", "camera": "recording/camera.mp4",
            "cameraHome": { "to": "corner", "shape": "circle", "size": 0.24, "corner": "br" } }
```

The screen is the picture underneath; the camera is what framing moves. So `"to": "full"` means
**the speaker fills the frame and the screen disappears behind them** — which is what you want
while an idea is being explained rather than demonstrated. Cuts are applied to both tracks, or the
speaker drifts out of sync with their own voice from the first cut onwards.

Preprocess decides those moments by measuring, not guessing: consecutive frames of the screen are
differenced, and a stretch where nothing changes (while someone is still talking) becomes a move to
full and a move back. Each one records why: `"why": "nothing changing on screen for 12s"`.

## The two-pass shape

The user's model, which matches how the engine already works:

**Pass one — structural.** Read the transcript and the frames. Decide what to cut, when the
speaker should be full-frame, when they should be a panel beside a graphic, and where the beats
are. All of it written into `project.json`. Nothing rendered.

**Pass two — craft.** Grade, motion graphics, camera moves, music and SFX, placed against the
structure pass one wrote.

This is why the edit is data: pass one is cheap and re-runnable, pass two is expensive. A wrong
decision in pass one is a JSON edit, not a re-render.

## How long a panel stays up

Not a fixed number. A panel is up for as long as what it shows is worth reading, and no longer:

- **a floor**: the reading time of its own text (~2.2 words/second plus a beat to notice it);
- **the content**: the transcript span that talks about it — the panel goes when the subject does;
- **a ceiling**: the template's `pacing.maxPanel`, because a static panel outstays its welcome.

Templates carry these numbers (`pacing`), so a fast tutorial pack and a slow explainer pack differ
without anyone editing a scene by hand.
