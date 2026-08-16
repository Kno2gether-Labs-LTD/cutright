# Research notes — Electron editor build & distribution (2025-2026)

Condensed decision brief backing `ARCHITECTURE.md` / `IMPLEMENTATION_PLAN.md`. Sources at the bottom.

## Recommended stack
| Concern | Choice |
|---|---|
| Shell | Electron + **electron-builder**; collapse the Express server into the main process |
| ffmpeg host | Spawn ffmpeg from a **`utilityProcess`**; stream `-progress` over MessagePort (Transferable ArrayBuffers) |
| ffmpeg binary | **Custom LGPL build** (no x264/x265) + HW encoders (VideoToolbox / NVENC+QSV); `asarUnpack`. NOT stock ffmpeg-static in a paid app |
| Preview | **WebCodecs** (`VideoDecoder`→canvas) + ffmpeg proxies for heavy media + ffmpeg export |
| Timeline | **Custom DOM/React** bound to `project.json`; study OpenCut. Preview composite on PixiJS/WebGL |
| Waveforms | **wavesurfer.js v7** (BSD-3) + pre-computed peaks (bbc/audiowaveform or ffmpeg) |
| Render engine | **Port Pillow → `@napi-rs/canvas` (Skia) or `sharp`; drop Python.** PyInstaller `onedir` sidecar only if forced |
| Terminal/agent | `@xterm/xterm` v6 + `node-pty` (`@electron/rebuild`, `asarUnpack`); **`fix-path`** + login-shell spawn for `claude` |
| AI media | Durable job queue: submit → poll w/ backoff → download → proxy → insert clip. Higgsfield via MCP/CLI; ElevenLabs for VO/SFX |
| Security | contextIsolation + sandbox + nodeIntegration:false + narrow contextBridge + CSP |
| macOS signing | Apple Dev $99/yr · Developer ID · notarytool · hardened runtime · sign the ffmpeg sidecar |
| Windows signing | **Azure Trusted Signing ~$10/mo** if eligible, else OV token ~$200–500/yr. EV no longer gives instant SmartScreen |
| Updates | electron-updater → **private S3/Spaces** (not update.electronjs.org) |

## Two biggest risks (start early)
1. **ffmpeg GPL trap** — stock builds are `--enable-gpl` (x264/x265) → distributing them forces GPL on your
   app. Build/source **LGPL** ffmpeg (HW encoders) before shipping commercially.
2. **Windows code-signing post-2023** — keys must be on FIPS HSM; SmartScreen reputation ramps organically
   even with EV. Start Azure Trusted Signing eligibility/verification well ahead of launch.

## Key gotchas
- ffmpeg can't run from inside `app.asar` → `asarUnpack`; resolve packaged path via `process.resourcesPath`.
- Packaged GUI apps don't inherit shell `$PATH` → `claude`/`node` not found (`posix_spawnp failed`) → use
  `fix-path` + spawn a login shell. (Same class of bug we already hit with node-pty arch.)
- `node-pty` is native → `@electron/rebuild` for Electron's ABI + explicit `asarUnpack` (builder auto-unpack
  is buggy).
- HTML5 `<video>.currentTime` is NOT frame-accurate (keyframe snap) → WebCodecs for scrubbing.
- Web Audio `decodeAudioData` OOMs on long clips → compute waveform peaks in the utilityProcess.
- Timeline full-editor libs (OpenVideo/designcombo, Remotion) are employee-count-gated → don't embed; build
  custom or use MIT `@xzdarcy/react-timeline-editor` as a widget only.

## Reference apps (mine these)
- **OpenCut** (MIT) — closest analog; multi-track timeline + NLE architecture in React/TS.
- **LosslessCut** (GPL) — reference for bundling/invoking ffmpeg from Electron (learn, don't lift).
- **Kdenlive** (GPL) — edit-as-data NLE (GUI → serialized project graph → engine); mirrors our model.
- **Diffusion Studio `core` + Mediabunny** (MPL-2.0) — modern WebCodecs compositing/mux.
- **Clipchamp** — validates the WebCodecs + ffmpeg hybrid. **Descript** — transcript-as-edit-surface.
- License watch: reuse from MIT/Apache/MPL; only *learn* from GPL (LosslessCut/Kdenlive/Shotcut/OpenShot).

## Sources
Electron: process-model, utility-process, message-ports, security, forge-overview, Electron 22 blog
(electronjs.org/docs, /blog). ffmpeg: ffmpeg.org/legal.html, github.com/eugeneware/ffmpeg-static,
github.com/BtbN/FFmpeg-Builds, electronjs.org asar-archives. Preview/timeline:
developer.chrome.com/docs/web-platform/best-practices/webcodecs, github.com/katspaugh/wavesurfer.js,
github.com/bbc/audiowaveform, github.com/designcombo/react-video-editor, github.com/OpenCut-app/OpenCut,
github.com/mifi/lossless-cut, github.com/KDE/kdenlive, github.com/diffusionstudio/core,
github.com/Vanilagy/mediabunny, web.dev/case-studies/clipchamp. Signing/update: electron.build/docs
(notarization, auto-update), github.com/electron/notarize, melatonin.dev code-signing writeup,
learn.microsoft.com code-signing-options, Azure Trusted Signing. Render/Python: sharp.pixelplumbing.com,
til.simonwillison.net/electron/python-inside-electron, github.com/pyinstaller (hardened-runtime issue).
Terminal: github.com/microsoft/node-pty, electronjs.org native-modules, github.com/sindresorhus/fix-path.
AI media: docs.higgsfield.ai, higgsfield.ai/cli, ElevenLabs pricing.
