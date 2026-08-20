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
# --verbose=2 is required: plain -dv does not print the Authority chain at all, so reading it
# without this reported every signed build as unsigned.
AUTH=$(codesign -dv --verbose=2 "$APP" 2>&1 | sed -n 's/^Authority=//p' | head -1 || true)
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

# A DRAFT has no tag on GitHub until it is published, so `gh release create` cannot find one and
# happily makes a second draft with the same name — which is how two v0.1.0 drafts appeared.
# Look for an existing draft by title and update that one instead.
EXISTING=$(gh api "repos/{owner}/{repo}/releases" --jq \
  ".[] | select(.tag_name == \"$TAG\" or .name == \"Cutright $TAG\") | .id" 2>/dev/null | head -1)
if [ -n "$EXISTING" ]; then
  echo "updating the existing release ($EXISTING)"
  gh api -X PATCH "repos/{owner}/{repo}/releases/$EXISTING" \
    -f name="Cutright $TAG" -f body="$NOTE" -F draft="$([ -n "$DRAFT" ] && echo true || echo false)" >/dev/null
  gh release upload "$TAG" "$DMG" --clobber 2>/dev/null || {
    # A draft's assets cannot be reached by tag; go through the release id.
    OLD=$(gh api "repos/{owner}/{repo}/releases/$EXISTING/assets" --jq '.[] | select(.name == "'"$(basename "$DMG")"'") | .id' | head -1)
    [ -n "$OLD" ] && gh api -X DELETE "repos/{owner}/{repo}/releases/assets/$OLD" >/dev/null
    gh api --method POST -H "Content-Type: application/octet-stream" \
      "https://uploads.github.com/repos/{owner}/{repo}/releases/$EXISTING/assets?name=$(basename "$DMG")" \
      --input "$DMG" >/dev/null
  }
else
  gh release create "$TAG" "$DMG" --title "Cutright $TAG" --notes "$NOTE" $DRAFT
fi
echo "released $TAG with $(basename "$DMG")"
