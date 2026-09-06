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
    if (incoming.env?.CLAUDE_CODE_DISABLE_TERMINAL_TITLE === "1") {
      // Replace only our title hooks, preserving other hooks in shared entries.
      const owned = /^(?:python3 )?(?:\$HOME\/\.claude|~\/\.claude)\/scripts\/(?:tab\.sh|tab-autoname\.py)(?: |$)/;
      for (const [event, entries] of Object.entries(target.hooks || {})) {
        target.hooks[event] = entries.map(entry => ({...entry,
          hooks: entry.hooks.filter(hook => !owned.test(hook.command || ""))
        })).filter(entry => entry.hooks.length);
        if (!target.hooks[event].length) delete target.hooks[event];
      }
    }
    merge(target, incoming);
    const temporary = file + ".tmp." + process.pid;
    fs.writeFileSync(temporary, JSON.stringify(target, null, 2) + "\n", {mode: fs.statSync(file).mode & 0o777});
    fs.renameSync(temporary, file);
  ' "$file" "$incoming"
}

update_tab_shell() {
  python3 - "$ZSHRC" "$ROOT/tab-status/zshrc.snippet" <<'PY'
from pathlib import Path
import re
import sys
p = Path(sys.argv[1])
source = p.read_text()
wrapper = Path(sys.argv[2]).read_text().rstrip()
legacy = r'''tn() {
  local state_dir="$HOME/.claude/terminal-state"
  mkdir -p "$state_dir"
  local tty_dev=$(ps -o tty= -p $$ 2>/dev/null | tr -d ' ')
  [ -n "$tty_dev" ] && [ "$tty_dev" != "??" ] || { echo "tn: no TTY" >&2; return 1; }
  if [ -z "$1" ]; then
    rm -f "$state_dir/tty.$tty_dev.name"
    printf '\033]0;\a'
  else
    echo "$1" > "$state_dir/tty.$tty_dev.name"
    printf '\033]0;🟢 %s\a' "$1"
  fi
}'''
if legacy in source:
    source = source.replace(legacy, wrapper, 1)
elif re.search(r'^tn\s*\(\)', source, re.M):
    print('    existing tn wrapper left unchanged (not the known legacy version)')
    sys.exit(0)
else:
    source += '\n' + wrapper + '\n'
p.write_text(source)
PY
}

cyan "claude-addons installer"
echo

# --- tab-status ---
cyan "[1/8] tab-status (colored dot on VS Code terminal tabs)"
if confirm "Install tab-status?"; then
  mkdir -p "$CLAUDE_DIR/scripts" "$CLAUDE_DIR/terminal-state"

  for script in tab.sh tab-watcher.sh tab-state.py tn tab-dots-selftest.sh tab-autoname.py test_tab_status.py test_tab_naming.py; do
    backup "$CLAUDE_DIR/scripts/$script"
  done
  cp "$ROOT/tab-status/tab-state.py" "$CLAUDE_DIR/scripts/tab-state.py"
  cp "$ROOT/tab-status/test_tab_status.py" "$CLAUDE_DIR/scripts/test_tab_status.py"
  cp "$ROOT/tab-status/test_tab_naming.py" "$CLAUDE_DIR/scripts/test_tab_naming.py"
  cp "$ROOT/tab-status/tab.sh" "$CLAUDE_DIR/scripts/tab.sh"
  cp "$ROOT/tab-status/tab-watcher.sh" "$CLAUDE_DIR/scripts/tab-watcher.sh"
  cp "$ROOT/tab-status/tn" "$CLAUDE_DIR/scripts/tn"
  cp "$ROOT/tab-status/tab-dots-selftest.sh" "$CLAUDE_DIR/scripts/tab-dots-selftest.sh"
  cp "$ROOT/tab-status/tab-autoname.py" "$CLAUDE_DIR/scripts/tab-autoname.py"
  chmod +x "$CLAUDE_DIR/scripts/tab.sh" "$CLAUDE_DIR/scripts/tab-watcher.sh" "$CLAUDE_DIR/scripts/tn" "$CLAUDE_DIR/scripts/tab-dots-selftest.sh"
  green "    copied scripts → ~/.claude/scripts/ (tab.sh, tab-watcher.sh, tn, tab-dots-selftest.sh, tab-autoname.py)"

  backup "$CLAUDE_SETTINGS"
  cat "$ROOT/tab-status/settings.json.snippet" | json_merge "$CLAUDE_SETTINGS"
  green "    migrated tab hooks and disabled native title/progress writers"
  if [ -f "$HOME/.claude-ccx/settings.json" ]; then
    backup "$HOME/.claude-ccx/settings.json"
    cat "$ROOT/tab-status/settings.json.snippet" | json_merge "$HOME/.claude-ccx/settings.json"
    green "    migrated the existing ccx profile without changing its models"
  fi

  if [ -f "$VSCODE_SETTINGS" ]; then
    backup "$VSCODE_SETTINGS"
    cat "$ROOT/tab-status/vscode-settings.snippet" | json_merge "$VSCODE_SETTINGS"
    green "    added terminal.integrated.tabs.title to VS Code settings"
  else
    dim "    VS Code user settings not found — skipping (install VS Code first)"
  fi

  if [ -f "$ZSHRC" ]; then
    if confirm "Install/update the known \`tn\` shell wrapper in ~/.zshrc?"; then
      backup "$ZSHRC"
      update_tab_shell
      green "    checked tn wrapper (open a new terminal to load)"
    fi
  fi

