#!/bin/bash
# Cutright — macOS code-signing setup.
#
#   ./scripts/setup-signing.sh csr      # 1. make a signing request (run this first)
#   …upload it at developer.apple.com, download the .cer…
#   ./scripts/setup-signing.sh import ~/Downloads/developerID_application.cer
#   ./scripts/setup-signing.sh check    # 3. confirm the identity is usable
#
# The private key never leaves this machine and is not in the repo: it lives in
# ~/.cutright-signing (mode 700) and is imported into the login keychain.
set -euo pipefail

DIR="$HOME/.cutright-signing"
KEY="$DIR/developer_id.key"
CSR="$DIR/developer_id.certSigningRequest"
KEYCHAIN="$HOME/Library/Keychains/login.keychain-db"

# Edit these two if the certificate should be issued to a different identity.
COMMON_NAME="${SIGN_NAME:-Avijit Sarkar}"
EMAIL="${SIGN_EMAIL:-avijeett007@gmail.com}"
COUNTRY="${SIGN_COUNTRY:-GB}"

cmd="${1:-help}"

case "$cmd" in
csr)
  mkdir -p "$DIR" && chmod 700 "$DIR"
  if [ -f "$KEY" ]; then
    echo "A private key already exists at $KEY — reusing it (delete it only if you are starting over)."
  else
    openssl genrsa -out "$KEY" 2048 2>/dev/null
    chmod 600 "$KEY"
  fi
  openssl req -new -key "$KEY" -out "$CSR" \
    -subj "/emailAddress=$EMAIL/CN=$COMMON_NAME/C=$COUNTRY"
  echo
  echo "Signing request ready:"
  echo "  $CSR"
  echo
  echo "Next, in the browser where you are already logged in:"
  echo "  1. https://developer.apple.com/account/resources/certificates/add"
  echo "  2. Choose  Developer ID Application  (under Software), then Continue"
  echo "     • if asked for a profile type, choose 'Direct Distribution' / G2 Sub-CA"
  echo "  3. Upload the file above, Continue, then Download the .cer"
  echo "  4. Come back and run:"
  echo "       ./scripts/setup-signing.sh import ~/Downloads/developerID_application.cer"
  open -R "$CSR" 2>/dev/null || true
  ;;

import)
  CER="${2:-}"
  [ -z "$CER" ] && { echo "usage: $0 import /path/to/developerID_application.cer"; exit 1; }
  [ -f "$CER" ] || { echo "no such file: $CER"; exit 1; }
  [ -f "$KEY" ] || { echo "missing private key at $KEY — run '$0 csr' first"; exit 1; }

  # Apple's intermediate, or the chain will not validate and codesign will refuse.
  INT="$DIR/DeveloperIDG2CA.cer"
  [ -f "$INT" ] || curl -fsSL -o "$INT" https://www.apple.com/certificateauthority/DeveloperIDG2CA.cer || true
  [ -f "$INT" ] && security import "$INT" -k "$KEYCHAIN" 2>/dev/null || true

  security import "$KEY" -k "$KEYCHAIN" -T /usr/bin/codesign -T /usr/bin/security 2>/dev/null || true
  security import "$CER" -k "$KEYCHAIN" -T /usr/bin/codesign -T /usr/bin/security
  # let codesign use the key without a GUI prompt on every build
  security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "" "$KEYCHAIN" >/dev/null 2>&1 || \
    echo "note: could not set the partition list non-interactively — macOS may prompt on the first signed build."
  echo
  "$0" check
  ;;

check)
  echo "Signing identities visible to codesign:"
  security find-identity -v -p codesigning || true
  ID=$(security find-identity -v -p codesigning 2>/dev/null | grep "Developer ID Application" | head -1 | sed 's/.*"\(.*\)"/\1/')
  if [ -n "$ID" ]; then
    echo
    echo "✅ Ready to sign as: $ID"
    TEAM=$(echo "$ID" | sed -n 's/.*(\([A-Z0-9]\{10\}\))$/\1/p')
    echo
    echo "Add these to your shell profile (notarization also needs an app-specific"
    echo "password from https://appleid.apple.com → Sign-In and Security):"
    echo "  export APPLE_ID=\"$EMAIL\""
    echo "  export APPLE_TEAM_ID=\"${TEAM:-<team id>}\""
    echo "  export APPLE_APP_SPECIFIC_PASSWORD=\"xxxx-xxxx-xxxx-xxxx\""
    echo
    echo "Then:  npm run dist:signed"
  else
    echo
    echo "❌ No 'Developer ID Application' identity yet."
    echo "   Run '$0 csr', upload the request at developer.apple.com, then '$0 import <the .cer>'."
  fi
  ;;

*)
  sed -n '2,12p' "$0"
  ;;
esac
