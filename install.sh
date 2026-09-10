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
VSCODE_KEYBINDINGS="$HOME/Library/Application Support/Code/User/keybindings.json"
ZSHRC="$HOME/.zshrc"

cyan() { printf '\033[36m%s\033[0m\n' "$1"; }
dim()  { printf '\033[2m%s\033[0m\n' "$1"; }
green(){ printf '\033[32m%s\033[0m\n' "$1"; }

INSTALL_MODE="interactive"
for arg in "$@"; do
  case "$arg" in
    --update) INSTALL_MODE="update" ;;
    --yes|-y) INSTALL_MODE="yes" ;;
  esac
done

is_installed() {
  local comp="$1"
  case "$comp" in
    tab-status) [ -f "$CLAUDE_DIR/scripts/tab.sh" ] ;;
    skill-tab-name) [ -f "$CLAUDE_DIR/skills/tab-name/SKILL.md" ] ;;
    skill-design-in-browser) [ -f "$CLAUDE_DIR/skills/design-in-browser/SKILL.md" ] ;;
    skill-extras) [ -f "$CLAUDE_DIR/skills/explain-problem/SKILL.md" ] ;;
    statusline-gsd) [ -f "$CLAUDE_DIR/gsd-statusline.js" ] ;;
    fable-plan) grep -q "alias fplan=" "$ZSHRC" 2>/dev/null ;;
    sticky-prompt) [ -f "$CLAUDE_DIR/scripts/sticky-claude" ] ;;
    multi-model) [ -f "$CLAUDE_DIR/scripts/ccx" ] || [ -f "$(brew --prefix 2>/dev/null)/bin/ccx" ] ;;
    phone-alerts) [ -f "$CLAUDE_DIR/scripts/ntfy.sh" ] ;;
    agent-locks) [ -f "$CLAUDE_DIR/scripts/agent-locks.mjs" ] ;;
    *) return 1 ;;
  esac
}

confirm() {
  local prompt="$1"
  local comp="${2:-}"
  if [ "$INSTALL_MODE" = "yes" ]; then return 0; fi
  if [ "$INSTALL_MODE" = "update" ]; then
    if [ -n "$comp" ] && is_installed "$comp"; then
      dim "    updating $comp..."
      return 0
    fi
    return 1
  fi
  read -p "  $prompt [y/N] " r
  [ "$r" = "y" ] || [ "$r" = "Y" ]
}

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

keybindings_merge() {
  local file="$1"
  local incoming
  incoming=$(cat)
  mkdir -p "$(dirname "$file")"
  [ -f "$file" ] || echo '[]' > "$file"
  node -e '
    const fs = require("fs");
    const file = process.argv[1];
    const incoming = JSON.parse(process.argv[2]);
    // Strip // comments VS Code allows in keybindings.json before parsing.
    const raw = fs.readFileSync(file, "utf8").replace(/^\s*\/\/.*$/gm, "");
    const target = raw.trim() ? JSON.parse(raw) : [];
    const seen = new Set(target.map(x => JSON.stringify(x)));
    for (const item of incoming) {
      const key = JSON.stringify(item);
      if (!seen.has(key)) { target.push(item); seen.add(key); }
    }
    const temporary = file + ".tmp." + process.pid;
    fs.writeFileSync(temporary, JSON.stringify(target, null, 4) + "\n");
    fs.renameSync(temporary, file);
  ' "$file" "$incoming"
}

cyan "claude-addons installer"
echo

# --- tab-status ---
cyan "[1/10] tab-status (colored dot on VS Code terminal tabs)"
if confirm "Install tab-status?" "tab-status"; then
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

  if [ -d "$(dirname "$VSCODE_SETTINGS")" ]; then
    mkdir -p "$HOME/.vscode/extensions/claude-tab-rename"
    cp "$ROOT/tab-status/vscode-extension/package.json" "$ROOT/tab-status/vscode-extension/extension.js" \
       "$HOME/.vscode/extensions/claude-tab-rename/"
    backup "$VSCODE_KEYBINDINGS"
    cat "$ROOT/tab-status/vscode-keybindings.snippet" | keybindings_merge "$VSCODE_KEYBINDINGS"
    green "    installed the rename extension and took over Enter/F2 on terminal tabs"
    dim "    reload VS Code once; renaming a tab no longer freezes its dot"
  fi

  if [ "$INSTALL_MODE" != "update" ] && [ -f "$ZSHRC" ]; then
    if confirm "Install/update the known \`tn\` shell wrapper in ~/.zshrc?"; then
      backup "$ZSHRC"
      update_tab_shell
      green "    checked tn wrapper (open a new terminal to load)"
    fi
  fi

