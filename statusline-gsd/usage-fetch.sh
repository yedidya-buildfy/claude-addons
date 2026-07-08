#!/bin/bash
# Fetch Claude plan usage (same data as /usage) into a cache file the
# statusline reads synchronously. Spawned detached by gsd-statusline.js
# whenever the cache is older than its TTL — never run in the render path.
#
# Endpoint is the one the Claude Code CLI itself uses for /usage
# (api/oauth/usage). Undocumented — on any failure we exit 0 and leave the
# previous cache in place, so the statusline just shows last-known data.
set -uo pipefail

CACHE_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/cache"
CACHE="$CACHE_DIR/claude-usage.json"
mkdir -p "$CACHE_DIR"

# OAuth access token: macOS Keychain first, Linux credentials file as fallback.
CREDS=$(security find-generic-password -s "Claude Code-credentials" -w 2>/dev/null) \
  || CREDS=$(cat "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/.credentials.json" 2>/dev/null) \
  || exit 0
TOKEN=$(printf '%s' "$CREDS" | /usr/bin/python3 -c \
  "import json,sys; print(json.load(sys.stdin)['claudeAiOauth']['accessToken'])" 2>/dev/null) || exit 0
[ -n "$TOKEN" ] || exit 0

TMP=$(mktemp "$CACHE_DIR/.usage.XXXXXX") || exit 0
trap 'rm -f "$TMP"' EXIT

if curl -sf --max-time 10 https://api.anthropic.com/api/oauth/usage \
     -H "Authorization: Bearer $TOKEN" \
     -H "anthropic-beta: oauth-2025-04-20" \
     -o "$TMP" \
   && /usr/bin/python3 -c "import json; json.load(open('$TMP'))" 2>/dev/null; then
  mv "$TMP" "$CACHE"
  trap - EXIT
fi
