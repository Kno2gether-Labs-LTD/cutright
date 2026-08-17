#!/bin/bash
# Create and harden the public GitHub repository. Idempotent — safe to re-run.
#
#   gh auth login                                  # once, as the account that owns the org
#   ./scripts/setup-repo.sh kno2gether-labs        # org (or your username)
#   ./scripts/setup-repo.sh kno2gether-labs --private     # start private, flip later
#
# What it does: creates the repo, pushes every branch and tag, sets the description/topics/
# homepage, turns on the security features GitHub keeps off by default, and protects `main`
# behind CI + review. Everything it applies is printed so nothing happens invisibly.
set -euo pipefail
cd "$(dirname "$0")/.."

OWNER="${1:-}"
VISIBILITY="public"
[ "${2:-}" = "--private" ] && VISIBILITY="private"
NAME="cutright"
SLUG="$OWNER/$NAME"

if [ -z "$OWNER" ]; then
  echo "usage: ./scripts/setup-repo.sh <org-or-username> [--private]"
  exit 1
fi
command -v gh >/dev/null || { echo "gh CLI not installed: brew install gh"; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "not authenticated: gh auth login"; exit 1; }

WHO=$(gh api user --jq .login)
echo "Authenticated as: $WHO"
echo "Target repository: $SLUG ($VISIBILITY)"
echo

# ---------------------------------------------------------------- guard rails
echo "→ checking the tree is safe to publish"
if git status --porcelain | grep -q .; then
  echo "   ✗ uncommitted changes — commit or stash first"; exit 1
fi
if git log --all --name-only --pretty=format: | sort -u | grep -qE "ACTION_ITEMS|SESSION_2026|PHASE0_REPORT"; then
  echo "   ✗ owner-facing docs are still in history — scrub them before publishing"; exit 1
fi
node scripts/check-licence-posture.mjs
echo

# ---------------------------------------------------------------- create + push
if gh repo view "$SLUG" >/dev/null 2>&1; then
  echo "→ repository already exists, reusing it"
else
  echo "→ creating $SLUG"
  gh repo create "$SLUG" --"$VISIBILITY" \
    --description "Agent-driven desktop video editor — edit by transcript, auto-cut, templates. The edit is data." \
    --homepage "https://viddescriptor.com" \
    --disable-wiki
fi

git remote get-url origin >/dev/null 2>&1 && git remote set-url origin "https://github.com/$SLUG.git" \
  || git remote add origin "https://github.com/$SLUG.git"

echo "→ pushing every branch and tag"
git push -u origin --all
git push origin --tags || true

# ---------------------------------------------------------------- repo settings
echo "→ repository settings"
gh api -X PATCH "repos/$SLUG" \
  -f default_branch=main \
  -F has_issues=true -F has_projects=false -F has_wiki=false \
  -F allow_squash_merge=true -F allow_merge_commit=false -F allow_rebase_merge=true \
  -F delete_branch_on_merge=true -F allow_auto_merge=true \
  -F web_commit_signoff_required=false >/dev/null
gh api -X PUT "repos/$SLUG/topics" -f names[]=video-editor -f names[]=electron -f names[]=ffmpeg \
  -f names[]=ai -f names[]=transcript -f names[]=video-editing -f names[]=open-source \
  -f names[]=claude -f names[]=macos >/dev/null

echo "→ security features"
for feature in vulnerability-alerts automated-security-fixes; do
  gh api -X PUT "repos/$SLUG/$feature" >/dev/null 2>&1 && echo "   ✓ $feature" || echo "   … $feature not available on this plan"
done
gh api -X PATCH "repos/$SLUG" -F 'security_and_analysis[secret_scanning][status]=enabled' \
  -F 'security_and_analysis[secret_scanning_push_protection][status]=enabled' >/dev/null 2>&1 \
  && echo "   ✓ secret scanning + push protection" \
  || echo "   … secret scanning needs a public repo (or GHAS) — re-run after going public"

# ---------------------------------------------------------------- branch protection
echo "→ protecting main (CI must pass, changes go through a PR, no force-push)"
gh api -X PUT "repos/$SLUG/branches/main/protection" --input - >/dev/null <<JSON && echo "   ✓ protected" || echo "   … protection needs a public repo or a paid plan"
{
  "required_status_checks": {
    "strict": true,
    "contexts": ["Static checks", "App test suite"]
  },
  "enforce_admins": false,
  "required_pull_request_reviews": {
    "required_approving_review_count": 1,
    "dismiss_stale_reviews": true,
    "require_last_push_approval": false
  },
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "required_linear_history": true,
  "required_conversation_resolution": true
}
JSON

# ---------------------------------------------------------------- placeholders
echo "→ pointing templates and badges at $SLUG"
if grep -rl "SLUG" .github README.md >/dev/null 2>&1; then
  grep -rl "SLUG" .github README.md | xargs sed -i '' "s|SLUG|$SLUG|g"
  if ! grep -q "actions/workflows/ci.yml/badge.svg" README.md; then
    sed -i '' "1a\\
\\
[![CI](https://github.com/$SLUG/actions/workflows/ci.yml/badge.svg)](https://github.com/$SLUG/actions/workflows/ci.yml) [![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)\\
" README.md
  fi
  git add -A && git commit -qm "repo: point templates and badges at $SLUG" && git push
fi

echo
echo "Done: https://github.com/$SLUG"
echo "Next: ./scripts/release.sh v0.1.0            (attach the installer to a release)"
[ "$VISIBILITY" = "private" ] && echo "      gh repo edit $SLUG --visibility public --accept-visibility-change-consequences"
