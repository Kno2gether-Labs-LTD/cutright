# 0003 — FFmpeg is not bundled

**Status:** Accepted (2026-08-17) · Follows from [0002](0002-licence-apache-2.md)

## Context
Cutwright shells out to `ffmpeg`/`ffprobe` for every grade, overlay, splice and encode. Bundling the
binary would make installation one click, but the standard prebuilds (`ffmpeg-static`, gyan.dev,
evermeet, most Homebrew bottles) are `--enable-gpl` builds containing x264/x265. Distributing one
inside an Apache-2.0 app would force the whole distribution to GPL.

## Decision
Ship **no** ffmpeg binary. Invoke whatever ffmpeg the user has installed, as a **separate process**
(the cleanest licensing posture — an unmodified separate program, not linked libav*), and make the
dependency explicit:
- a **preflight check** on launch (`ffmpeg`, `ffprobe`, `python3`, Pillow, the engine scripts),
  surfaced as a banner plus **Help → Check Environment…** with copy-pasteable install commands;
- the packaged app repairs its `PATH` at startup (`fix-path` **plus** explicitly appending
  `/opt/homebrew/bin`, `/usr/local/bin`, `~/.local/bin` …). This is not optional: a Finder/launchd
  launch on this very machine produced a PATH *without* Homebrew, so ffmpeg was invisible while the
  same binary worked fine from a terminal.

## Consequences
- Install friction: macOS users need `brew install ffmpeg`, Windows users `winget install ffmpeg`.
  Documented in the README and enforced by the preflight banner.
- We inherit whatever the user's build supports. This machine's ffmpeg has no libass/drawtext, which
  is why the engine composites Pillow PNGs with `overlay` instead of using `drawtext` — keep it that way.
- Hardware encoding (`h264_videotoolbox`) is used where available, which is also the LGPL-friendly path.

## If we ever want one-click install
Build a **custom LGPL ffmpeg** (no `--enable-gpl`, no x264/x265) relying on hardware encoders
(VideoToolbox on macOS; NVENC/QSV/libvpl on Windows) for mac arm64 + x64 and win x64, ship it via
`asarUnpack`/`extraResources` with a per-arch glob, resolve it through `process.resourcesPath`, and
**sign it** as part of notarization. That is a multi-day build task, tracked as a long-lead item.
