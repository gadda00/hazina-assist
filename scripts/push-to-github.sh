#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Hazina Assist — push to GitHub and enable GitHub Pages
#
# Creates the repo under your account, pushes main, enables GitHub Pages
# (served from /docs on main = the static showcase site), sets description +
# topics, and waits for the first Pages build.
#
# Usage:
#   GH_TOKEN=<classic PAT, scopes: repo + workflow> \
#     ./scripts/push-to-github.sh <github-username> [repo-name] [--author <github-username>]
#
# Or with the token positional:
#   ./scripts/push-to-github.sh <token> <github-username> [repo-name] [--author <github-username>]
#
# Notes:
#   * The token is used ONLY via process env / HTTP headers — it is never
#     written to .git/config or any file.
#   * 'workflow' scope is required because the push includes
#     .github/workflows/ci.yml (GitHub rejects workflow pushes without it).
#   * --author rewrites commit authorship to <github-username>
#     (uses noreply email). Only do this BEFORE the first push.
# ---------------------------------------------------------------------------
set -euo pipefail

usage() { echo "usage: GH_TOKEN=<token> $0 <github-username> [repo-name=hazina-assist] [--author <github-username>]" >&2; exit 64; }

GH_USER=""; REPO="hazina-assist"; AUTHOR=""
if [[ -n "${GH_TOKEN:-}" ]]; then
  TOKEN="$GH_TOKEN"
  GH_USER="${1:-}"
  if [[ "${2:-}" == "--author" ]]; then AUTHOR="${3:?--author needs a value}"; else REPO="${2:-hazina-assist}"; fi
else
  TOKEN="${1:-}"; GH_USER="${2:-}"
  if [[ "${4:-}" == "--author" ]]; then AUTHOR="${5:?--author needs a value}"; else REPO="${3:-hazina-assist}"; fi
fi
[[ -z "${TOKEN:-}" || -z "$GH_USER" ]] && usage

API="https://api.github.com"
AUTH=("Authorization: Bearer $TOKEN" "Accept: application/vnd.github+json" "X-GitHub-Api-Version: 2022-11-28")
GITAUTH="Authorization: Basic $(printf 'x-access-token:%s' "$TOKEN" | base64 -w0)"

echo "◆ Hazina Assist → github.com/$GH_USER/$REPO"
echo "  token: ${#TOKEN} chars, header auth only (never stored in git config)"

cd "$(dirname "$0")/.."

# --- 0. optional author rewrite (before first push only) ------------------
if [[ -n "$AUTHOR" ]]; then
  echo "◆ rewriting commit author → $AUTHOR"
  if git filter-branch -f --env-filter "
    export GIT_AUTHOR_NAME='$AUTHOR'
    export GIT_AUTHOR_EMAIL='$AUTHOR@users.noreply.github.com'
    export GIT_COMMITTER_NAME='$AUTHOR'
    export GIT_COMMITTER_EMAIL='$AUTHOR@users.noreply.github.com'
  " HEAD >/dev/null 2>&1; then
    rm -rf .git/refs/original
    echo "  done"
  else
    echo "  ! author rewrite failed — keeping existing authorship" >&2
  fi
fi

# --- 1. create repo ---------------------------------------------------------
echo "◆ creating repository (public)…"
CODE=$(curl -s -o /tmp/gh-repo.json -w "%{http_code}" -X POST "$API/user/repos" \
  -H "${AUTH[0]}" -H "${AUTH[1]}" -H "${AUTH[2]}" \
  -d "{\"name\":\"$REPO\",\"description\":\"Bank-grade AI assistant for a Kenyan bank — governed RAG, signed transfer intents with human approval, hash-chained audit, eval CI gate\",\"homepage\":\"https://$GH_USER.github.io/$REPO/\",\"private\":false,\"has_wiki\":false,\"auto_init\":false}")
if [[ "$CODE" == "201" ]]; then echo "  created"
elif [[ "$CODE" == "202" || "$CODE" == "409" ]]; then echo "  already exists — continuing"
else echo "  ! repo creation failed (HTTP $CODE)"; cat /tmp/gh-repo.json; exit 1; fi

# --- 2. push main ------------------------------------------------------------
echo "◆ pushing main…"
git -c http.extraheader="$GITAUTH" push -u "https://github.com/$GH_USER/$REPO.git" main:main 2>&1 | sed 's/^/  /'

# --- 3. enable GitHub Pages (main /docs) ------------------------------------
echo "◆ enabling GitHub Pages (source: main /docs)…"
CODE=$(curl -s -o /tmp/gh-pages.json -w "%{http_code}" -X POST "$API/repos/$GH_USER/$REPO/pages" \
  -H "${AUTH[0]}" -H "${AUTH[1]}" -H "${AUTH[2]}" \
  -d "{\"source\":{\"branch\":\"main\",\"path\":\"/docs\"}}")
if [[ "$CODE" == "201" || "$CODE" == "409" ]]; then echo "  enabled"
else echo "  ! Pages enable failed (HTTP $CODE)"; cat /tmp/gh-pages.json; fi

# --- 4. topics ---------------------------------------------------------------
echo "◆ setting repo topics…"
curl -s -o /dev/null -X PUT "$API/repos/$GH_USER/$REPO/topics" \
  -H "${AUTH[0]}" -H "${AUTH[1]}" -H "${AUTH[2]}" \
  -d '{"names":["ai","rag","llm","fintech","banking","kenya","guardrails","hitl","audit","compliance","nextjs","typescript","prisma","fastapi"]}' || true

# --- 5. wait for first Pages build -------------------------------------------
PAGES_URL="https://$GH_USER.github.io/$REPO/"
echo "◆ waiting for first Pages build (up to 120s)…"
ST=""
for i in $(seq 1 24); do
  ST=$(curl -s "$API/repos/$GH_USER/$REPO/pages/builds/latest" -H "${AUTH[0]}" -H "${AUTH[1]}" | grep -o '"status":"[a-z]*"' | head -1 | cut -d'"' -f4 || true)
  [[ "$ST" == "built" ]] && break
  sleep 5
done
echo "  build status: ${ST:-unknown} (first build can lag ~1 min after creation)"

echo
echo "=============================================================="
echo "  Repository : https://github.com/$GH_USER/$REPO"
echo "  Pages site : $PAGES_URL"
echo "  CI gate    : runs on push (Actions tab)"
echo "=============================================================="
echo "  If Pages shows 404: Settings → Pages should show 'main / docs',"
echo "  then retry the URL after ~1 minute."
echo "  Tip: revoke the token after the push if you don't need it."
rm -f /tmp/gh-repo.json /tmp/gh-pages.json
