#!/bin/bash
# Self-test for auto-update feature
set -eo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "Testing syntax..."
bash -n "$ROOT/auto-update/claude-addons-update.sh"
bash -n "$ROOT/install.sh"
bash -n "$ROOT/multi-model/ccx"

echo "Testing claude-addons-update.sh directly..."
# Temporary stamp to avoid rate limit
output=$("$ROOT/auto-update/claude-addons-update.sh" --force 2>&1 || true)
echo "$output" | grep -q "already up to date\|updating\|local uncommitted changes" || {
  echo "FAIL: unexpected output: $output"
  exit 1
}

echo "Testing install.sh --update..."
"$ROOT/install.sh" --update > /tmp/install-update-test.log 2>&1 || {
  echo "FAIL: install.sh --update failed"
  cat /tmp/install-update-test.log
  exit 1
}

echo "Testing addons-repo-path was written..."
[ -f "$HOME/.claude/addons-repo-path" ] || {
  echo "FAIL: addons-repo-path not created"
  exit 1
}

echo "PASS: auto-update self-test"
