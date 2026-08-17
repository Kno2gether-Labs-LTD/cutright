# 0005 — Keep the Python/Pillow render engine (for now)

**Status:** Accepted (2026-08-16) · Revisit in Phase 4

## Context
The render engine lives in the `video-edit` skill: `render_project.py` orchestrates ffmpeg while
`captions_png.py` / `scenes_png.py` (Pillow) draw the caption and split-screen scene frames. It is
proven — it produced the 31-minute grants edit and now the Self-Host-Buzz edit. The architecture doc
wants it ported to Node (`@napi-rs/canvas`) to drop the Python dependency.

## Decision
Do **not** port it this phase. Ship the app calling the same Python engine, and keep the engine in the
skill directory so standalone skill use and the app stay on one code path.

## Consequences
- Users need `python3` + Pillow. Covered by the preflight check ([0003](0003-ffmpeg-not-bundled.md)).
- Progress must be derived by tailing per-pass ffmpeg logs rather than a single `-progress` stream.
- The engine gained one backward-compatible feature this session: `overlays[]`
  ([0006](0006-overlays-via-hyperframes.md)). Projects without the key render exactly as before.

## When to reverse
Phase 4: reimplement caption/scene compositing on `@napi-rs/canvas` (Skia), keep ffmpeg orchestration
in Node, and gate the switch on frame-parity tests against the Python renderer. That also removes the
signed-embedded-Python notarization problem if we ever bundle an interpreter.
