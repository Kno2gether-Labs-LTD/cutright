# 0002 — Licence: Apache-2.0

**Status:** Accepted (2026-08-17, owner decision) · Supersedes the earlier "commercial closed-source" assumption

## Context
The project is being released as open source. The owner wants the option of a commercial version
later. The licence choice is coupled to a technical one: whether we can ship FFmpeg in the installer.
FFmpeg core is LGPL, but every common prebuilt binary is compiled `--enable-gpl` (x264/x265), and
redistributing one inside a non-GPL app puts the *combined distribution* under the GPL.

Options weighed: **GPL-3.0** or **AGPL-3.0** (could bundle a GPL ffmpeg, best out-of-the-box UX,
but closes the commercial door once outside contributions arrive), versus **Apache-2.0** (keeps the
commercial door open, includes an explicit patent grant, is the licence enterprises accept without
review — but forbids shipping GPL binaries).

## Decision
**Apache-2.0**, with `LICENSE` + `NOTICE` at the repo root. Consequence accepted: **we do not ship
FFmpeg** — see [0003](0003-ffmpeg-not-bundled.md).

## Consequences
- A closed/commercial fork remains possible without relicensing; contributions arrive under Apache-2.0
  (inbound = outbound), so no CLA is strictly required for that path to stay open.
- Users must install ffmpeg themselves. The app checks for it on launch and tells them the exact
  command; a missing tool is a clear banner, never a failed render three minutes in.
- All bundled dependencies are permissive (MIT): Electron, xterm.js, node-pty, fix-path. Listed in `NOTICE`.

## Reversing it
Moving to GPL/AGPL later is possible (the copyright is the owner's, plus any contributors' consent)
and would let us bundle ffmpeg. Moving from GPL *back* to Apache would not be — which is why Apache
is the safer starting point.
