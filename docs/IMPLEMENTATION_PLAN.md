# Implementation Plan — Claude Video Editor (Electron)

Phase-wise plan for the parallel dev session. Read with `REQUIREMENTS.md` + `ARCHITECTURE.md`.
We start from the working web-app prototype (`~/video-editor-app`): Node/Express + browser UI + the
`video-edit` skill render engine + `project.json` + node-pty terminal. Goal: a signed, auto-updating,
cross-platform CapCut-class editor with an AI agent.

## How to read this
Each phase: **Goal · Tasks · Deliverable · Acceptance · Depends on**. Phases 0–1 are foundational; several
later phases can run in parallel (noted). Estimates assume 1–2 devs and are rough.

---

## ⏱ Start IMMEDIATELY (long-lead, gate the launch — do in parallel with Phase 0)
1. **LGPL ffmpeg build.** Produce/obtain a custom **LGPL** FFmpeg (no `--enable-gpl`, no x264/x265) with
   hardware encoders (`videotoolbox` mac; `nvenc`+QSV/`libvpl` Windows) for both arches. **Blocks any
   commercial release** — stock ffmpeg-static is GPL. (Owner task; ~days.)
2. **Apple Developer Program** ($99/yr) — enroll now; needed for Developer ID + notarization.
3. **Windows signing eligibility.** Apply for **Azure Trusted Signing** (~$10/mo) — requires an
   established legal entity (often 3+ yrs) + org verification and is country-limited; if ineligible, buy an
   **OV** token cert (~$200–500/yr). Post-2023 keys must be on HSM. **This gates your first signed Windows
   release — start the verification now.**
4. Decide release host for auto-update (private **S3/Spaces** recommended; or GitHub Releases).

---

## Phase 0 — Electron shell & migration (foundation)
**Goal:** the current app running as a real Electron window, cross-platform, secure, ffmpeg off-main.
**Tasks:**
- Scaffold Electron (electron-builder). Move the Express handlers into **main-process IPC** (project
  get/save, video serve → local file, render, audio-gen). Keep the render engine as-is (Python) for now.
- Run ffmpeg/render in a **`utilityProcess`**; stream `-progress` to the renderer over a MessagePort.
- Port the terminal: `@xterm/xterm` v6 + `node-pty` (**`@electron/rebuild`** + **`asarUnpack`**), add
  **`fix-path`** + login-shell spawn so `claude` resolves in a packaged app.
- Security pass: contextIsolation + sandbox + nodeIntegration:false + narrow contextBridge + CSP.
- Move the existing UI (`public/`) into the renderer; wire IPC in place of `fetch`.
**Deliverable:** `npm run dev` opens the editor as an Electron app on mac + Windows; timeline, preview,
terminal, render all work via IPC.
**Acceptance:** load the grants `project.json`, render a range preview, run `claude` in the terminal —
all inside Electron, no external server. **Depends on:** nothing.

## Phase 1 — Distribution pipeline (do EARLY, parallel with Phase 2)
**Goal:** signed, notarized, auto-updating installers on both OSes.
**Tasks:**
- electron-builder targets: `.dmg`, NSIS `.exe`. Bundle the **LGPL ffmpeg** via `asarUnpack`/`extraResources`
  (per-arch glob); resolve packaged paths.
- macOS: Developer ID sign + **notarytool** (`@electron/notarize`) + hardened runtime + staple; entitlements
  (`allow-jit`, `disable-library-validation`); **sign the ffmpeg sidecar**.
- Windows: sign via Azure Trusted Signing (or OV token) in CI.
- **electron-updater** → private S3/Spaces; wire update-check + download + install-on-quit UI.
**Deliverable:** downloadable signed installers that auto-update.
**Acceptance:** fresh install on a clean mac + Windows launches without Gatekeeper/SmartScreen blocks
(mac) / with expected reputation ramp (Windows); a bumped version auto-updates. **Depends on:** Phase 0 +
the long-lead items.

## Phase 2 — Timeline & preview core (parallel with Phase 1)
**Goal:** a real multi-track NLE timeline + frame-accurate preview.
**Tasks:**
- Extend `project.json` to **`tracks[]`** (video/overlay, caption, N audio), each `clips[]`; migrate the
  current flat captions/scenes into tracks with back-compat.
- Build the **custom DOM/React timeline** bound to the model: zoom, playhead, markers, multi-select,
  snapping; per-track lock/mute/solo. (Study OpenCut.)
- **WebCodecs** preview (`VideoDecoder`→canvas) for frame-accurate scrub; **ffmpeg proxies** for heavy
  media (generate on import in the PROXY utilityProcess).
- **wavesurfer.js v7** waveforms with pre-computed peaks (audiowaveform/ffmpeg).
- **Undo/redo** as history over `project.json` mutations (command pattern).
**Deliverable:** scrub, zoom, select, and see waveforms/thumbnails on a multi-track timeline.
**Acceptance:** open a 30-min project; scrub frame-accurately; undo/redo any edit. **Depends on:** Phase 0.

## Phase 3 — Editing depth
**Goal:** the core edit operations users expect.
**Tasks:** clip **trim/split/move/ripple-delete** with snapping; the **cuts** model (ripple re-time — the
engine already does this, expose it as UI clip ops); caption inspector (text/emphasis/position/size/color —
already built, port to Electron); scene inspector + reorder + live thumbnail; **silence/filler detection**
(transcript + `silencedetect`) → proposed cuts to accept/reject.
**Deliverable:** trim/split/cut/caption/scene edits, all reflected in `project.json` and re-render.
**Acceptance:** import a raw clip, remove filler + a bad take via ripple cuts, fix a caption, reorder a
scene, export — matches preview. **Depends on:** Phase 2.

