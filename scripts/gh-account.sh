#!/bin/bash
# Use a SECOND GitHub account for this project only, without disturbing the account the
# rest of this Mac uses.
#
#   ./scripts/gh-account.sh login      # sign in (opens your browser)
#   ./scripts/gh-account.sh status     # who am I here, and which orgs can I see
#   ./scripts/gh-account.sh git        # make `git push` in THIS repo use that account
#   ./scripts/gh-account.sh logout
#
# How it works: gh keeps its credentials in $GH_CONFIG_DIR. Pointing that at a separate
# directory gives this project its own login. `gh auth switch` would also work but it
# changes the ACTIVE account globally — which is exactly what we are avoiding.
#
# The credentials live in ~/.config/gh-cutright, never inside the repo.
set -euo pipefail
cd "$(dirname "$0")/.."

CFG="${CUTRIGHT_GH_CONFIG:-$HOME/.config/gh-cutright}"
run() { GH_CONFIG_DIR="$CFG" gh "$@"; }

case "${1:-status}" in
login)
  mkdir -p "$CFG" && chmod 700 "$CFG"
  echo "Signing in to GitHub for this project only."
  echo "Config: $CFG   (your main account stays exactly as it is)"
  echo
  run auth login --hostname github.com --git-protocol https --web
  echo
  "$0" status
  ;;

status)
  # A half-finished login leaves the directory behind, so test for a real session
  # rather than for the directory.
  PROJECT_USER=""
  if [ -d "$CFG" ]; then
    PROJECT_USER=$(run api user --jq .login 2>/dev/null || true)
  fi

  if [ -z "$PROJECT_USER" ]; then
    echo "Project account: not signed in yet"
    [ -d "$CFG" ] && echo "  (a config directory exists at $CFG but holds no session —"
    [ -d "$CFG" ] && echo "   an interrupted login, or GitHub was unreachable at the time)"
    echo
    echo "  To sign in:  ./scripts/gh-account.sh login"
  else
    echo "Project account (this repo only): $PROJECT_USER"
    run auth status 2>&1 | grep -E "Logged in|Token scopes" | sed 's/^/  /' || true
    echo
    echo "  organisations visible to it:"
    ORGS=$(run api user/orgs --jq '.[].login' 2>/dev/null || true)
    if [ -n "$ORGS" ]; then echo "$ORGS" | sed 's/^/    /'
    else echo "    (none — either no org membership, or the token lacks read:org)"; fi
  fi

  echo
  echo "This Mac's default account (untouched by any of this)"
  gh auth status 2>&1 | grep -E "Logged in|Active account" | sed 's/^/  /' || echo "  (not signed in)"
  ;;

git)
  # Per-repo credential helper: `git push` here uses the project account, every other repo
  # on this machine keeps using the default one. This lives in .git/config, not globally.
  USER_NAME=$(run api user --jq .login 2>/dev/null || true)
  [ -n "$USER_NAME" ] || { echo "no project account yet — run: ./scripts/gh-account.sh login"; exit 1; }
  git config --local credential."https://github.com".helper \
    "!GH_CONFIG_DIR=$CFG gh auth git-credential"
  git config --local credential."https://github.com".username "$USER_NAME"
  echo "✓ git in this repo will authenticate as: $USER_NAME"
  echo "  (written to .git/config — nothing global was changed)"
  echo
  read -r -p "Also set the commit author for this repo? [name email, or blank to skip]: " NAME EMAIL || true
  if [ -n "${NAME:-}" ] && [ -n "${EMAIL:-}" ]; then
    git config --local user.name "$NAME"
    git config --local user.email "$EMAIL"
    echo "✓ commits here will be authored as $NAME <$EMAIL>"
  fi
  ;;

logout)
  [ -d "$CFG" ] || { echo "nothing to log out of"; exit 0; }
  run auth logout --hostname github.com || true
  rm -rf "$CFG"
  git config --local --unset credential."https://github.com".helper 2>/dev/null || true
  git config --local --unset credential."https://github.com".username 2>/dev/null || true
  echo "✓ project account removed; the default account is untouched"
  ;;

*)
  # anything else is passed straight through as the project account:
  #   ./scripts/gh-account.sh repo list
  run "$@"
  ;;
esac
