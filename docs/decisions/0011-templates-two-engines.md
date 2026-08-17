# 0011 — Template packs, and two motion-graphics engines

**Status:** Accepted (2026-08-17)

## Context
The owner wants templates users can choose, an open-source base with a few packs, and a
future paid layer selling more packs — plus support for "both Remotion or HyperFrames".

## Decision
A **template** is a folder of data + composition files with a `template.json` manifest
(`templates/README.md` documents the format). It carries the caption look, the scene style
and a list of **motion-graphics presets** with typed variables. Applying a template touches
only `meta.template` and `captions.defaults` — never the user's content.

Presets render through whichever engine the manifest names:
- **HyperFrames** (`--format mov --variables '{…}'`) — used by both bundled packs.
- **Remotion** (`--codec prores --prores-profile 4444 --image-format png --pixel-format
  yuva444p10le --props '{…}'`) — proven by a user-installed pack.

Both produce an alpha clip which is added to `overlays[]` and composited by the engine
(decision 0006). Output is transcoded to QuickTime RLE when that is smaller (4.9 MB → 1.4 MB
on the test preset); **WebM/VP9 alpha was tested and rejected** — this ffmpeg build decodes
it as opaque yuv420p, so the alpha silently disappears.

Templates are found in the app bundle **and** in `~/Library/Application Support/Cutright/
templates`, user first. That is the whole install mechanism for a downloaded pack.

## Consequences
- A paid pack is a folder — no app release needed to ship or sell one.
- Bundled packs use HyperFrames because it needs no per-template `node_modules`. A Remotion
  pack carries its own (~105 MB), so those are user-installed, not bundled.
- Remotion is MIT-ish but **its licence requires a company licence above a size threshold** —
  a user installing a Remotion pack accepts that themselves; we ship none.
