# Updates

## What happens today

**Nothing installs itself.** The About panel (Help → About Cutright, or *About* on the Home
screen) shows what you are running, and **Check for updates** asks GitHub whether there is a
newer release. If there is, it tells you and offers to open the release page. You download and
replace the app yourself.

That is deliberate for now, for three reasons:

1. **There is nothing to update to yet.** v0.1.0 is still a draft release, so the check correctly
   reports "no published release yet" rather than inventing something.
2. **Replacing an application while someone is editing is not a small act.** It should be a
   decision, not a background task, until the update path has been used in anger a few times.
3. **It costs nothing to add later.** Everything the automatic path needs already exists.

## What is already in place for automatic updates

More than you might expect:

| Needed | Status |
|---|---|
| A signed application | ✅ Developer ID Application: KNO2GETHER LABS LTD (YBPZTUP33D) |
| Notarised by Apple | ✅ done in CI on every tagged release |
| An update manifest (`latest-mac.yml`) | ✅ electron-builder already writes one into `dist/` |
| Somewhere to publish it | ✅ GitHub releases, on a public repo |
| A version the app knows | ✅ `app.getVersion()`, shown in About |
| Version comparison | ✅ `electron/version.mjs`, tested — including that 0.10.0 beats 0.9.0 |

The one missing piece is the updater itself.

## What switching it on would involve

1. **Add `electron-updater`** (the electron-builder companion; same maintainers, widely used).
2. **Publish `latest-mac.yml` and the blockmap with each release.** electron-builder writes both
   already; the release workflow attaches only the `.dmg`, so it would attach these too.
3. **Point the updater at the repo** — `provider: github`, which needs no server of our own.
4. **Decide the behaviour**, which is the actual decision and not a technical one:
   - check on launch, or only when asked?
   - download in the background, or ask first?
   - install on quit, or prompt to restart?

   The safe default for an editor is: check quietly, tell the user, download only when they say
   so, and never restart while a project has unsaved changes or a render is running.
5. **Keep the certificate stable.** An update signed by a different identity is, to macOS, a
   different application — Screen Recording and every other permission would be asked for again.
   This is the same reason the local signing work exists (`docs/SIGNING.md`).

## What must not happen

- **No silent restart.** An editor that closes itself mid-edit has taken work from someone.
- **No update during a render.** A render is minutes of CPU; interrupting it wastes them.
- **No unsigned update path.** If the signature cannot be verified, the update is refused —
  auto-update is the most attractive thing in the whole app to an attacker.
