# Requirements — Claude Video Editor (Electron)

Status: draft for the parallel dev session. Companion docs: `ARCHITECTURE.md`, `IMPLEMENTATION_PLAN.md`.

## 1. Vision
A **distributable, cross-platform (macOS + Windows) desktop video editor** — a CapCut-class app — where
**an AI agent (Claude) does the heavy editing** and the user finishes it on a familiar timeline. It pairs
a real NLE timeline with an agent that can cut, caption, style, generate B-roll/music, and assemble a
finished video from a raw recording — driven from a side terminal now, a chat panel later.

The differentiator vs CapCut/Descript: **the edit is data** (`project.json`) that both the agent and the
UI manipulate, and the render is a deterministic, reproducible engine. Anything the agent does, the user
can see and tweak; anything the user does, the agent can read and build on.

## 2. Users & use cases
- **Creator / talking-head (primary, today):** shoot a video, agent produces a finished styled edit
  (grade + captions + explainer scenes + cuts + music), user tweaks and exports for YouTube/social.
- **Short-film / movie editor (expansion):** multi-track timeline with **multiple audio layers**
  (dialogue, ambience, score, SFX), B-roll/overlays, transitions — needs real NLE depth, not just captions.
- **Repurposer:** long recording → several short clips in different styles (style packs).

## 3. Principles
1. **Edit-as-data.** One `project.json` is the source of truth (captions, scenes, cuts, tracks, media,
   audio). Agent and UI both read/write it. Render is a pure function of it.
2. **Deterministic, reproducible render.** Same project → same output. HW-accelerated where possible.
3. **Agent + manual, same model.** No hidden state the agent can't see or the user can't edit.
4. **Non-destructive.** Sources untouched; edits are references + parameters.
5. **Local-first, private.** Media and render stay on the user's machine; only generation APIs go out.
6. **Extensible via style packs & skills.** New looks/templates = data + renderers, not core rewrites.

## 4. Functional requirements

### 4.1 Project & media
- Create/open/save projects (`.cvep` = folder with `project.json` + media + renders + cache).
- Import media: video, audio, image (drag-drop + file dialog). Probe metadata; generate proxies/thumbnails.
- Non-destructive: originals referenced by path + hash; relink on move.

### 4.2 Timeline (multi-track NLE)
- Tracks: **video/overlay**, **text/caption**, **audio (N layers)**. Add/remove/reorder/lock/mute/solo.
- Clip ops: trim (edge drag), split at playhead, ripple-delete (the current "cut"), move, snap to
  clips/playhead/markers, per-clip enable.
- Frame-accurate scrubbing + playhead; zoom in/out; markers; selection + multi-select.
- **Waveforms** on audio tracks; thumbnails on video tracks.
- Undo/redo (history over `project.json` mutations).

### 4.3 Captions
- The current **highlight** style (rounded sans, white + coral highlight word) and **caps** style, plus
  new styles via packs. Per-cue: text, emphasis word(s), timing, **position, size, color, highlight**;
  global defaults. Auto-generate from transcript (Whisper); edit inline; spell-fix.

### 4.4 Scenes / templates (style packs)
- Split-screen explainer scenes (pills/checklist/counter/stat/strike) in the **coral/ink/bone** system;
  **Sabri** pack; user-selectable per project (`meta.style`). Add/edit/reorder scenes; live preview.
- Template marketplace-style extensibility (later): a pack = design tokens + scene/caption renderers.

### 4.5 Cuts / re-timing
- Ripple cuts that re-time all downstream captions/scenes/audio (already working in the engine).
- Silence/filler detection to propose cuts (transcript + `silencedetect`); accept/reject in UI.

### 4.6 Audio (multi-layer)
- Multiple music + SFX + VO layers, each with start/dur/gain/fades; mix + loudnorm on render; ducking of
  music under VO.
- **Auto-insert SFX/music from the transcript / video "story"**: agent analyzes the transcript + scene
  beats and proposes a score — a music bed per section (mood-matched) and SFX on reveals/transitions/cuts;
  user reviews on the timeline. Generation via **ElevenLabs** (SFX/voice/music) and/or a licensed library.
- Manual: import audio, place on a layer, adjust.

### 4.7 AI media generation (image / B-roll / video)
- Generate stills, B-roll, and short video clips from prompts and insert them as timeline clips.
- Providers: **Higgsfield** (image/video), **ElevenLabs** (audio), extensible. Long-running async jobs
  with progress + download; generated media cached in the project.
- Agent can auto-suggest B-roll for a spoken concept ("show a factory here") and place it; user approves.

### 4.8 Agent experience
- **Now:** embedded terminal running `claude` (the CLI); it edits `project.json`; UI hot-reloads.
- **Later:** a **chat panel** (agent SDK) with tool-buttons ("caption this", "add B-roll", "tighten to
  6 min", "score it"), streaming, and inline diffs of what it changed on the timeline.
- Agent tools map to project.json operations + the skills (video-edit, video-style-match, higgsfield, etc.).

### 4.9 Render / export
- Presets: YouTube 1080p/4K, Shorts/Reels 9:16, square; codec/bitrate/fps; loudness target.
- Full export + fast **section preview** (range render). Progress + cancel. HW encode.
- Publish handoff (YouTube/social) via existing skills.

## 5. Non-functional
- **Performance:** smooth timeline at 60fps UI; scrubbing via proxies/WebCodecs; renders HW-accelerated.
- **Cross-platform parity:** macOS (Apple Silicon + Intel) and Windows x64; same features.
- **Reliability:** never lose a project (autosave + versioned history); crash-proof render jobs (watchdog).
- **Security:** contextIsolation on; no arbitrary remote code; API keys in OS keychain; agent runs in a
  scoped workspace.
- **Distribution:** signed + notarized installers; auto-update.

## 6. Out of scope (initial releases)
- Real-time collaboration / cloud projects. Mobile. Full keyframe/curve animation editor (scenes are
  parameterized templates, not a freeform motion editor). Color-grading scopes/wheels (grade is a filter
  + LUT for now). These are post-1.0.

## 7. Success criteria (v1)
- Import a raw recording → agent produces a finished coral/ink/bone edit → user fixes a caption, adds a
  cut, adds a music bed, and exports a signed-quality 1080p mp4 — entirely in the app, cross-platform,
  from a signed installer with auto-update.
