#!/bin/bash
# Cutright — macOS code-signing setup.
#
#   ./scripts/setup-signing.sh local    # 0. a stable identity for LOCAL builds (no Apple account)
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
LOCAL_KEY="$DIR/local_signing.key"
LOCAL_CRT="$DIR/local_signing.crt"
LOCAL_CN="Cutright Local Signing"
KEYCHAIN="$HOME/Library/Keychains/login.keychain-db"

# Edit these two if the certificate should be issued to a different identity.
COMMON_NAME="${SIGN_NAME:-Avijit Sarkar}"
EMAIL="${SIGN_EMAIL:-avijeett007@gmail.com}"
COUNTRY="${SIGN_COUNTRY:-GB}"

cmd="${1:-help}"

case "$cmd" in
local)
  # A self-signed code-signing certificate, used to sign every local build.
  #
  # Why this exists at all: without a certificate, electron-builder leaves an ad-hoc
  # signature whose designated requirement is `cdhash H"..."` — a hash of the build itself.
  # macOS therefore treats each rebuild as a DIFFERENT application, and Screen Recording has to
  # be granted again after every build. Signing with a certificate that stays the same makes the
  # requirement `identifier "..." and certificate root H"..."`, which survives rebuilds.
  #
  # It does NOT fix saved API keys — that was measured, and safeStorage's keychain item has no
  # restrictive ACL, so identity never gated it. See scripts/afterpack-sign.cjs.
  #
  # This is NOT for distribution — other Macs still get a Gatekeeper warning. It only
  # makes the app usable on the machine that builds it. Distribution needs the
  # Developer ID path below (csr → import → npm run dist:signed).
  mkdir -p "$DIR" && chmod 700 "$DIR"
  if [ -f "$LOCAL_CRT" ] && [ -f "$LOCAL_KEY" ]; then
    echo "Reusing the existing local certificate — its stability is the entire point."
    echo "  $LOCAL_CRT"
  else
    CNF="$(mktemp)"
    cat > "$CNF" <<EOF
[req]
distinguished_name = dn
x509_extensions    = v3
prompt             = no
[dn]
CN = $LOCAL_CN
O  = Viddescriptor
C  = $COUNTRY
[v3]
basicConstraints     = critical,CA:false
keyUsage             = critical,digitalSignature
extendedKeyUsage     = critical,codeSigning
subjectKeyIdentifier = hash
EOF
    openssl req -x509 -newkey rsa:2048 -sha256 -days 3650 -nodes \
      -keyout "$LOCAL_KEY" -out "$LOCAL_CRT" -config "$CNF" 2>/dev/null
    rm -f "$CNF"
    chmod 600 "$LOCAL_KEY"
    echo "Created a 10-year self-signed code-signing certificate:"
    echo "  $LOCAL_CRT"
  fi

  if security find-identity -v -p codesigning 2>/dev/null | grep -q "$LOCAL_CN"; then
    echo "Already installed in the login keychain."
  else
    echo
    echo "Installing it. macOS will ask you to allow this — that prompt is the point of"
    echo "this step, so click Allow / Always Allow. You may be asked twice."
    security import "$LOCAL_KEY" -k "$KEYCHAIN" -T /usr/bin/codesign -T /usr/bin/security 2>/dev/null || true
    security import "$LOCAL_CRT" -k "$KEYCHAIN" -T /usr/bin/codesign -T /usr/bin/security 2>/dev/null || true
    # trust it for code signing only — nothing else
    security add-trusted-cert -r trustRoot -p codeSign -k "$KEYCHAIN" "$LOCAL_CRT" 2>/dev/null \
      || security add-trusted-cert -r trustAsRoot -p codeSign -k "$KEYCHAIN" "$LOCAL_CRT" 2>/dev/null \
      || echo "note: could not set trust non-interactively."
    security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "" "$KEYCHAIN" >/dev/null 2>&1 || true
  fi

  echo
  if security find-identity -v -p codesigning 2>/dev/null | grep -q "$LOCAL_CN"; then
    security find-identity -v -p codesigning | grep "$LOCAL_CN"
    echo
    echo "✅ Local builds will now sign with a stable identity."
    echo "   Rebuild (npm run dist), reinstall, and grant Screen Recording ONE more time."
    echo "   After that the grant sticks across rebuilds."
  else
    echo "❌ The certificate is not usable for code signing yet."
    echo "   Open Keychain Access → login → Certificates → \"$LOCAL_CN\","
    echo "   Get Info → Trust → Code Signing: Always Trust."
    exit 1
  fi
  ;;

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
