#!/bin/bash
# Removes every add-on: exactly what the engine installed, nothing else.
# Keeps ~/.claude/ntfy-topic so a reinstall keeps the same phone subscription.
set -e
ROOT="$(cd "$(dirname "$0")" && pwd)"
pkill -f tab-watcher.sh 2>/dev/null || true
node "$ROOT/engine/addons.mjs" remove-all
rm -rf "$HOME/.claude/terminal-state"
echo "Done. Open a new terminal to drop the removed shell lines."
