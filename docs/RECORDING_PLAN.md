# Recording & auto-zoom — implementation plan

Goal: record your screen and camera inside Cutright, and have the recording *become a project*
— transcribed, briefed, and ready for the agent to edit — with zooms that follow what you were
doing (clicking, typing, or saying something worth landing on).

Reference: **Cap** (CapSoftware/Cap) is the closest product. It is Rust/Tauri, so nothing is
portable to us, but it validates the shape: record → studio editor whose first-class concepts are
*zooms*, backgrounds, trimming and captions → S3-compatible storage the user owns. We take the
model, not the code.

## What the platform actually allows (measured on this Mac, not assumed)

| | |
|---|---|
| Electron / Chromium | 43.4.0 / 150 |
| Screen + window sources | `desktopCapturer` lists both; screen permission already granted |
| Camera | `not-determined` → the app must ask; needs `NSCameraUsageDescription` |
| Microphone | granted; needs `NSMicrophoneUsageDescription` |
| MediaRecorder codecs | `video/mp4;codecs=avc1` **and** webm vp8/vp9/h264 — we can record H.264 mp4 directly |
| Cursor sampling | `screen.getCursorScreenPoint()` — 200 calls in <1 ms, **no permission required** |
| Animated zoom in ffmpeg | `crop` **cannot** animate w/h (evaluated once). `zoompan` can — verified on a real render |

Two consequences worth stating up front:

- **Clicks need a permission we can avoid at first.** macOS only exposes global mouse events to a
  process with Input Monitoring (via a native hook such as `uiohook-napi`). Cursor *position* is
  free. So v1 infers "the user did something here" from dwell + velocity minima, which in a
  tutorial correlates strongly with clicking, and we add true click capture later as an optional
  permission with an obvious payoff.
- **System audio is not available through `desktopCapturer` on macOS.** Chromium does not provide
  it. We record the microphone, and detect a loopback device (BlackHole, Loopback, an aggregate
  device) and offer it as an ordinary input when present. No fake promises in the UI.

## Data model — additions to `project.json`

```jsonc
"recording": {                       // provenance, written by the recorder
  "startedAt": "2026-08-19T…",
  "displays": [ { "width": 2560, "height": 1440, "scale": 1 } ],
  "screen":  "recording/screen.mp4",
  "camera":  "recording/camera.mp4",     // optional
  "cursor":  "recording/cursor.json",    // [{t, x, y, ...}] normalised 0..1
  "events":  [ { "t": 12.4, "type": "click" } ]   // when a hook is available
},
"zooms": [                          // NEW first-class element, like cuts and overlays
  { "id": "z1", "start": 12.2, "dur": 3.0, "x": 0.62, "y": 0.38,
    "scale": 1.8, "ease": "inout", "source": "cursor|transcript|manual" }
]
```

`x`/`y` are **normalised** (0–1) so a zoom survives a resolution change. `scale` 1.0–3.0.
Timings are on the original timeline like everything else, so cuts re-time zooms for free.

## Phases

### R1 — Record, and make it a project
1. **Permissions**: check with `systemPreferences.getMediaAccessStatus`, request camera/mic,
   and for screen show the real system dialog path. Info.plist usage strings via electron-builder.
2. **Source picker**: screens, windows, camera device, mic device, plus a countdown and a
   "what will be recorded" preview.
3. **Capture**: `getUserMedia` with `chromeMediaSource: 'desktop'` for the screen, a second
   stream for the camera, mic mixed into the screen track. `MediaRecorder` → chunks streamed
   over IPC → main appends to disk (never buffer a long recording in memory).
4. **Controls**: start / pause / resume / stop, elapsed timer, a visible recording state, and a
   global stop shortcut so you can stop without hunting for the window.
5. **Cursor track**: main samples position at 60 Hz into `cursor.json` while recording.
6. **On stop → project**: reuse the existing new-project pipeline (normalise to a 1080p master,
   transcribe locally, write `project.json`), then add the `recording` block and open it.

### R2 — Auto-zoom
1. **Engine**: apply `zooms[]` with `zoompan` before the caption pass, easing in/out, honouring
   cuts through the same `remap()` every other element uses.
2. **Proposals**: an analysis pass over the cursor track (dwell, velocity minima, travel to a new
   region) and the transcript (emphasis, "look here", numbers) → candidate zooms.
3. **Review UI**: the auto-cut panel pattern — a list, click to audition, tick, apply.
4. **Agent**: `zooms[]` and the proposal command go into the brief, so "zoom in when I click on
   the deploy button" is something the agent can actually do.

### R3 — Camera and storage
1. **Camera PiP**: composite `camera.mp4` as a rounded inset (position/size/shape in the model).
2. **Storage**: local by default. S3-compatible upload (S3, R2, Supabase, MinIO, B2) declared as a
   capability in the brief and configured with keys in the OS keychain — same pattern as the STT
   providers, so the agent can be told "upload the export" without new app code.

## Status

- **R1 — capture** ✅ recorder window, source picker, countdown, compact bar, pause/mark/stop,
  cursor track, chunk-to-disk writer, project on stop (a recording with no speech still builds,
  just without captions).
- **R2 — auto-zoom** ✅ `zooms[]` renders with exact geometry (`npm run check:zoom` measures it),
  proposals from clicks/dwell/transcript, a Zooms track with a click-to-place centre picker, the
  suggestion review panel, and the brief that tells the agent how to use all of it.
- **R3 — camera and storage** — not started.

### A macOS note worth keeping

`systemPreferences.getMediaAccessStatus('screen')` reports `granted` even when macOS 26 is in fact
refusing to hand over the displays. The reliable signal is `desktopCapturer.getSources()` returning
no `screen:` entries — every Mac has a display, so an empty list means the permission is denied. The
app checks that before you start, and a capture that produces no bytes in its first four seconds is
torn down rather than saved as an unreadable zero-byte file. Both paths point at the exact setting.

## Testing

Recording is hardware- and permission-dependent, so the suite must not require a camera:
- headless-safe: source enumeration, permission reporting, the writer (fed synthetic chunks),
  cursor sampling, project creation from a fixture recording;
- engine: a zoom renders and the frame actually changes at the right time (measured, not assumed);
- proposals: synthetic cursor tracks with known dwells must yield zooms at those timestamps.

### A second macOS note: the keychain can freeze the app for minutes

`safeStorage.isEncryptionAvailable()` and `safeStorage.decryptString()` both READ the keychain,
synchronously, on the main process. When the app's code signature has changed since a key was
stored — which is every rebuild of an app that is not Developer ID signed — macOS makes that call
wait. Measured on a packaged build: **584 seconds**, with the whole app frozen and nothing in the
log. It is not a dialog anyone can dismiss; the call simply does not return.

So the keychain is touched at exactly two moments, both of them things the user just asked for:
saving a key and using one. Never to draw a panel, never at startup (a freeze at launch is still
a freeze). `scripts/check-keys.mjs` enforces this against a safeStorage that counts every access.

Signing the app with a Developer ID certificate makes the identity stable and the problem goes
away for everyone who installs a release. Until then, the first save after an update may pause.
