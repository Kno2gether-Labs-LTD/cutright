# 0007 — Code signing and updates

**Status:** Accepted (2026-08-17, from the owner's answers)

## Context
The owner has an Apple Developer Program membership, wants no Windows code-signing spend ("okay to
release as a normal internet-downloaded app"), and wants auto-updates only if they are free for an
open-source project.

## Decision
- **macOS — sign + notarize as soon as the certificate exists.** Everything is pre-wired:
  `build/entitlements.mac.plist` (allow-jit, disable-library-validation) and `build/notarize.cjs`,
  an `afterSign` hook that no-ops until credentials are present. Note: `security find-identity -v -p
  codesigning` currently returns **0 identities on this Mac** — the membership exists but no
  *Developer ID Application* certificate has been created/downloaded yet.
  To turn signing on: create the cert at developer.apple.com → Certificates → **Developer ID
  Application**, download and double-click it; create an app-specific password at appleid.apple.com;
  then set `build.mac.identity` to the certificate name, flip `hardenedRuntime: true`, export
  `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`, and run `npm run dist`.
- **Windows — ship unsigned.** No Azure Trusted Signing, no OV token. Users will see a SmartScreen
  "unrecognised app" prompt; the README will say so plainly. Revisit only if downloads justify it.
- **Updates — deferred until the repo is public, then GitHub Releases.** `electron-updater` with the
  GitHub provider is free for public repos (`update.electronjs.org` also works, and requires public).
  No updater code is shipped yet: an updater that cannot reach a release feed is untestable dead code.

## Consequences
- Until the Mac cert is installed, the dmg is ad-hoc signed: it runs on this machine, and other Macs
  need right-click → Open (or `xattr -dr com.apple.quarantine`). Documented in the README.
- Enabling updates later is: create the public repo → add `build.publish` (`{provider: "github"}`) →
  add `electron-updater` + a check-on-launch and an "Install and restart" prompt → publish a release.