## Phase 4 — Render engine port (Python → Node) — parallel, keep Python until parity
**Goal:** drop the Python sidecar (removes the notarization minefield).
**Tasks:** reimplement caption + scene compositing on **`@napi-rs/canvas`** (Skia) (or `sharp`); keep
ffmpeg orchestration (grade/overlay/splice/mix/encode) in Node; frame-parity tests vs the Python renderer.
**Deliverable:** `render_project` in pure Node; Python removed from the bundle.
**Acceptance:** Node render is visually identical (within tolerance) to the Python render on the grants
project; installer ships no Python. **Depends on:** Phase 0 (can start anytime; ship when at parity).

## Phase 5 — Audio & story-aware auto-score
**Goal:** multi-layer audio + agent-proposed music/SFX from the story.
**Tasks:** N audio layers with gain/fades/**ducking** (music under VO); waveform-level trim/move; ElevenLabs
**generation** in-app (SFX/voice/music — engine already mixes layers); **auto-score**: agent reads the
transcript + scene beats → proposes a **music bed per section** (mood-matched) + **SFX on
reveals/transitions/cuts** → user reviews on the timeline. Licensed-library option as fallback to gen.
**Deliverable:** a project with a per-section score + reveal SFX, editable on audio tracks.
**Acceptance:** "score this video" produces a mood-appropriate bed + reveal SFX that duck under VO and can
be nudged/replaced. **Depends on:** Phase 2 (tracks) + Phase 3.

## Phase 6 — AI media generation (image / B-roll / video)
**Goal:** generate and insert visual media as clips.
**Tasks:** **durable job queue** (submit→poll w/ backoff→download→proxy→insert; persist across restarts);
**Higgsfield** (via MCP/CLI through the agent + REST for programmatic inserts) + **ElevenLabs**; media pool
UI; agent suggestion ("show B-roll of X here") → generate → place → user approves.
**Deliverable:** generate a still/B-roll/short clip and drop it on the timeline.
**Acceptance:** from a prompt, a generated B-roll clip appears in the media pool and inserts as a clip with
a proxy/thumbnail; a 2-min generation survives an app restart. **Depends on:** Phase 2 + Phase 0 job infra.

## Phase 7 — Agent experience (terminal → chat)
**Goal:** the agentic editing layer.
**Tasks:** keep the **terminal** (`claude`) as the power path; add a **chat panel** (agent SDK) with
tool-buttons ("caption", "tighten to 6 min", "add B-roll", "score it"), streaming, and **inline diffs of
timeline changes**; agent tools = `project.json` ops + the skills. Auto-reload already syncs UI when the
agent edits the project (guard against clobbering fresh local edits — done in the prototype).
**Deliverable:** a chat panel that edits the timeline with visible diffs; terminal still available.
**Acceptance:** "remove all filler and add a hook scene" runs from chat, shows what changed on the
timeline, and is undoable. **Depends on:** Phases 2–3 (needs edit ops to call).

## Phase 8 — Templates, polish, 1.0
**Goal:** shippable product.
**Tasks:** **style-pack system** (coral/ink/bone + Sabri + new packs = design tokens + renderers, selectable
per project; groundwork for a template gallery); export presets (YT 1080p/4K, Shorts 9:16, square);
onboarding + sample project; perf pass (proxy pipeline, timeline at 60fps); crash-proof render jobs
(watchdog); autosave + versioned project history; docs.
**Deliverable:** signed 1.0 with auto-update, templates, presets, onboarding.
**Acceptance:** the v1 success criterion (REQUIREMENTS §7) end-to-end from a signed installer.
**Depends on:** all prior.

---

## Parallelization (for a separate dev session)
- **Track A (foundation → distribution):** Phase 0 → Phase 1 (+ long-lead items). Highest priority.
- **Track B (editor UX):** Phase 2 → Phase 3 → Phase 7. Starts after Phase 0.
- **Track C (engine):** Phase 4 (render port) + Phase 5 (audio) — independent, merge at parity.
- **Track D (AI media):** Phase 6 — after Phase 0 job infra + Phase 2 tracks.

## Cost snapshot
- Apple Developer **$99/yr**; Windows signing **~$10/mo** (Azure Trusted Signing) or **~$200–700/yr** (OV/EV
  token); release hosting (S3/Spaces) a few $/mo; ElevenLabs/Higgsfield usage-based. Custom LGPL ffmpeg =
  build time, not license cost (unless you license x264/x265).

## Two risks to manage from day one
1. **ffmpeg GPL trap** — build/source LGPL ffmpeg *before* shipping commercially, not after.
2. **Windows signing** — HSM key requirement + SmartScreen reputation ramp; begin Azure Trusted Signing
   eligibility/verification well ahead of launch (it gates the first signed release).

## What already exists to reuse (from the prototype/skills)
- `project.json` edit-as-data model + schema (`schema/project.example.json`).
- Render engine (`video-edit` skill): grade (color-match), highlight captions, split-screen scenes, cuts
  with ripple re-time, audio mix, ElevenLabs `audio_agent`. Port these to Node in Phase 4.
- Style packs (`video-style-match`: coral/ink/bone + Sabri) + `extract-style` to derive new looks.
- The 3-panel UI (preview/timeline/inspector/terminal) as the renderer starting point.
- node-pty terminal + the Claude-edits-project.json loop (with the auto-reload race already fixed).
