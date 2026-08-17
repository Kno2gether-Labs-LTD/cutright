# Contributing to Cutright

## Run it locally

```bash
npm install
npm run rebuild      # node-pty against Electron's ABI
npm run dev
```

You need `ffmpeg` + `ffprobe` and `python3` with Pillow — the app tells you if either is
missing (**Help → Check Environment…**). Cutright deliberately does not bundle ffmpeg; see
[`docs/decisions/0003`](docs/decisions/0003-ffmpeg-not-bundled.md).

## The one test command

```bash
npm run smoke
```

It launches the real app, drives the real UI and asserts against disk and against ffmpeg
(40 assertions). It needs a project folder with media — point it at one:

```bash
WORK=/path/to/a/project npm run smoke
```

**A change is not done until `npm run smoke` passes.** If you add a feature, add an assertion
that would fail without it — and prefer asserting against ground truth (measure the audio, probe
the file) over asserting against our own code.

## Where things live

| | |
|---|---|
| `electron/main.js` | app lifecycle, IPC, the `cve://` scheme, process spawning |
| `electron/preload.cjs` | **the entire renderer API** — nothing else is exposed |
| `electron/*-worker.cjs` | one utilityProcess per long job (render, analysis, transcribe, templates, new project) |
| `renderer/` | the UI — no bundler, no framework, no build step |
| `engine/` | the render engine (Python + Pillow + ffmpeg) |
| `templates/` | template packs — see [`templates/README.md`](templates/README.md) |
| `docs/decisions/` | why things are the way they are |

## House rules

1. **Long jobs go in a utilityProcess**, stream progress over a MessagePort, and can be cancelled.
   Nothing that shells out belongs on the main thread.
2. **Don't widen the bridge.** Add a named function to `preload.cjs` with validated arguments;
   never expose `ipcRenderer` or a channel name to the page.
3. **The edit is data.** A feature that changes timing must go through `make_remap()` in
   `engine/render_project.py`, which is what keeps captions, scenes, overlays and audio in sync.
4. **Read the decision record before reversing a decision.** If you do reverse one, add a new
   record rather than editing the old one.
5. Match the surrounding style. No new dependencies without a reason in the PR description.

## Licence

By contributing you agree your work is licensed under Apache-2.0 (inbound = outbound).
