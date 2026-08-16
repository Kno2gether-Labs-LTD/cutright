# Claude Video Editor (Electron desktop app)

An agent-driven desktop video editor: run **Claude Code** in the side terminal → it edits your video →
the edit shows up as an **editable timeline** → you fix cuts / captions / scenes / audio → **Export**.

Everything is driven by one file: **`project.json`** (the edit-as-data model). Claude writes it; the UI
reads/writes it; the render engine turns it back into video. Both the agent and you edit the same data.

Since Phase 0 this is a **real Electron app** — no browser, no local web server. See
[`docs/PHASE0_REPORT.md`](docs/PHASE0_REPORT.md) for what landed and
[`docs/IMPLEMENTATION_PLAN.md`](docs/IMPLEMENTATION_PLAN.md) for what's next.

## Run (dev)
```bash
cd /Users/avijit/video-editor-app
npm install
npm run rebuild                  # node-pty against Electron's ABI (once per Electron upgrade)
WORK=/Users/avijit/Pre_final_edit npm run dev
```
`WORK` = the workspace folder holding `project.json` + `graded_master.mp4` + renders. Without it the app
uses the last folder you picked (**File → Open Workspace…**, `⌘O`).

### Package (unsigned, local proof)
```bash
npm run dist                     # → dist/Claude Video Editor-0.1.0-arm64.dmg
```
Unsigned/ad-hoc-signed: fine on this machine, **not** distributable. Signing + notarization is Phase 1 and
is gated on the accounts listed in `docs/PHASE0_REPORT.md`.

### Self-test (no browser needed)
```bash
npm run smoke                    # launches the app, asserts project/timeline/video/terminal/render, screenshots, exits 0/1
# → out/smoke.json + out/smoke.png
```

## The loop
1. **Terminal** (right): run `claude`, say “edit the video in this folder in the coral/ink/bone style”.
   Claude uses the skills to produce `graded_master.mp4` + `project.json`. The UI reloads automatically
   when `project.json` changes on disk (main watches it with `fs.watch`).
2. **Timeline** (bottom): every decision is an element —
   - **Scenes** track: split-screen explainer scenes (click to edit headline/type/items/timing).
   - **Captions** track: one tick per cue (click to edit text, toggle a word’s highlight, move/resize/recolor).
   - **Cuts** track: ripple cuts that re-time everything downstream.
   - **Audio** track: `+ music` / `+ sfx` layers (or let Claude add ElevenLabs audio — it appears here).
3. **Inspector**: edit the selected element. Saves automatically to `project.json`.
4. **Preview section**: re-renders just the window around the selected element (fast) and plays it.
5. **Export**: renders the full `FINAL.mp4`. Both run off the main thread with live progress + Cancel.

## What you can edit (per element)
- **Captions**: text (fix spelling), which word is highlighted, start/end, **Y position, size, highlight
  colour** — per cue or all cues at once (defaults).
- **Scenes**: headline, type (`pills`/`checklist`/`counter`/`stat`/`strike`), items + colours, start/dur,
  big/sub/target/old/new.
- **Cuts**: **“+ cut at playhead”**, then set start/end (or **“Set start/end = playhead”**). On **Export**
  the range is removed, the video splices, and *all* captions / scenes / audio after it shift earlier
  automatically (a scene straddling a cut is dropped). Preview (`--range`) shows the original timeline.
- **Audio**: **music/SFX** layers (start, duration, gain, fades → mixed + loudnorm on render), or
  **✨ generate (ElevenLabs)** to have `audio_agent.py` create SFX / voiceover / a music bed.

## Architecture (Phase 0)
```
main process            renderer (sandboxed, contextIsolation, strict CSP)
├─ project I/O + watch  ├─ timeline / inspector / preview  (window.editor only)
├─ cve:// media scheme  └─ xterm v6
├─ utilityProcess ──────── render engine (python → ffmpeg) ──MessagePort──> renderer
└─ node-pty ─────────────  login shell / claude  ──IPC──> xterm
```
- `electron/main.js` — app lifecycle, window, IPC, the `cve://` media scheme (HTTP-range streaming of
  workspace files only), project read/save + `fs.watch`, render job spawning, node-pty terminal.
