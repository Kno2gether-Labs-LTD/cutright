# 0012 — The app owns the on-ramp

**Status:** Accepted (2026-08-17, after owner feedback: "the app interface is not much intuitive")

## Context
Cutright could only *open* a project folder that already contained `project.json` and
`graded_master.mp4`. Those were produced outside the app — by running `claude` with the
`video-edit` skill. So the first thing a new user had to do was something the app never
mentioned and could not do. The welcome screen described a "workspace" in terms of files
the user had never seen.

## Decision
- **The app creates projects.** "Start from a video…" takes a raw recording, normalises it to a
  1080p/30 master (hardware encoded, loudness-normalised), optionally colour-matches a reference
  video, transcribes it locally, and writes `project.json` — then opens it. It runs in its own
  utilityProcess with staged progress, like every other long job.
- **The vocabulary changed.** "Workspace" is now "project" in the interface; the folder chip in
  the header is the project switcher (new / open / recent / reveal). The docs still explain that a
  project is a plain folder, because that remains the point.
- **A guided tour runs once**, spotlighting eight real elements. It reads the DOM: if a step's
  selector no longer matches, that step is skipped rather than pointing at nothing — so the tour
  cannot drift out of sync with the UI.
- **The empty inspector became a launcher** ("Edit by transcript / Find cuts for me / Templates /
  Look") instead of "select an element on the timeline".

## Consequences
- The agent path is now the *second* way to start, not the only one. Both produce the same folder
  layout, so `claude` and the app remain interchangeable on the same project.
- Transcription is on by default at project creation, because three features (captions, auto-cut,
  transcript editing) are dead without it. It runs locally, so this costs nothing but time.
- The tour's state lives in `localStorage`, so it is per-machine and replayable from Help.
