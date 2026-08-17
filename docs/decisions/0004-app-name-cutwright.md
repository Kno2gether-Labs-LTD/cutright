# 0004 — Product name: Cutwright

**Status:** Accepted (2026-08-17, owner approved the rename; name chosen by the implementer)

## Context
The app was called **"Claude Video Editor"** (`com.avijitsarkar.claudevideoeditor`). "Claude" is
Anthropic's trademark. For a private prototype that is harmless; for a public open-source release it
reads as an official Anthropic product, and a forced rename *after* the repo has stars, links and
installs is far more expensive than one now.

## Decision
Rename the product to **Cutwright** — "cut" + "-wright" (a maker: shipwright, playwright). Short,
spellable, no obvious collision in this space, and it says what the app does.
- App/product name: `Cutwright` · bundle id: `com.avijitsarkar.cutwright`
- Nominative use of the integration stays and is accurate: *"works with Claude Code"*. `NOTICE`
  states plainly that Cutwright is independent and not affiliated with or endorsed by Anthropic.

## Consequences
- The user-data directory changed (`~/Library/Application Support/Cutwright`), so old settings do not
  carry over. Nothing else depended on the name.
- Before registering a GitHub org / domain, do a quick trademark + npm/GitHub search for "Cutwright";
  if it collides, renaming is cheap (below).

## How to change the name
One place, then rebuild: `package.json` → `productName`, `build.appId`, `build.dmg.title`, plus the
`<title>` and the header brand string in `renderer/index.html`. `npm run dist` regenerates everything.