fi

echo

# --- skill-tab-name ---
cyan "[2/8] skill-tab-name (Claude picks tab names automatically)"
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
cyan "[3/8] skill-design-in-browser (design UI in the browser before coding)"
if confirm "Install the `design-in-browser` skill?"; then
  mkdir -p "$CLAUDE_DIR/skills/design-in-browser"
  cp "$ROOT/skill-design-in-browser/SKILL.md" "$CLAUDE_DIR/skills/design-in-browser/SKILL.md"
  green "    installed skill → ~/.claude/skills/design-in-browser/SKILL.md"
  dim "    fires on /design-in-browser and on phrases like 'show me design options'"
  dim "    uses an impeccable / UI-UX plugin if one is installed"
fi

echo

# --- statusline-gsd ---
cyan "[4/8] statusline-gsd (model + task + context bar + plan usage at bottom)"
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

# --- fable-plan ---
cyan "[5/8] fable-plan (Fable 5 plans, Sonnet 5 executes — \`fplan\` shell alias)"
if confirm "Install fable-plan?"; then
  if grep -q "alias fplan=" "$ZSHRC" 2>/dev/null; then
    dim "    fplan alias already in ~/.zshrc, skipping"
  else
    backup "$ZSHRC"
    cat "$ROOT/fable-plan/zshrc.snippet" >> "$ZSHRC"
    green "    appended fplan alias to ~/.zshrc (run \`source ~/.zshrc\` to load)"
  fi
  dim "    usage: fplan → plan mode = Fable 5 (1M context), execution = Sonnet 5"
  dim "    scoped per-session — plain \`claude\` sessions keep real Opus on /model opus"
fi

echo

# --- sticky-prompt ---
cyan "[6/8] sticky-prompt (the message you sent pinned to the top of the terminal)"
if confirm "Install sticky-prompt?"; then
  mkdir -p "$CLAUDE_DIR/scripts"
  cp "$ROOT/sticky-prompt/sticky-claude" "$CLAUDE_DIR/scripts/sticky-claude"
  chmod +x "$CLAUDE_DIR/scripts/sticky-claude"
  green "    copied sticky-claude → ~/.claude/scripts/"

  if [ -f "$VSCODE_SETTINGS" ]; then
    backup "$VSCODE_SETTINGS"
    cat "$ROOT/sticky-prompt/vscode-settings.snippet" | json_merge "$VSCODE_SETTINGS"
    green "    capped terminal sticky scroll at 3 rows in VS Code settings"
  else
    dim "    VS Code user settings not found — sticky scroll stays at its 5-row default"
  fi

  if grep -q "sticky-claude" "$ZSHRC" 2>/dev/null; then
    dim "    claude alias already in ~/.zshrc, skipping"
  elif confirm "Point the \`claude\` command at the wrapper (alias in ~/.zshrc)?"; then
    backup "$ZSHRC"
    echo "" >> "$ZSHRC"
    cat "$ROOT/sticky-prompt/zshrc.snippet" >> "$ZSHRC"
    green "    appended claude alias to ~/.zshrc (run \`source ~/.zshrc\` to load)"
  fi

  dim "    marks the message block in Claude's own output, so the marks land on it"
  dim "    \`command claude\` still runs Claude Code directly, without the wrapper"
  dim "    requires VS Code shell integration + terminal sticky scroll (both on by default)"
fi

echo

