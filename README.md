# Claude Video Editor (local)

A terminal-driven AI video editor: run **Claude Code** in the side terminal → it edits your video
(loading the `video-style-match` skills) → the edit shows up as an **editable timeline** → you fix
cuts / captions / scenes / audio → **Export**.

Everything is driven by one file: **`project.json`** (the edit-as-data model). Claude writes it; the UI
reads/writes it; `render_project.py` turns it back into video. Both the agent and you edit the same data.

## Run
```bash
cd /Users/avijit/video-editor-app
npm install            # express, ws, node-pty (native — see Security)
WORK=/Users/avijit/Pre_final_edit npm start
# open http://localhost:4599 in your browser
```
`WORK` = the folder holding `project.json` + `graded_master.mp4` + renders (defaults to `Pre_final_edit`).

## The loop
1. **Terminal** (right): run `claude`, say “edit the video in this folder in the coral/ink/bone style”.
   Claude uses the skills to produce `graded_master.mp4` + `project.json`. (The UI auto-reloads when
   `project.json` changes on disk.)
2. **Timeline** (bottom): every decision is an element —
   - **Scenes** track: split-screen explainer scenes (click to edit headline/type/items/timing).
   - **Captions** track: one tick per cue (click to edit text, toggle a word’s highlight, move/resize/recolor).
   - **Audio** track: `+ music` / `+ sfx` to add layers (or let Claude add ElevenLabs audio — it appears here).
3. **Inspector** (below timeline): edit the selected element. Saves automatically to `project.json`.
4. **Preview section**: re-renders just the window around the selected element (fast) and plays it.
5. **Export**: renders the full `FINAL.mp4`.

## What you can edit (per element)
- **Captions**: text (fix spelling), which word is highlighted, start/end, **Y position, size, highlight
  colour** — per cue or all cues at once (defaults).
- **Scenes**: headline, type (`pills`/`checklist`/`counter`/`stat`/`strike`), items + colours, start/dur,
  big/sub/target/old/new. Delete or (via Claude) add new ones.
- **Cuts** (trim/re-cut): add a cut with **“+ cut at playhead”**, then set its start/end (or **“Set
  start/end = playhead”**). On **Export** the range is removed, the video splices, and *all* captions /
  scenes / audio after it shift earlier automatically (a scene straddling a cut is dropped). Preview
  (`--range`) shows the original timeline, so use Export to see cuts applied.
- **Audio**: add **music/SFX** layers (start, duration, gain, fades → mixed + loudnorm on render), or
  hit **✨ generate (ElevenLabs)** to have `audio_agent.py` create an SFX / voiceover / music bed and add
  it to the timeline for you to finalize.

## ElevenLabs audio agent
`scripts/audio_agent.py` calls ElevenLabs and writes the result into `project.json` as an audio layer:
```bash
python3 scripts/audio_agent.py sfx   --prompt "whoosh transition" --at 195 --dur 2 --project project.json
python3 scripts/audio_agent.py voice --text "Here's the catch" --at 30 --project project.json
python3 scripts/audio_agent.py music --prompt "tense cinematic underscore" --start 0 --dur 60 --project project.json
```
Key from `~/.config/kno/elevenlabs.env` (`ELEVENLABS_API_KEY=`) or `$ELEVENLABS_API_KEY`. SFX =
`/v1/sound-generation`, voice = `/v1/text-to-speech`, music = `/v1/music` (best-effort; falls back to a
long SFX). Claude can run these in the terminal — the clips then appear on the Audio track. (In the UI, the
✨ button hits `POST /api/audio` which runs the same script.)

## Architecture
- `server.js` — Express + ws. Serves the UI, `project.json` (GET/POST), the video (HTTP range),
  `/api/render` (SSE progress, spawns `render_project.py`), and a **PTY websocket** running your shell/`claude`.
- `scripts/build_project.py` — converts an edit’s artifacts (transcript + scenes + grade) → `project.json`.
- `scripts/render_project.py` — renders `project.json` → video (honors caption overrides, scenes, audio;
  `--range a b` for fast preview). Calls the `video-style-match` skill renderers.
- `public/` — the 3-panel UI (preview · timeline+inspector · terminal), no build step.

## Future: style templates
Each editing style is a **skill + style pack** (e.g. `sabri-suby.json`, the coral/ink/bone system). A
project picks a style (`meta.style`); adding a template = adding a pack + its scene/caption renderers.
The editor stays the same — it just edits whatever `project.json` the chosen style produced.

## Troubleshooting
- **`Error: posix_spawnp failed` on connecting the terminal** — `npm install` fetched the wrong-arch
  node-pty prebuild (x86_64) for an Apple-Silicon (arm64) Mac. Fix once:
  ```bash
  npm rebuild node-pty --build-from-source   # builds arm64 spawn-helper + pty.node
  ```
  The server also no longer crashes on a terminal error (it falls back to a basic shell), but the
  `claude` TUI needs a real pty, so the rebuild is what you want.
- **Blank/error page in the claude-in-chrome automation** — that extension needs site permission for
  `localhost`; it's unrelated to the app (curl gets HTTP 200). Grant it (see below) or just use the app
  in a normal browser tab.

## Security
`node-pty` is a native module (compiles on install) and is a widely-used, reputable package — but it *is*
third-party. Review it before trusting it (per the “vet public packages” rule). The terminal it powers runs
your real shell with your environment, so treat the app as you would a local dev tool. Express + ws are
pure-JS and standard.
