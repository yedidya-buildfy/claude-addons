#!/bin/bash
# Reverses install.sh. Removes tab-status hooks + scripts. Leaves the GSD
# statusline file in place (it's harmless to keep; remove manually if you
# really want it gone).

set -e

CLAUDE_DIR="$HOME/.claude"
CLAUDE_SETTINGS="$CLAUDE_DIR/settings.json"
VSCODE_SETTINGS="$HOME/Library/Application Support/Code/User/settings.json"

cyan() { printf '\033[36m%s\033[0m\n' "$1"; }
dim()  { printf '\033[2m%s\033[0m\n' "$1"; }
green(){ printf '\033[32m%s\033[0m\n' "$1"; }

cyan "claude-addons uninstaller"
echo

# Kill running watchers
killed=$(pgrep -f tab-watcher.sh | wc -l | tr -d ' ')
if [ "$killed" -gt 0 ]; then
  pkill -f tab-watcher.sh 2>/dev/null || true
  dim "  killed $killed running watcher(s)"
fi

# Remove scripts
rm -f "$CLAUDE_DIR/scripts/tab.sh" "$CLAUDE_DIR/scripts/tab-watcher.sh"
green "  removed ~/.claude/scripts/tab.sh and tab-watcher.sh"

# Strip our hook entries from ~/.claude/settings.json
if [ -f "$CLAUDE_SETTINGS" ]; then
  node -e '
    const fs = require("fs");
    const file = process.argv[1];
    const cfg = JSON.parse(fs.readFileSync(file, "utf8"));
    if (cfg.hooks) {
      const isOurs = h => JSON.stringify(h).includes("tab.sh");
      for (const event of Object.keys(cfg.hooks)) {
        cfg.hooks[event] = cfg.hooks[event].filter(group => {
          group.hooks = (group.hooks || []).filter(h => !isOurs(h));
          return group.hooks.length > 0;
        });
        if (cfg.hooks[event].length === 0) delete cfg.hooks[event];
      }
      if (Object.keys(cfg.hooks).length === 0) delete cfg.hooks;
    }
    fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n");
  ' "$CLAUDE_SETTINGS"
  green "  stripped tab-status hooks from ~/.claude/settings.json"
fi

# Remove terminal.integrated.tabs.title from VS Code if it matches our value
if [ -f "$VSCODE_SETTINGS" ]; then
  node -e '
    const fs = require("fs");
    const file = process.argv[1];
    const cfg = JSON.parse(fs.readFileSync(file, "utf8"));
    if (cfg["terminal.integrated.tabs.title"] === "${sequence}") {
      delete cfg["terminal.integrated.tabs.title"];
    }
    fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n");
  ' "$VSCODE_SETTINGS"
  green "  removed terminal.integrated.tabs.title from VS Code settings"
fi

# Clean state dir
rm -rf "$CLAUDE_DIR/terminal-state"
green "  removed ~/.claude/terminal-state/"

echo
dim "Note: ~/.zshrc and gsd-statusline.js are NOT touched — remove manually if desired."
echo
green "Done."