fi

echo

# --- skill-tab-name ---
cyan "[2/10] skill-tab-name (Claude picks tab names automatically)"
if confirm "Install the \`tab-name\` skill?" "skill-tab-name"; then
  mkdir -p "$CLAUDE_DIR/skills/tab-name"
  cp "$ROOT/skill-tab-name/SKILL.md" "$CLAUDE_DIR/skills/tab-name/SKILL.md"
  green "    installed skill → ~/.claude/skills/tab-name/SKILL.md"
  dim "    fires on /tab-name, on phrases like 'rename tab', and auto-fires when topic shifts"
  dim "    requires tab-status (for the \`tn\` CLI it calls)"

  if [ "$INSTALL_MODE" != "update" ] && confirm "Also append a reminder to ~/.claude/CLAUDE.md for max reliability?"; then
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
cyan "[3/10] skill-design-in-browser (design UI in the browser before coding)"
if confirm "Install the \`design-in-browser\` skill?" "skill-design-in-browser"; then
  mkdir -p "$CLAUDE_DIR/skills/design-in-browser"
  cp "$ROOT/skill-design-in-browser/SKILL.md" "$CLAUDE_DIR/skills/design-in-browser/SKILL.md"
  green "    installed skill → ~/.claude/skills/design-in-browser/SKILL.md"
  dim "    fires on /design-in-browser and on phrases like 'show me design options'"
  dim "    uses an impeccable / UI-UX plugin if one is installed"
fi

echo

# --- extra skills ---
cyan "[4/10] skill-extras (chat summary + problem breakdown)"
if confirm "Install the \`conversation-summary\` and \`explain-problem\` skills?" "skill-extras"; then
  for skill in conversation-summary explain-problem; do
    mkdir -p "$CLAUDE_DIR/skills/$skill"
    cp "$ROOT/skill-$skill/SKILL.md" "$CLAUDE_DIR/skills/$skill/SKILL.md"
  done
  green "    installed skills → ~/.claude/skills/{conversation-summary,explain-problem}/"
  dim "    fire on /conversation-summary, /explain-problem, and Hebrew phrasings of both"
fi

echo

# --- statusline-gsd ---
cyan "[5/10] statusline-gsd (model + task + context bar + plan usage at bottom)"
if confirm "Install GSD statusline?" "statusline-gsd"; then
  cp "$ROOT/statusline-gsd/gsd-statusline.js" "$CLAUDE_DIR/gsd-statusline.js"
  cp "$ROOT/statusline-gsd/provider-usage.js" "$CLAUDE_DIR/provider-usage.js"
  green "    copied gsd-statusline.js + provider-usage.js → ~/.claude/"

  mkdir -p "$CLAUDE_DIR/scripts"
  cp "$ROOT/statusline-gsd/usage-fetch.sh" "$CLAUDE_DIR/scripts/usage-fetch.sh"
  chmod +x "$CLAUDE_DIR/scripts/usage-fetch.sh"
  green "    copied usage-fetch.sh → ~/.claude/scripts/ (plan-usage cache refresher)"

  backup "$CLAUDE_SETTINGS"
  # refreshInterval redraws the line on a timer as well as on events, so the
  # connection and output-rate readings stay current while a turn is running.
  echo '{"statusLine":{"type":"command","command":"node ~/.claude/gsd-statusline.js","refreshInterval":1}}' | json_merge "$CLAUDE_SETTINGS"
  green "    set statusLine in ~/.claude/settings.json (redraws every second)"

  # The live tokens-per-second meter is fed by a MessageDisplay hook that
  # records how much text streamed and how much of it was Latin script. It
  # stores lengths only, never the text. Without jq the meter simply stays on
  # the finished-reply rate; nothing else in the status line depends on it.
  if command -v jq >/dev/null 2>&1; then
    json_merge "$CLAUDE_SETTINGS" <<'HOOKJSON'
{"hooks":{"MessageDisplay":[{"hooks":[{"type":"command","timeout":5,"command":"jq -rj '(.session_id)+\" \"+(now*1000|floor|tostring)+\" \"+(.delta|length|tostring)+\" \"+(.delta|explode|map(select(.<128))|length|tostring)+\"\\n\"' >> ~/.claude/cache/stream-rate.log"}]}]}}
HOOKJSON
    green "    live output-rate meter enabled (MessageDisplay hook)"
  else
    dim "    jq not found — live output-rate meter stays off, everything else works"
  fi
