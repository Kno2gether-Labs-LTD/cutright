# Docs — Claude Video Editor (Electron plan)

Planning set for the parallel dev session that builds the distributable Electron app. Read in order:

1. **[REQUIREMENTS.md](REQUIREMENTS.md)** — vision, users, principles, functional + non-functional
   requirements (multi-track timeline, story-aware auto SFX/music, AI media generation, agent panel,
   distribution), scope + non-goals, v1 success criteria.
2. **[ARCHITECTURE.md](ARCHITECTURE.md)** — target architecture: Electron process model (ffmpeg in a
   utilityProcess), the `project.json` edit-as-data model (→ multi-track), render engine (**port Pillow →
   Node/Skia, drop Python**), preview (WebCodecs + proxies), timeline, terminal/agent, AI-media job queue,
   distribution, reference apps.
3. **[IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md)** — the phase-wise plan (Phase 0 shell → 8 release),
   long-lead items to start immediately, parallelization tracks, cost snapshot, and the two launch risks.
4. **[RESEARCH.md](RESEARCH.md)** — the condensed 2025-26 decision brief + sources backing the above.

## TL;DR for kickoff
- We already have ~60% of the shell: Node backend + browser UI + `project.json` model + the `video-edit`
  render engine + node-pty terminal. The Electron move = collapse server→main, ffmpeg→utilityProcess,
  harden security, build the signing/distribution pipeline.
- **Start these on day one (they gate launch):** a **custom LGPL ffmpeg build**, an **Apple Developer**
  account, and **Windows code-signing** (Azure Trusted Signing) eligibility.
- Biggest single simplification: **drop Python** — port the caption/scene compositing to `@napi-rs/canvas`.

## Reused assets (already built, in this repo + skills)
- `schema/project.example.json` — the data model. `server.js` + `public/` — the working prototype UI/loop.
- `~/.claude/skills/video-edit/` — the render engine (grade, captions, scenes, cuts+ripple re-time, audio
  mix, ElevenLabs `audio_agent`). `~/.claude/skills/video-style-match/` — renderers + style packs
  (coral/ink/bone, Sabri) + `extract-style`.
