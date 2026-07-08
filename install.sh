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
        const bv = b[k], av = a[k];
        if (Array.isArray(bv) && Array.isArray(av)) {
          // Append items from incoming, dedupe by structural equality so
          // re-running the installer stays idempotent and existing hook
          // entries (e.g. from other plugins like GSD) are preserved.
          const seen = new Set(av.map(x => JSON.stringify(x)));
          for (const item of bv) {
            const key = JSON.stringify(item);
            if (!seen.has(key)) { av.push(item); seen.add(key); }
          }
        } else if (bv && typeof bv === "object" && !Array.isArray(bv) && av && typeof av === "object" && !Array.isArray(av)) {
          merge(av, bv);
        } else {
          a[k] = bv;
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
cyan "[1/4] tab-status (colored dot on VS Code terminal tabs)"
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

fi

echo

# --- skill-tab-name ---
cyan "[2/4] skill-tab-name (Claude picks tab names automatically)"
if confirm "Install the \`tab-name\` skill?"; then
  mkdir -p "$CLAUDE_DIR/skills/tab-name"
  cp "$ROOT/skill-tab-name/SKILL.md" "$CLAUDE_DIR/skills/tab-name/SKILL.md"
  green "    installed skill → ~/.claude/skills/tab-name/SKILL.md"
  dim "    fires on /tab-name, on phrases like 'rename tab', and auto-fires when topic shifts"
  dim "    requires tab-status (for the \`tn\` CLI it calls)"

  if confirm "Also append a reminder to ~/.claude/CLAUDE.md for max reliability?"; then
    backup "$CLAUDE_MD"
    if ! grep -q "\`tab-name\`" "$CLAUDE_MD" 2>/dev/null; then
      [ -f "$CLAUDE_MD" ] && [ -s "$CLAUDE_MD" ] && echo "" >> "$CLAUDE_MD"
      # extract the markdown fence block from the snippet
      sed -n '/^```markdown$/,/^```$/{/^```markdown$/d; /^```$/d; p;}' "$ROOT/skill-tab-name/CLAUDE.md.snippet" >> "$CLAUDE_MD"
      green "    appended skill reminder to ~/.claude/CLAUDE.md"
    else
      dim "    reminder already present, skipping"
    fi
  fi
fi

echo

# --- skill-design-in-browser ---
cyan "[3/4] skill-design-in-browser (design UI in the browser before coding)"
if confirm "Install the `design-in-browser` skill?"; then
  mkdir -p "$CLAUDE_DIR/skills/design-in-browser"
  cp "$ROOT/skill-design-in-browser/SKILL.md" "$CLAUDE_DIR/skills/design-in-browser/SKILL.md"
  green "    installed skill → ~/.claude/skills/design-in-browser/SKILL.md"
  dim "    fires on /design-in-browser and on phrases like 'show me design options'"
  dim "    uses an impeccable / UI-UX plugin if one is installed"
fi

echo

# --- statusline-gsd ---
cyan "[4/4] statusline-gsd (model + task + context bar + plan usage at bottom)"
if confirm "Install GSD statusline?"; then
  cp "$ROOT/statusline-gsd/gsd-statusline.js" "$CLAUDE_DIR/gsd-statusline.js"
  green "    copied gsd-statusline.js → ~/.claude/"

  mkdir -p "$CLAUDE_DIR/scripts"
  cp "$ROOT/statusline-gsd/usage-fetch.sh" "$CLAUDE_DIR/scripts/usage-fetch.sh"
  chmod +x "$CLAUDE_DIR/scripts/usage-fetch.sh"
  green "    copied usage-fetch.sh → ~/.claude/scripts/ (plan-usage cache refresher)"

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
