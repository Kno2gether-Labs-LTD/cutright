#!/bin/bash
# Give the release workflow what it needs to sign, without any of it touching the repo.
#
#   ./scripts/ci-signing-secrets.sh
#
# Exports the Developer ID certificate AND its private key from this Mac's keychain as a
# password-protected .p12, uploads it to GitHub as an encrypted Actions secret, and deletes the
# local copy. The passphrase is generated here, uploaded as its own secret, and never written to
# disk or printed — GitHub is the only place either half ends up.
#
# You have to run this yourself: exporting a private key needs your keychain password, which
# macOS will ask for in a dialog. That is the point of the dialog.
#
# Nothing here goes anywhere near the repository. `git check-ignore` is asserted below rather
# than assumed.
set -euo pipefail
cd "$(dirname "$0")/.."

ID=$(security find-identity -v -p codesigning 2>/dev/null | grep "Developer ID Application" | head -1 | sed 's/.*"\(.*\)"/\1/')
[ -n "$ID" ] || { echo "No Developer ID Application certificate installed. Run ./scripts/setup-signing.sh first."; exit 1; }
TEAM=$(echo "$ID" | sed -n 's/.*(\([A-Z0-9]\{10\}\))$/\1/p')
echo "Exporting: $ID"

GH="gh"
[ -d "$HOME/.config/gh-cutright" ] && export GH_CONFIG_DIR="$HOME/.config/gh-cutright"
$GH auth status >/dev/null 2>&1 || { echo "gh is not logged in for this project — run ./scripts/gh-account.sh login"; exit 1; }

# A temp file outside the repo, removed on any exit including a failure or a Ctrl-C.
P12=$(mktemp -t cutright-signing).p12
trap 'rm -f "$P12"' EXIT INT TERM
PASS=$(openssl rand -base64 24)

echo "macOS will ask permission to export the private key — that prompt is this script."
security export -t identities -f pkcs12 -P "$PASS" -o "$P12" 2>/dev/null \
  || { echo "Export failed. In Keychain Access, find \"$ID\", right-click → Export, and save a .p12."; exit 1; }

# Sanity: it must contain the key, or CI will fail in a much more confusing way.
openssl pkcs12 -in "$P12" -nodes -passin pass:"$PASS" 2>/dev/null | grep -q "PRIVATE KEY" \
  || { echo "The exported file has no private key in it — not uploading."; exit 1; }

echo "Uploading as encrypted Actions secrets"
base64 -i "$P12" | $GH secret set MACOS_CERTIFICATE_P12
printf '%s' "$PASS" | $GH secret set MACOS_CERTIFICATE_PASSWORD
printf '%s' "$ID"   | $GH secret set APPLE_SIGN_IDENTITY
printf '%s' "${TEAM:-}" | $GH secret set APPLE_TEAM_ID

cat <<MSG

Done. The certificate and its passphrase are in GitHub, encrypted, and the local copy is gone.

Two more are needed before CI can NOTARIZE (without them it signs but Gatekeeper still warns
on a first launch):

  appleid.apple.com → Sign-In and Security → App-Specific Passwords → create one, then:

    gh secret set APPLE_ID                       # your Apple ID email
    gh secret set APPLE_APP_SPECIFIC_PASSWORD    # the xxxx-xxxx-xxxx-xxxx password

To rotate or revoke everything later: delete the secrets in the repo settings, and revoke the
certificate at developer.apple.com. Nothing on this machine has to change.
MSG
