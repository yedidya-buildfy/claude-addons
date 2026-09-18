#!/bin/bash
# Installs claude-addons on this Mac. Every add-on is described once, in its own
# <addon>/addon.json, and installed, updated and removed by one engine
# (engine/addons.mjs). Safe to run again at any time.
#
#   ./install.sh           apply, then open the settings page to choose
#   ./install.sh --yes     apply without questions (defaults on a fresh Mac)
#   ./install.sh --update  what the background updater runs
set -e
ROOT="$(cd "$(dirname "$0")" && pwd)"

if ! command -v node >/dev/null 2>&1; then
  echo "claude-addons needs Node.js. Install it with: brew install node" >&2
  exit 1
fi

mkdir -p "$HOME/.claude"
echo "$ROOT" > "$HOME/.claude/addons-repo-path"
[ -d "$HOME/.claude-ccx" ] && echo "$ROOT" > "$HOME/.claude-ccx/addons-repo-path"

node "$ROOT/engine/addons.mjs" apply
case "${1:-}" in
  --update|--yes|-y) ;;
  *) echo; exec node "$ROOT/engine/addons.mjs" ;;
esac
