# Cutwright

An **agent-driven desktop video editor**. The edit is data — one `project.json` that both you
and an AI agent read and write — and the render is a deterministic function of it. Run
`claude` in the side terminal and it edits the same timeline you're looking at.

Apache-2.0. macOS today, Windows code paths present but untested.

![Cutwright](build/icon.png)

## What it does

**Edit by reading.** Open the transcript, select a rambling sentence, press Delete — the video
is cut there, and every caption, scene, overlay and audio layer after it re-times automatically.

**Auto-cut.** One click finds dead air (measured from the waveform, not guessed), filler words
and stutters, and proposes them for review. Click any proposal to hear it before you accept it.

**Captions that look designed.** Word-by-word highlight captions with per-cue position, size and
colour — and colour emoji 🚀 inline.

**Templates.** A template gives the project its look and brings motion-graphics presets —
lower thirds, title cards, callouts — which render with your text straight onto the timeline.
Packs are folders: the two bundled ones use HyperFrames, and a template can bring Remotion
instead. Drop a folder in the templates directory and it appears in the picker.

**Looks and transitions.** Film / warm / cool / teal-orange / bleach / noir / VHS, plus grain,
vignette and bloom — applied at render time, so they never touch your master and you can change
your mind. Cuts can carry a crossfade, dip, whip, wipe or pixelize instead of a hard splice.

**Transcription.** Whisper locally (no key, nothing leaves the machine) or OpenAI / ElevenLabs
remotely with a key stored in the OS keychain. Rebuilds the captions from the new transcript.

**Generated audio.** ElevenLabs SFX, voice and music layers, mixed and loudness-normalised.

**The agent.** `claude` runs in the terminal with the workspace as its working directory. When it
edits `project.json`, the UI reloads — without clobbering an edit you're in the middle of.

**New here?** Read [`docs/GETTING_STARTED.md`](docs/GETTING_STARTED.md) — it explains the one
concept that matters (a project is a folder), how to start an edit from a raw recording, and the
four things worth trying first. The app shows a guided tour on first launch
(**Help → Show Me Around** replays it).

## Run it

```bash
git clone <repo> && cd cutwright
npm install
npm run rebuild                  # node-pty against Electron's ABI (once per Electron upgrade)
npm run dev                      # or: WORK=/path/to/workspace npm run dev
```

First launch offers two ways in: **Start from a video…** (pick a recording — Cutwright builds the
1080p master, transcribes it locally and opens the timeline) or **Open an existing project…**.
The folder chip in the top-left is the project switcher afterwards.

### Requirements
- **ffmpeg + ffprobe** — `brew install ffmpeg` (macOS) or `winget install ffmpeg` (Windows)
- **Python 3 + Pillow** — `python3 -m pip install --user Pillow`
- optional: `claude` (the agent terminal), an ElevenLabs key for generated audio

The app checks all of these on launch and tells you exactly what's missing
(**Help → Check Environment…**). It deliberately **does not bundle ffmpeg** — see below.

### Build an installer
```bash
npm run dist                     # → dist/Cutwright-0.1.0-arm64.dmg
npm run smoke                    # the full self-test: 35 assertions, screenshots, exits 0/1
```

## Keyboard

| | |
|---|---|
| `space` | play / pause |
| `←` `→` | one frame (hold shift for a second) |
| `S` | cut at the playhead · `⌫` delete selection |
| `D` | transcript editor · `A` auto-cut · `T` templates · `L` look |
| `+` `−` `F` | zoom in / out / fit |
| `P` `E` | preview section / export |

## How it's built

```
main process                     renderer (sandboxed, contextIsolation, strict CSP)
├─ project I/O + fs.watch        ├─ timeline · inspector · transcript editor · panels
├─ cve:// media scheme (Range)   └─ xterm v6            (window.editor bridge only)
├─ utilityProcess: render ───────── engine/render_project.py → ffmpeg ──MessagePort──▶
├─ utilityProcess: analysis ────── silencedetect + transcript → cut proposals
├─ utilityProcess: transcribe ──── whisper / OpenAI / ElevenLabs
├─ utilityProcess: templates ───── HyperFrames | Remotion → alpha clip
└─ node-pty ─────────────────────  claude
```

- `electron/` — main, preload (the entire renderer API), and one worker per long job.
- `engine/` — the render engine (Python + Pillow + ffmpeg). Ships with the app; the
  `video-edit` skill keeps an identical copy for standalone use (`npm run sync-engine`).
- `renderer/` — the UI. No bundler, no framework, no build step.
- `templates/` — bundled template packs (`templates/README.md` documents the format).
- `docs/decisions/` — why things are the way they are. Read this before changing them.

Every long job runs in its own process, streams progress over a MessagePort straight to the
window, and can be cancelled — a hung render can never take the app down.

## ⚠️ ffmpeg licensing

Cutwright ships **no** ffmpeg binary. Prebuilt distributions (ffmpeg-static, gyan, evermeet,
most Homebrew bottles) are `--enable-gpl` builds containing x264/x265; redistributing one inside
this Apache-2.0 app would put the whole distribution under the GPL. We invoke whatever ffmpeg the
user installed, as a separate process. If a future release wants one-click install, it needs a
custom **LGPL** build (no x264/x265, hardware encoders only) — see
[`docs/decisions/0003`](docs/decisions/0003-ffmpeg-not-bundled.md).

## Testing

`npm run smoke` launches the real app and drives the real UI: 35 assertions covering every
feature — editing round-trips to disk, auto-cut proposals verified against the actual audio with
`volumedetect`, a real transcription, both template engines producing alpha, a full export whose
duration matches the ripple maths exactly, cancel leaving no stray processes, and the security
boundary (`cve://` refusing files outside the workspace, no Node in the renderer).

## Security

`contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, navigation and `window.open`
blocked, strict CSP with no eval and no remote code. The renderer's only capability is the named
functions in `electron/preload.cjs`. The `cve://` scheme refuses any path outside the open
workspace. API keys are encrypted with the OS keychain (`safeStorage`) and never returned to the
page. `node-pty` runs your real shell — treat the app as the local dev tool it is.

## Licence

Apache-2.0 — see [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE).
"Claude" and "Claude Code" are trademarks of Anthropic; Cutwright is an independent project that
integrates with the Claude Code CLI.
