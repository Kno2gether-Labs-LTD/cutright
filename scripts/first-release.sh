#!/bin/bash
# The first signed release, in one command.
#
#   ./scripts/first-release.sh ~/Downloads/developerID_application.cer v0.1.0
#   ./scripts/first-release.sh                                  # if the cert is already imported
#
# Everything here is doable without a person EXCEPT creating the certificate, which needs an
# Apple ID password and a 2FA code. That part is three minutes in a browser:
#
#   1. https://developer.apple.com/account/resources/certificates/add
#   2. Software → "Developer ID Application" → Continue
#      (if it asks for a profile type, choose Direct Distribution / G2 Sub-CA)
#   3. Upload  ~/.cutright-signing/developer_id.certSigningRequest   → Continue → Download
#   4. Run this script with the path to the .cer it gave you.
#
# The private key that matches that request never left this machine and is not in the repo.
set -euo pipefail
cd "$(dirname "$0")/.."

CER="${1:-}"
TAG="${2:-v0.1.0}"

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }

if [ -n "$CER" ]; then
  say "Importing $CER"
  ./scripts/setup-signing.sh import "$CER"
fi

ID=$(security find-identity -v -p codesigning 2>/dev/null | grep "Developer ID Application" | head -1 | sed 's/.*"\(.*\)"/\1/')
if [ -z "$ID" ]; then
  cat <<'MSG'

No "Developer ID Application" certificate is installed yet, so there is nothing to sign with.
A paid Developer Program membership alone does not put one on the machine — the certificate has
to be created from our signing request and downloaded. See the steps at the top of this file;
then run this script again with the path to the .cer.

(The build is perfectly usable without it. It just means every other Mac shows a Gatekeeper
warning, which is exactly what a first public release should not do.)
MSG
  exit 1
fi
say "Signing as: $ID"

TEAM=$(echo "$ID" | sed -n 's/.*(\([A-Z0-9]\{10\}\))$/\1/p')
if [ -z "${APPLE_ID:-}" ] || [ -z "${APPLE_APP_SPECIFIC_PASSWORD:-}" ] || [ -z "${APPLE_TEAM_ID:-}" ]; then
  cat <<MSG

Note: the notarization variables are not set, so this build will be SIGNED but NOT NOTARIZED.
Gatekeeper still warns on a first launch until Apple has seen the build. To finish that part:

  appleid.apple.com → Sign-In and Security → App-Specific Passwords → create one, then

  export APPLE_ID="${SIGN_EMAIL:-your-apple-id@example.com}"
  export APPLE_TEAM_ID="${TEAM:-<team id>}"
  export APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"

…and run this again. Continuing with a signed-but-not-notarized build.
MSG
fi

say "Checking the tree is clean and the tests pass"
[ -z "$(git status --porcelain)" ] || { echo "working tree is dirty — commit first"; exit 1; }
npm run --silent check:signing
npm run --silent check:guard
npm run --silent check:preview

say "Building"
npm run dist:signed

APP="dist/mac-arm64/Cutright.app"
say "What Gatekeeper makes of it"
codesign -dv --verbose=2 "$APP" 2>&1 | grep -E "Authority|TeamIdentifier|Identifier|flags" || true
spctl -a -vvv "$APP" 2>&1 | head -3 || true

# Refuse to publish something whose signature does not match what this script claims to have done.
if ! codesign -dv "$APP" 2>&1 | grep -q "Authority=Developer ID Application"; then
  echo; echo "The built app is NOT signed with the Developer ID certificate. Not releasing."; exit 1
fi

say "Tagging $TAG and publishing the release"
./scripts/release.sh "$TAG"