- `electron/preload.cjs` — the **entire** renderer API surface (`window.editor`); no `ipcRenderer`, no
  `require`, no arbitrary channel names.
- `electron/render-worker.cjs` — runs in a `utilityProcess`; owns the python/ffmpeg process tree, tails the
  ffmpeg logs for real progress, has a stall watchdog + cancel, streams events over a MessagePort.
- `electron/smoke.mjs` — the in-app automated test (the Chrome extension can't reach an Electron app).
- `renderer/` — the 3-panel UI (preview · timeline+inspector · terminal). No build step, no bundler.
- `legacy/server.js` — the retired Express prototype, kept for reference only.

The render/audio engine still lives in the `video-edit` skill (`~/.claude/skills/video-edit/scripts`,
Python + Pillow) — single source of truth, shared with standalone skill use. Phase 4 ports it to Node/Skia.

## ⚠️ ffmpeg licensing (blocks any commercial release)
The app currently uses the **system ffmpeg** (`/opt/homebrew/bin/ffmpeg`) in dev and bundles nothing.
Do **not** ship `ffmpeg-static` / gyan / evermeit builds: they are compiled `--enable-gpl` (x264/x265) and
distributing them would force GPL on this whole product. Before any release we must build/obtain a custom
**LGPL** ffmpeg (no x264/x265) relying on hardware encoders (VideoToolbox on macOS, NVENC/QSV on Windows)
and invoke it as a separate child process. See `docs/PHASE0_REPORT.md` § long-lead items.

Note: the machine's ffmpeg is a minimal build (no libass/drawtext) — the engine already works around this
by compositing Pillow PNGs with `overlay`. Don't add `drawtext` filters.

## ElevenLabs audio agent
`~/.claude/skills/video-edit/scripts/audio_agent.py` calls ElevenLabs and writes the result into
`project.json` as an audio layer:
```bash
python3 audio_agent.py sfx   --prompt "whoosh transition" --at 195 --dur 2 --project project.json
python3 audio_agent.py voice --text "Here's the catch" --at 30 --project project.json
python3 audio_agent.py music --prompt "tense cinematic underscore" --start 0 --dur 60 --project project.json
```
Key from `~/.config/kno/elevenlabs.env` (`ELEVENLABS_API_KEY=`) or `$ELEVENLABS_API_KEY`. The ✨ button
runs the same script through `editor.generateAudio()`.

## Security
- Renderer: `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, navigation blocked,
  `window.open` denied (external links go to the system browser), strict CSP (`default-src 'none'`, no
  eval, no remote code). The only exposed API is the named-function bridge in `preload.cjs`.
- The `cve://` scheme refuses any path outside the current workspace, so the page cannot read arbitrary
  files even if it were compromised.
- `project:save` rejects payloads that don't look like a project.
- `node-pty` is a native module and runs your real shell with your environment — treat the app as a local
  dev tool. It is widely used and maintained (Microsoft), but review it as you would any native dep.

## Troubleshooting
- **Terminal doesn't start / `posix_spawnp failed`** — node-pty was built for the wrong ABI or arch. Run
  `npm run rebuild` (`@electron/rebuild`, Electron ABI). On Apple Silicon, a wrong-arch prebuild also needs
  `npm rebuild node-pty --build-from-source`.
- **`claude` not found inside a packaged app** — GUI apps don't inherit your shell `$PATH`. Main calls
  `fix-path` at startup and spawns a **login** shell (`$SHELL -l`); if you use a non-standard install,
  make sure it's on the PATH your login shell sets.
- **Render seems stuck** — the worker emits a `stall` event after 90s without output (shown in the status
  bar) and kills the job after 20 min of total silence. Press **Cancel** to kill the process tree.
