#!/bin/bash
# Cut a GitHub release with the installer attached.
#   ./scripts/release.sh v0.1.0 [--signed|--skip-build]
#
# The release notes are written from what the built app ACTUALLY is, not from which flag was
# passed. Signed and notarized are different states with different consequences for whoever
# downloads it, and a release that describes itself wrongly is worse than one that says nothing.
set -euo pipefail
cd "$(dirname "$0")/.."

PROJECT_GH="${CUTRIGHT_GH_CONFIG:-$HOME/.config/gh-cutright}"
[ -d "$PROJECT_GH" ] && export GH_CONFIG_DIR="$PROJECT_GH"
TAG="${1:?usage: ./scripts/release.sh v0.1.0 [--signed|--skip-build]}"
MODE="${2:-}"

command -v gh >/dev/null || { echo "gh CLI not installed"; exit 1; }
gh auth status >/dev/null || { echo "run: ./scripts/gh-account.sh login"; exit 1; }

case "$MODE" in
  --signed)     npm run dist:signed ;;
  --skip-build) echo "using the build already in dist/" ;;
  *)            npm run dist ;;
esac

DMG=$(ls -t dist/*.dmg | head -1)
[ -f "$DMG" ] || { echo "no dmg was produced"; exit 1; }
APP="dist/mac-arm64/Cutright.app"

# What is this thing, really?
AUTH=$(codesign -dv "$APP" 2>&1 | sed -n 's/^Authority=//p' | head -1 || true)
SIGNED=no; case "$AUTH" in "Developer ID Application:"*) SIGNED=yes ;; esac
NOTARIZED=no
xcrun stapler validate "$APP" >/dev/null 2>&1 && NOTARIZED=yes

REQS='Requires `ffmpeg` and `python3` + Pillow — the app checks on launch (Help → Check Environment…).'
DRAFT=""
if [ "$SIGNED" = yes ] && [ "$NOTARIZED" = yes ]; then
  NOTE="Cutright $TAG — signed and notarized by $AUTH.

Downloads and opens without a Gatekeeper warning.

$REQS"
elif [ "$SIGNED" = yes ]; then
  # Signed but not notarized: Gatekeeper still blocks a downloaded copy on a first launch, so
  # this does not get published automatically.
  DRAFT="--draft"
  NOTE="Cutright $TAG — signed by $AUTH, **not yet notarized**.

The app is properly signed and attributable, but Apple has not yet been asked to check it, so
macOS will still refuse a downloaded copy on the first launch:

> \"Cutright\" can't be opened because Apple cannot check it for malicious software.

Right-click the app → **Open** the first time, or:
\`\`\`
xattr -dr com.apple.quarantine /Applications/Cutright.app
\`\`\`

To finish it (no rebuild needed — the same file can be notarized and stapled in place):
\`\`\`
xcrun notarytool submit \"$(basename "$DMG")\" --wait \\
  --apple-id <your apple id> --team-id <team> --password <app-specific password>
xcrun stapler staple \"$(basename "$DMG")\"
\`\`\`

$REQS"
else
  DRAFT="--draft"
  NOTE="Cutright $TAG — **unsigned**. macOS will say the app is from an unidentified developer.

Right-click the app → Open the first time, or \`xattr -dr com.apple.quarantine /Applications/Cutright.app\`.

$REQS"
fi

echo "signed=$SIGNED notarized=$NOTARIZED ${DRAFT:+(publishing as a draft)}"

git tag -f "$TAG" && git push -f origin "$TAG"
gh release create "$TAG" "$DMG" --title "Cutright $TAG" --notes "$NOTE" $DRAFT || \
  gh release upload "$TAG" "$DMG" --clobber
echo "released $TAG with $(basename "$DMG")"
