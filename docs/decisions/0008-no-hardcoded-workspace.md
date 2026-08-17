# 0008 — No hard-coded workspace; welcome screen, recents, scoped file access

**Status:** Accepted (2026-08-17)

## Context
The prototype defaulted to `WORK=/Users/avijit/Pre_final_edit`, which was baked into the packaged app
as the default workspace. That is wrong for anyone else who installs it, and it also meant the file
scope for the `cve://` media scheme was effectively "that one folder".

## Decision
- The default workspace is **empty**. With no workspace the app shows a **welcome screen** —
  "Open Workspace…" plus a list of **recent workspaces** (persisted, existence-checked) and a hint
  that `claude` + the `video-edit` skill produces the workspace this app opens.
- `WORK=` (env) and `--cve-work=` (argv) still override, for dev and for automated tests.
- Every workspace-dependent IPC refuses to act without one (`project:get/save`, `render:start`), and
  `cve://` denies **all** paths when no workspace is open, and otherwise only serves files inside it.
  There is a regression test asserting `/etc/hosts` cannot be loaded.

## Consequences
- First launch is a deliberate choice, not a stranger's folder path.
- The app is now installable by anyone without patching a path.
- A workspace is still just a folder — no lock files, no import step; the agent and the app both
  simply read/write `project.json` in it.
