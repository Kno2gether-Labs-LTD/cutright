#!/bin/bash
# Signed + notarized macOS build. Requires the Developer ID certificate (scripts/setup-signing.sh)
# and, for notarization, APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID.
set -euo pipefail
cd "$(dirname "$0")/.."

ID=$(security find-identity -v -p codesigning 2>/dev/null | grep "Developer ID Application" | head -1 | sed 's/.*"\(.*\)"/\1/')
if [ -z "$ID" ]; then
  echo "No 'Developer ID Application' certificate in the keychain."
  echo "Run: ./scripts/setup-signing.sh csr    (then upload it at developer.apple.com)"
  exit 1
fi
echo "Signing as: $ID"
# electron-builder matches on the common name and rejects the "Developer ID Application:" prefix,
# choosing the right certificate itself. Exporting CSC_NAME as well tells the afterPack hook to
# stand down — otherwise it ad-hoc signs the bundle first and electron-builder immediately
# replaces that signature, which is wasted work and confusing in the log.
SHORT=${ID#Developer ID Application: }
export CSC_NAME="$SHORT"

if [ -z "${APPLE_ID:-}" ] || [ -z "${APPLE_APP_SPECIFIC_PASSWORD:-}" ] || [ -z "${APPLE_TEAM_ID:-}" ]; then
  echo "⚠️  Notarization variables are not set — the app will be SIGNED but NOT notarized."
  echo "   (Gatekeeper still warns on other Macs until it is notarized.)"
  echo "   Set APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD and APPLE_TEAM_ID to complete it."
fi

npx electron-builder --mac dmg --arm64 --publish never \
  -c.mac.identity="$SHORT" \
  -c.mac.hardenedRuntime=true \
  -c.mac.gatekeeperAssess=false

APP="dist/mac-arm64/Cutright.app"
echo
echo "--- verification ---"
codesign -dv --verbose=2 "$APP" 2>&1 | grep -E "Authority|TeamIdentifier|Identifier|flags" || true
spctl -a -vvv "$APP" 2>&1 | head -3 || true
