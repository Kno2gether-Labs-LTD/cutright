# Architecture — Claude Video Editor (Electron)

Target architecture for the distributable app. Companion: `REQUIREMENTS.md`, `IMPLEMENTATION_PLAN.md`.
We already have ~60% of the shell (Node backend + browser UI + ffmpeg engine + `project.json` model +
node-pty terminal). The Electron move = collapse the server into main, get ffmpeg off the main thread,
harden security, and build the signing/distribution pipeline (where most real work/cost lives).

## 1. Process model
```
┌─ Main process (Node) ──────────────────────────────────────────────┐
│  app lifecycle · windows · menus · project I/O · media pool ·        │
│  job queue (AI-gen) · settings/keychain · auto-update                │
│                                                                     │
│   ├─ utilityProcess: RENDER  ── spawns ffmpeg/ffprobe (LGPL build)   │
│   │     streams -progress over MessagePort (Transferable buffers)   │
│   ├─ utilityProcess: PROXY/PEAKS ── proxies, thumbnails, waveforms   │
│   ├─ utilityProcess: RENDERER-ENGINE ── caption/scene compositing    │
│   └─ node-pty ── Claude CLI terminal (later: agent SDK)              │
│                                                                     │
└─ IPC (contextBridge, narrow) ──────────────────────────────────────┘
┌─ Renderer (Chromium, sandboxed) ───────────────────────────────────┐
│  React UI · DOM timeline (bound to project.json) · WebCodecs preview │
│  · PixiJS/WebGL compositor · wavesurfer waveforms · inspector · chat │
└────────────────────────────────────────────────────────────────────┘
```
- **ffmpeg runs in a `utilityProcess`**, never the main thread (a busy main lags every window; a busy
  renderer freezes the UI). utilityProcess can open a **direct MessageChannel to the sandboxed renderer**,
  so progress/frames flow renderer↔utility without round-tripping main; a crash there won't kill the app.
- Move large frame/preview buffers as **Transferable ArrayBuffers** (zero-copy); `invoke`/`send`
  deep-clone and stall.
- **Security (all Electron defaults, keep them):** `contextIsolation:true`, `nodeIntegration:false`,
  `sandbox:true`, a **narrow `contextBridge`** (named functions only, never raw `ipcRenderer`), strict CSP.

## 2. Module map
- `main/` — app, windows, ipc, project store, media pool, jobs, settings (keychain), updater.
- `engine/` — render engine (see §4), ffmpeg wrapper, proxy/peaks, transcribe.
- `renderer/` — React app: `timeline/`, `preview/` (WebCodecs+Pixi), `inspector/`, `agent/` (terminal→chat),
  `media/` (pool + AI-gen), `export/`.
- `shared/` — the `project.json` schema + types (single source, imported by main + renderer + engine).
- `plugins/styles/` — style packs (coral-ink-bone, sabri, …) = design tokens + scene/caption renderers.

## 3. Data model — `project.json` (edit-as-data)
Unchanged from today, extended for multi-track. It is the **single source of truth**; the render is a pure
function of it; agent and UI both mutate it; undo/redo is history over it. Schema:
`meta` · `grade` · `captions{defaults,cues[]}` · `scenes[]` · `cuts[]` · `tracks[]` (video/audio/overlay
layers of `clips[]`) · `media[]` (imported/generated assets w/ hash+proxy) · `audio{music[],sfx[]}`.
Migrate today's flat captions/scenes into the `tracks[]` model (a caption track, a scenes/overlay track,
N audio tracks) while keeping back-compat. Example: `schema/project.example.json`.

## 4. Render engine — **port Pillow → Node, drop Python**
Today's renderers are Python+Pillow. **Recommendation: reimplement compositing in Node** to eliminate the
Python sidecar (and the macOS Hardened-Runtime/notarization minefield that comes with shipping a signed
embedded Python):
- **`@napi-rs/canvas`** (MIT, Skia, prebuilt) — closest Pillow replacement for text/pills/shapes (captions
  + scenes). Or **`sharp`** (libvips) for resize/overlay-heavy paths (render text as SVG → `composite()`).
- **ffmpeg stays a spawned binary** (see §5). The engine emits caption/scene PNG frames (canvas) + drives
  ffmpeg for grade, overlay, splice (cuts), audio mix, encode — same pipeline as `render_project.py`, in Node.
- Keep the Python engine working during migration (it already runs headless) so the app is usable before
  the port lands. **Only keep Python if a Python-only dep forces it** (then PyInstaller `onedir` sidecar).

## 5. ffmpeg — bundling & the LICENSING TRAP ⚠️
- **Do NOT ship stock `ffmpeg-static`/gyan/evermeet builds in a paid closed-source app** — they're compiled
  `--enable-gpl` (x264/x265) and distributing them obligates GPL for your whole app. FFmpeg core is LGPL
  (fine for closed-source); `--enable-gpl` infects it.
