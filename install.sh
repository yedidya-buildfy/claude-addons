#!/bin/bash
# Interactive installer for claude-addons. Asks before each step, makes
# timestamped backups of anything it modifies. Idempotent — safe to re-run.

set -e
ROOT="$(cd "$(dirname "$0")" && pwd)"
TS=$(date '+%Y-%m-%d-%H%M%S')

CLAUDE_DIR="$HOME/.claude"
CLAUDE_SETTINGS="$CLAUDE_DIR/settings.json"
CLAUDE_MD="$CLAUDE_DIR/CLAUDE.md"
VSCODE_SETTINGS="$HOME/Library/Application Support/Code/User/settings.json"
ZSHRC="$HOME/.zshrc"

cyan() { printf '\033[36m%s\033[0m\n' "$1"; }
dim()  { printf '\033[2m%s\033[0m\n' "$1"; }
green(){ printf '\033[32m%s\033[0m\n' "$1"; }

confirm() { read -p "  $1 [y/N] " r; [ "$r" = "y" ] || [ "$r" = "Y" ]; }

backup() {
  [ -f "$1" ] || return 0
  cp "$1" "$1.bak.$TS"
  dim "    backed up: $1.bak.$TS"
}

json_merge() {
  local file="$1"
  local incoming
  incoming=$(cat)
  mkdir -p "$(dirname "$file")"
  [ -f "$file" ] || echo '{}' > "$file"
  node -e '
    const fs = require("fs");
    const file = process.argv[1];
    const incoming = JSON.parse(process.argv[2]);
    const target = JSON.parse(fs.readFileSync(file, "utf8"));
    function merge(a, b) {
      for (const k of Object.keys(b)) {
        if (b[k] && typeof b[k] === "object" && !Array.isArray(b[k]) && a[k] && typeof a[k] === "object" && !Array.isArray(a[k])) {
          merge(a[k], b[k]);
        } else {
          a[k] = b[k];
        }
      }
    }
    merge(target, incoming);
    fs.writeFileSync(file, JSON.stringify(target, null, 2) + "\n");
  ' "$file" "$incoming"
}

cyan "claude-addons installer"
echo

# --- tab-status ---
cyan "[1/2] tab-status (colored dot on VS Code terminal tabs)"
if confirm "Install tab-status?"; then
  mkdir -p "$CLAUDE_DIR/scripts" "$CLAUDE_DIR/terminal-state"

  cp "$ROOT/tab-status/tab.sh" "$CLAUDE_DIR/scripts/tab.sh"
  cp "$ROOT/tab-status/tab-watcher.sh" "$CLAUDE_DIR/scripts/tab-watcher.sh"
  cp "$ROOT/tab-status/tn" "$CLAUDE_DIR/scripts/tn"
  chmod +x "$CLAUDE_DIR/scripts/tab.sh" "$CLAUDE_DIR/scripts/tab-watcher.sh" "$CLAUDE_DIR/scripts/tn"
  green "    copied scripts → ~/.claude/scripts/ (tab.sh, tab-watcher.sh, tn)"

  backup "$CLAUDE_SETTINGS"
  cat "$ROOT/tab-status/settings.json.snippet" | json_merge "$CLAUDE_SETTINGS"
  green "    merged hooks into ~/.claude/settings.json"

  if [ -f "$VSCODE_SETTINGS" ]; then
    backup "$VSCODE_SETTINGS"
    cat "$ROOT/tab-status/vscode-settings.snippet" | json_merge "$VSCODE_SETTINGS"
    green "    added terminal.integrated.tabs.title to VS Code settings"
  else
    dim "    VS Code user settings not found — skipping (install VS Code first)"
  fi

  if [ -f "$ZSHRC" ] && ! grep -q "^tn()" "$ZSHRC" 2>/dev/null; then
    if confirm "Append the \`tn\` shell wrapper to ~/.zshrc?"; then
      backup "$ZSHRC"
      echo "" >> "$ZSHRC"
      cat "$ROOT/tab-status/zshrc.snippet" >> "$ZSHRC"
      green "    appended tn wrapper to ~/.zshrc (run \`source ~/.zshrc\` to load)"
    fi
  fi

  if confirm "Let Claude suggest tab names? (appends ~30 lines to ~/.claude/CLAUDE.md)"; then
    backup "$CLAUDE_MD"
    if ! grep -q "Terminal tab naming (claude-addons)" "$CLAUDE_MD" 2>/dev/null; then
      [ -f "$CLAUDE_MD" ] && echo "" >> "$CLAUDE_MD"
      cat "$ROOT/tab-status/CLAUDE.md.snippet" >> "$CLAUDE_MD"
      green "    appended naming instructions to ~/.claude/CLAUDE.md"
    else
      dim "    instructions already present, skipping"
    fi
  fi
fi

echo

# --- statusline-gsd ---
cyan "[2/2] statusline-gsd (model + task + context bar at bottom)"
if confirm "Install GSD statusline?"; then
  cp "$ROOT/statusline-gsd/gsd-statusline.js" "$CLAUDE_DIR/gsd-statusline.js"
  green "    copied gsd-statusline.js → ~/.claude/"

  backup "$CLAUDE_SETTINGS"
  echo '{"statusLine":{"type":"command","command":"node ~/.claude/gsd-statusline.js"}}' | json_merge "$CLAUDE_SETTINGS"
  green "    set statusLine in ~/.claude/settings.json"
fi

echo
green "Done."
echo
dim "Next steps:"
dim "  1. Restart any existing Claude sessions so new hooks load."
dim "  2. Open a new VS Code terminal so the tabs.title setting takes effect."
dim "  3. Run \`claude\` — tab should show ⚪ on start, 🔴 when working, 🟢 when idle."