# --- multi-model ---
cyan "[7/8] multi-model (run Claude Code on your ChatGPT / Grok / Antigravity subscriptions)"
if confirm "Install multi-model?"; then
  if ! command -v brew >/dev/null 2>&1; then
    dim "    Homebrew not found — multi-model needs it to install the proxy. Skipping."
  else
    BREW_PREFIX="$(brew --prefix)"
    PROXY_CONF="$BREW_PREFIX/etc/cliproxyapi.conf"
    PROXY_AUTH_DIR="$HOME/.cli-proxy-api"

    if brew list cliproxyapi >/dev/null 2>&1; then
      dim "    cliproxyapi already installed"
    else
      brew install cliproxyapi
      green "    installed cliproxyapi"
    fi

    mkdir -p "$PROXY_AUTH_DIR"
    if [ ! -f "$PROXY_AUTH_DIR/local-key" ]; then
      head -c 24 /dev/urandom | base64 | tr -d '/+=' | cut -c1-32 > "$PROXY_AUTH_DIR/local-key"
      chmod 600 "$PROXY_AUTH_DIR/local-key"
      green "    generated a local proxy key → ~/.cli-proxy-api/local-key"
    else
      dim "    reusing the existing local proxy key"
    fi

    backup "$PROXY_CONF"
    sed "s|__LOCAL_KEY__|$(cat "$PROXY_AUTH_DIR/local-key")|" \
      "$ROOT/multi-model/config.template.yaml" > "$PROXY_CONF"
    green "    wrote proxy config → $PROXY_CONF (127.0.0.1 only)"

    mkdir -p "$CLAUDE_DIR/scripts"
    cp "$ROOT/multi-model/ccx" "$CLAUDE_DIR/scripts/ccx"
    cp "$ROOT/multi-model/ccx-models.py" "$CLAUDE_DIR/scripts/ccx-models.py"
    cp "$ROOT/multi-model/ccx-rewrite.js" "$CLAUDE_DIR/scripts/ccx-rewrite.js"
    cp "$ROOT/multi-model/sanitize-schema.js" "$CLAUDE_DIR/scripts/sanitize-schema.js"
    chmod +x "$CLAUDE_DIR/scripts/ccx" "$CLAUDE_DIR/scripts/ccx-rewrite.js"
    green "    copied ccx, models, and request cleaner → ~/.claude/scripts/"

    if grep -q "claude-addons: multi-model" "$ZSHRC" 2>/dev/null; then
      dim "    ~/.zshrc already wired up, skipping"
    elif confirm "Point \`claude\` at the multi-model launcher in ~/.zshrc?"; then
      backup "$ZSHRC"
      # sticky-prompt aliases claude to its own wrapper; ours calls that
      # wrapper underneath, so the later alias has to win.
      sed -i.tmp '/^alias claude=.*sticky-claude"$/d' "$ZSHRC" && rm -f "$ZSHRC.tmp"
      cat "$ROOT/multi-model/zshrc.snippet" >> "$ZSHRC"
      green "    \`claude\` now shows every provider's models (run \`source ~/.zshrc\` to load)"
      dim "    turn it off any time with \`ccx off\`, back on with \`ccx on\`"
    fi

    brew services start cliproxyapi >/dev/null 2>&1 || true
    green "    started the proxy (loopback only, key required)"
    dim "    next: run \`ccx --login\`, finish each sign-in in the browser, then \`ccx --refresh\`"
    dim "    \`claude\` itself is untouched and keeps its own login"
  fi
fi

# --- phone-alerts ---
cyan "[8/8] phone-alerts (push to your phone when Claude needs you)"
if confirm "Install phone-alerts?"; then
  mkdir -p "$CLAUDE_DIR/scripts"
  cp "$ROOT/phone-alerts/ntfy.sh" "$CLAUDE_DIR/scripts/ntfy.sh"
  chmod +x "$CLAUDE_DIR/scripts/ntfy.sh"
  green "    copied ntfy.sh -> ~/.claude/scripts/"

  backup "$CLAUDE_SETTINGS"
  cat "$ROOT/phone-alerts/settings.json.snippet" | json_merge "$CLAUDE_SETTINGS"
  green "    merged hooks into ~/.claude/settings.json"

  # The topic is a per-user secret: generated here, never in the repo, and
  # kept by uninstall.sh so a reinstall keeps the same subscription.
  if [ -s "$CLAUDE_DIR/ntfy-topic" ]; then
    dim "    reusing the existing ntfy topic in ~/.claude/ntfy-topic"
  else
    "$CLAUDE_DIR/scripts/ntfy.sh" --setup
  fi
  dim "    subscribe to that topic in the ntfy app to start receiving alerts"
  dim "    anyone who knows the topic can read your alerts - keep it private"
fi

echo
green "Done."
echo
dim "Next steps:"
dim "  1. Restart any existing Claude sessions so new hooks load."
dim "  2. Open a new VS Code terminal so the tabs.title setting takes effect."
dim "  3. Run \`claude\` — tab should show ⚪ on start, 🔴 when working, 🟢 when idle."
