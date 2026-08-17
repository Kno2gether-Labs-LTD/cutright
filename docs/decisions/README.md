# Decision records

Short records of the decisions taken while building Cutwright, so nobody (including future
us) has to re-derive them. One file per decision: context → decision → consequences → how to
reverse it.

| # | Decision | Status |
|---|---|---|
| [0001](0001-electron-process-model.md) | Electron process model: main-process IPC, ffmpeg in a utilityProcess, `cve://` media scheme | Accepted 2026-08-16 |
| [0002](0002-licence-apache-2.md) | Licence: **Apache-2.0** (open source now, commercial fork possible later) | Accepted 2026-08-17 (owner) |
| [0003](0003-ffmpeg-not-bundled.md) | Do **not** bundle ffmpeg; use the user's system ffmpeg + a preflight check | Accepted 2026-08-17 |
| [0004](0004-app-name-cutwright.md) | Product name: **Cutwright** (renamed from "Claude Video Editor") | Accepted 2026-08-17 (owner approved rename) |
| [0005](0005-keep-python-engine-for-now.md) | Keep the Python/Pillow render engine this phase; port to Node/Skia in Phase 4 | Accepted 2026-08-16 |
| [0006](0006-overlays-via-hyperframes.md) | Motion graphics = `overlays[]` of alpha clips, authored in HyperFrames | Accepted 2026-08-17 |
| [0007](0007-signing-and-updates.md) | macOS: sign+notarize when the cert exists. Windows: unsigned. Updates: GitHub Releases once public | Accepted 2026-08-17 |
| [0008](0008-no-hardcoded-workspace.md) | No hard-coded workspace; welcome screen + recents; workspace-scoped file access | Accepted 2026-08-17 |
| [0009](0009-auto-cut-signals.md) | Auto-cut trusts the measured audio; the transcript finds fillers, it does not veto silences | Accepted 2026-08-17 |
| [0010](0010-transitions-and-look.md) | Transitions live on cuts (xfade, timeline re-timed); film looks applied at render time | Accepted 2026-08-17 |
| [0011](0011-templates-two-engines.md) | Template packs = data + compositions; HyperFrames bundled, Remotion user-installed | Accepted 2026-08-17 |