- **Ship a custom LGPL FFmpeg build** (no x264/x265) relying on **hardware encoders** (not GPL-encumbered):
  `videotoolbox` (macOS), `nvenc`+`libvpl`/QSV (Windows). Invoke ffmpeg as a **separate child process**
  (cleanest LGPL posture — unmodified separate program, not linked libav*). Buy x264/x265 commercial
  licenses only if software H.264/HEVC is required.
- Dev convenience: `ffmpeg-ffprobe-static` (both binaries). **asar:** binaries can't run from inside
  `app.asar` → `asarUnpack`/`extraResources` (scope glob to current os/arch); resolve packaged path via
  `process.resourcesPath` / `.replace('app.asar','app.asar.unpacked')`.

## 6. Preview & timeline
- **Preview:** **WebCodecs** (`VideoDecoder`→`VideoFrame`→canvas) for frame-accurate scrubbing (HTML5
  `<video>.currentTime` snaps to keyframes — not frame-accurate). **ffmpeg all-intra proxies** for
  long/heavy media; **ffmpeg for final export**. Composite overlays/scenes/captions live on **PixiJS/WebGL**.
- **Timeline:** **custom DOM/React timeline bound to `project.json`** (free hit-testing/drag; you outgrow
  third-party interaction models fast). Study **OpenCut** (MIT) for the multi-track UI. Third-party full
  editors (OpenVideo/designcombo, Remotion) are employee-count-gated — avoid embedding.
- **Waveforms:** **wavesurfer.js v7** (BSD-3) with **pre-computed peaks** from `bbc/audiowaveform` or ffmpeg
  (decode in the utilityProcess — Web Audio decode OOMs on long clips).

## 7. Terminal & agent
- **`@xterm/xterm` v6 + `node-pty`** (native → **`@electron/rebuild`** for Electron ABI + explicit
  **`asarUnpack`**; electron-builder's auto native-unpack is buggy).
- **Packaged-app PATH gotcha:** GUI apps don't inherit the shell `$PATH`, so `node`/`claude` aren't found
  (→ `posix_spawnp failed`, the same class of bug we already hit). Fix with **`fix-path`**/`shell-env` in
  main before spawning, then spawn a login shell (`$SHELL -l -c "claude …"`) with explicit `cwd`.
- **Later chat panel** rides the same IPC transport (agent SDK) — no new native dep. Agent tools map to
  `project.json` operations + the skills (`video-edit`, `video-style-match`, `higgsfield-*`, `kno-tts-elevenlabs`).

## 8. AI media (image / B-roll / video / audio)
- **Durable job queue** in main: submit → get job id → **poll with exponential backoff** (desktop has no
  public webhook) → download → make proxy/thumbnail → add to media pool → insert as timeline clip. Persist
  job id+state to disk so multi-minute generations survive restarts.
- **Higgsfield** via its **MCP/CLI** through the embedded agent (dovetails with §7) + raw REST+polling for
  programmatic inserts. **ElevenLabs** for VO/SFX/music (reuse the cloned voice + key).

## 9. Distribution
- **electron-builder** → `.dmg` (mac) + NSIS `.exe` (Windows). **electron-updater** → **private S3/Spaces**
  (not `update.electronjs.org`, which requires a public repo).
- **macOS:** Apple Developer ($99/yr) · Developer ID · **notarytool** (`@electron/notarize`) · Hardened
  Runtime · staple · entitlements (`allow-jit`, `disable-library-validation` for a differently-signed
  ffmpeg sidecar) · **sign every bundled binary** (ffmpeg/ffprobe) or notarization fails.
- **Windows (post-2023, harder):** signing keys must live on FIPS HSM. **Azure Trusted Signing ~$10/mo**
  (keys in MS HSM, integrates with electron-builder) if the org qualifies (established legal entity), else
  OV token cert ~$200-500/yr. EV **no longer** grants instant SmartScreen — OV is usually enough; new apps
  ramp SmartScreen reputation organically.

## 10. Reference apps to mine
**OpenCut** (MIT, Next/React/TS) — closest analog, multi-track timeline + NLE architecture. **LosslessCut**
(GPL) — the reference for bundling/invoking ffmpeg from Electron (learn, don't lift). **Kdenlive** (GPL) —
edit-as-data NLE (GUI issues commands, engine renders a serialized project graph — mirrors our model).
**Diffusion Studio `core` + Mediabunny** (MPL-2.0) — modern WebCodecs compositing/mux. **Clipchamp** —
validates the WebCodecs+ffmpeg hybrid. (License watch: reuse from MIT/Apache/MPL; only *learn* from GPL.)
