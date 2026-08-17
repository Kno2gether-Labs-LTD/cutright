#!/bin/bash
# Cut a GitHub release with the installer attached.
#   ./scripts/release.sh v0.1.0 [--signed]
set -euo pipefail
cd "$(dirname "$0")/.."
TAG="${1:?usage: ./scripts/release.sh v0.1.0 [--signed]}"
MODE="${2:-}"

command -v gh >/dev/null || { echo "gh CLI not installed"; exit 1; }
gh auth status >/dev/null || { echo "run: gh auth login"; exit 1; }

if [ "$MODE" = "--signed" ]; then npm run dist:signed; else npm run dist; fi

DMG=$(ls -t dist/*.dmg | head -1)
[ -f "$DMG" ] || { echo "no dmg was produced"; exit 1; }

NOTE="Cutright $TAG"
[ "$MODE" = "--signed" ] || NOTE="$NOTE

⚠️ This build is **not notarized**: macOS will say the app is from an unidentified developer.
Right-click the app → Open the first time, or run \`xattr -dr com.apple.quarantine /Applications/Cutright.app\`.

Requires \`ffmpeg\` and \`python3\` + Pillow — the app checks on launch (Help → Check Environment…)."

git tag -f "$TAG" && git push -f origin "$TAG"
gh release create "$TAG" "$DMG" --title "Cutright $TAG" --notes "$NOTE" || \
  gh release upload "$TAG" "$DMG" --clobber
echo "released $TAG with $(basename "$DMG")"
