# Getting started with Cutwright

## The one thing to understand

Cutwright edits a **project folder**. A project folder holds three things:

| file | what it is |
|---|---|
| `project.json` | **the edit** — every caption, scene, cut, overlay and audio layer, as plain data |
| `graded_master.mp4` | **the picture** — your recording, normalised to 1080p |
| `transcript.json` | **the words** — every word with its timing |

That's it. It's an ordinary folder: move it, back it up, put it in Dropbox, hand it to
`claude`. Nothing is hidden in a database.

---

## Start a new edit from a recording

**Welcome screen → “Start from a video…”**, or once a project is open, click the folder chip
in the top-left → **“Start from a video…”**.

1. **Choose video** — your raw recording (`.mov`, `.mp4`, …).
2. **Project folder** — filled in for you as `<video name>_edit` next to the recording. Change
   it if you'd rather keep projects somewhere else. It is created for you.
3. **Match the colour of another video** *(optional)* — point this at a finished video you like
   and Cutwright matches its grade. Leave it empty to keep your original look.
4. **Transcribe** — leave on. It runs **on your machine** (nothing is uploaded) and unlocks
   captions, auto-cut and transcript editing. `small.en` is accurate; `tiny.en` is ~3× faster.
5. **Create project.**

It takes roughly as long as the video: the master is hardware-encoded, then transcribed. When
it finishes, the timeline opens on your new project.

## Switch between projects

The **folder chip in the top-left corner is the project switcher**. Click it for:
- Start from a video… (new project)
- Open another project… (any folder containing `project.json`)
- Recent projects
- Reveal in Finder

`⌘O` also opens a project folder, and **File → Open Workspace…** does the same.

---

## The four things worth trying first

**1. Edit by reading** — press `D` (or the **Transcript** button).
Your video becomes a document. Click a word to jump there. Drag across a sentence you want gone
and press **Delete** — the video is cut there and every caption, scene, overlay and audio layer
after it moves up automatically. Struck-through words are already removed; select them and hit
**Restore** to bring them back. Nothing is destroyed — a cut is just a range in `project.json`.

**2. Let it find the dead air** — press `A` (or **Auto-cut**).
It listens to the audio for real silence and reads the transcript for “um”s and stutters, then
lists what it would remove. **Click any row to hear it** before you decide. Tick the ones you
want and Apply. Gentle / Balanced / Tight change how aggressive it is.

**3. Add motion graphics** — press `T` (or **Templates**).
Pick a template (it sets your caption look), then open a preset — lower third, title card,
callout — type your text and **Render & add to timeline**. It appears on the Overlays track at
the playhead and you can drag its timing in the inspector.

**4. Grade it** — press `L` (or **Look**).
Film, warm, cool, teal & orange, bleach, noir, VHS, plus grain, vignette and a voice polish for
the audio. Applied when rendering, so your master is never altered and you can change your mind
at any point. Use **Preview this look here** to see it on six seconds before committing.

---

## The agent

Run `claude` in the terminal at the bottom right. It starts **in your project folder**, so you
can just talk about the edit:

> “Remove the rambling between 2 and 4 minutes and tighten the pauses.”
> “Add a lower third that says SELF-HOSTED RELAY when I first say ‘relay’.”
> “Write six explainer scenes from the transcript in the coral/ink/bone style.”

It edits the same `project.json` you're looking at, and the timeline reloads as it works. If
you're mid-edit, your change wins — the app won't overwrite something you just typed.

---

## Rendering

- **Preview section** (`P`) — renders just the part around what's selected. Seconds, not minutes.
  Use it constantly.
- **Export** (`E`) — the whole video with every cut, caption, scene, overlay, transition and look
  applied. Progress and a Cancel button appear in the header; cancelling kills the whole render
  immediately.

Both write into the project folder (`preview.mp4`, `FINAL.mp4`).

---

## Keyboard

| | |
|---|---|
| `space` | play / pause |
| `←` `→` | one frame (`shift` = one second) |
| `S` | cut at the playhead |
| `⌫` | delete what's selected (or cut the selected words in the transcript) |
| `D` `A` `T` `L` | transcript · auto-cut · templates · look |
| `+` `−` `F` | zoom in · out · fit |
| `P` `E` | preview section · export |
| `Esc` | deselect / close the tour |

---

## If something looks wrong

- **A red bar at the top** means a required tool is missing. **Help → Check Environment…** shows
  exactly what and how to install it (`brew install ffmpeg`, `python3 -m pip install --user Pillow`).
- **Help → Show Me Around** replays the guided tour.
- **Help → Open Log Folder** — every launch writes a log; that's the first thing to look at if the
  app misbehaves, and the thing to send with a bug report.
- **A render seems stuck** — the status bar says so after 90 seconds of silence, and the job is
  killed automatically after 20 minutes of nothing. **Cancel** always works.

## What Cutwright can't do yet

- Only **one video source** per project — you can't yet drop a screen recording or B-roll onto a
  second track (it's the top of the roadmap).
- **No undo stack.** Edits save immediately. Cuts and overlays are easy to delete on the timeline,
  but there's no `⌘Z` yet.
- **macOS only** in practice; the Windows code paths exist but are untested.