fi

# --- fable-plan ---
cyan "[6/10] fable-plan (Fable 5 plans, Sonnet 5 executes — \`fplan\` shell alias)"
if confirm "Install fable-plan?" "fable-plan"; then
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
cyan "[7/10] sticky-prompt (the message you sent pinned to the top of the terminal)"
if confirm "Install sticky-prompt?" "sticky-prompt"; then
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
  elif [ "$INSTALL_MODE" != "update" ] && confirm "Point the \`claude\` command at the wrapper (alias in ~/.zshrc)?"; then
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
cyan "[8/10] multi-model (run Claude Code on your ChatGPT / Grok / Antigravity subscriptions)"
if confirm "Install multi-model?" "multi-model"; then
  if [ "$INSTALL_MODE" = "update" ] || [ "$INSTALL_MODE" = "yes" ]; then
    "$ROOT/multi-model/install.sh" --yes
  else
    "$ROOT/multi-model/install.sh"
  fi
  green "    installed global \`ccx\` command with backups and self-tests"

  if grep -q "claude-addons: multi-model" "$ZSHRC" 2>/dev/null; then
    dim "    ~/.zshrc already wired up, skipping"
  elif [ "$INSTALL_MODE" != "update" ] && confirm "Also point \`claude\` at the multi-model launcher in ~/.zshrc?"; then
    backup "$ZSHRC"
    # sticky-prompt aliases claude to its own wrapper; ours calls that
    # wrapper underneath, so the later alias has to win.
    sed -i.tmp '/^alias claude=.*sticky-claude"$/d' "$ZSHRC" && rm -f "$ZSHRC.tmp"
    cat "$ROOT/multi-model/zshrc.snippet" >> "$ZSHRC"
    green "    \`claude\` now follows the \`ccx on|off\` toggle (run \`source ~/.zshrc\`)"
  fi
fi

# --- phone-alerts ---
cyan "[9/10] phone-alerts (push to your phone when Claude needs you)"
if confirm "Install phone-alerts?" "phone-alerts"; then
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

# --- agent-locks ---
echo
cyan "[10/10] agent-locks (warn when two sessions touch the same file, or deploy at once)"
if confirm "Install agent-locks?" "agent-locks"; then
  mkdir -p "$CLAUDE_DIR/scripts"
  cp "$ROOT/agent-locks/agent-locks.mjs" "$CLAUDE_DIR/scripts/agent-locks.mjs"
  chmod +x "$CLAUDE_DIR/scripts/agent-locks.mjs"
  green "    copied agent-locks.mjs -> ~/.claude/scripts/"

  backup "$CLAUDE_SETTINGS"
  cat "$ROOT/agent-locks/settings.json.snippet" | json_merge "$CLAUDE_SETTINGS"
  if [ -f "$HOME/.claude-ccx/settings.json" ]; then
    backup "$HOME/.claude-ccx/settings.json"
    cat "$ROOT/agent-locks/settings.json.snippet" | json_merge "$HOME/.claude-ccx/settings.json"
  fi
  green "    merged hooks into ~/.claude/settings.json"
  dim "    it only warns - see who holds what with: node ~/.claude/scripts/agent-locks.mjs list"
fi

# --- auto-update setup ---
echo
cyan "[auto-update] automatic background updates from repository"
mkdir -p "$CLAUDE_DIR/scripts"
echo "$ROOT" > "$CLAUDE_DIR/addons-repo-path"
if [ -d "$HOME/.claude-ccx" ]; then
  echo "$ROOT" > "$HOME/.claude-ccx/addons-repo-path"
fi
cp "$ROOT/auto-update/claude-addons-update.sh" "$CLAUDE_DIR/scripts/claude-addons-update.sh"
chmod +x "$CLAUDE_DIR/scripts/claude-addons-update.sh"

update_hook='{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"$HOME/.claude/scripts/claude-addons-update.sh --quiet &"}]}]}}'
echo "$update_hook" | json_merge "$CLAUDE_SETTINGS"
if [ -f "$HOME/.claude-ccx/settings.json" ]; then
  echo "$update_hook" | json_merge "$HOME/.claude-ccx/settings.json"
fi
green "    registered background auto-update hook (checks once every 12h)"

echo
green "Done."
echo
dim "Next steps:"
dim "  1. Restart any existing Claude sessions so new hooks load."
dim "  2. Open a new VS Code terminal so the tabs.title setting takes effect."
dim "  3. Run \`claude\` — tab should show ⚪ on start, 🔴 when working, 🟢 when idle."
