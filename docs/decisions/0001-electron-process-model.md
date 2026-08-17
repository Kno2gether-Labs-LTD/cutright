# 0001 — Electron process model

**Status:** Accepted (2026-08-16) · **Phase:** 0

## Context
The prototype was an Express server + browser tab: HTTP for project.json, an SSE endpoint that
spawned the Python renderer, a `/api/video` range handler, and a websocket to node-pty. Shipping
that as a desktop app means deciding where each of those lives in Electron's process model, and
ffmpeg is the hard part — a multi-minute encode on the main thread freezes every window, and in
the renderer it freezes the UI.

## Decision
- **All server handlers collapse into main-process IPC.** No localhost server ships with the app.
- **Renders run in a `utilityProcess`**, one per job, which owns the whole child tree
  (python → ffmpeg) and is spawned `detached` so Cancel can kill the *process group*.
- **Progress flows renderer ↔ utilityProcess over a `MessageChannelMain` port pair**; main is not
  in the data path. The port itself stays in the preload's isolated world — the page only ever
  receives plain structured-cloned events.
- **Local media is served by a privileged `cve://` scheme** that implements HTTP Range itself.
  `file://` gives no 206 responses, and Chromium needs them to seek inside a multi-GB mp4.
- **Security is non-negotiable:** `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`,
  a narrow named-function `contextBridge` (never raw `ipcRenderer`), strict CSP, navigation and
  `window.open` blocked. Tested: the renderer has no `require`/`process`/`module`.

## Consequences
- A hung or crashed render can never take down the window; the watchdog (90s stall warning, 20 min
  idle kill, 4h hard cap) reports rather than hangs.
- Progress is derived by tailing the engine's per-pass ffmpeg logs, because the Python engine writes
  each pass to its own log file rather than a single stdout. When the engine is ported to Node
  (see [0005](0005-keep-python-engine-for-now.md)) this becomes a direct `-progress` stream; the
  renderer-facing event contract does not change.
- Anything the renderer needs from disk must be added deliberately to the bridge — which is the point.

## Reversing it
The engine boundary is a message contract (`start` / `progress` / `done`), so the worker can be
replaced wholesale. Dropping the `cve://` scheme would mean giving up frame-accurate seeking on
large files, so it should not be reversed.
