#!/bin/bash
# Self-test for auto-update. Runs the installer against a throwaway HOME —
# never against the real one.
set -eo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

bash -n "$ROOT/auto-update/claude-addons-update.sh"
bash -n "$ROOT/install.sh"
bash -n "$ROOT/uninstall.sh"
bash -n "$ROOT/multi-model/ccx"

SANDBOX="$(mktemp -d)"
trap 'rm -rf "$SANDBOX"' EXIT
mkdir -p "$SANDBOX/.claude"
HOME="$SANDBOX" ADDONS_NO_RUN=1 "$ROOT/install.sh" --update > "$SANDBOX/log" 2>&1 || { echo "FAIL: install.sh --update"; cat "$SANDBOX/log"; exit 1; }
[ "$(cat "$SANDBOX/.claude/addons-repo-path")" = "$ROOT" ] || { echo "FAIL: addons-repo-path"; exit 1; }
[ -x "$SANDBOX/.claude/scripts/claude-addons-update.sh" ] || { echo "FAIL: updater not installed"; exit 1; }
grep -q "claude-addons (managed" "$SANDBOX/.zshrc" || { echo "FAIL: shell block missing"; exit 1; }
HOME="$SANDBOX" ADDONS_NO_RUN=1 "$ROOT/install.sh" --update | grep -q "nothing changed" || { echo "FAIL: second run changed files"; exit 1; }
HOME="$SANDBOX" "$ROOT/uninstall.sh" > /dev/null
[ ! -e "$SANDBOX/.claude/scripts/claude-addons-update.sh" ] || { echo "FAIL: uninstall left the updater"; exit 1; }
echo "PASS: auto-update self-test"
