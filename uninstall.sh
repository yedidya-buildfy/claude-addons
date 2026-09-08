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

# Remove scripts + skill
rm -f "$CLAUDE_DIR/scripts/tab.sh" "$CLAUDE_DIR/scripts/tab-watcher.sh" "$CLAUDE_DIR/scripts/tn"
rm -f "$CLAUDE_DIR/scripts/usage-fetch.sh" "$CLAUDE_DIR/cache/claude-usage.json"
rm -f "$CLAUDE_DIR/scripts/sticky-claude"
rm -f "$CLAUDE_DIR/scripts/ntfy.sh"
rm -rf "$CLAUDE_DIR/skills/tab-name"
green "  removed ~/.claude/scripts/{tab.sh,tab-watcher.sh,tn,usage-fetch.sh,sticky-claude} and ~/.claude/skills/tab-name/"

# Strip our hook entries from ~/.claude/settings.json
if [ -f "$CLAUDE_SETTINGS" ]; then
  node -e '
    const fs = require("fs");
    const file = process.argv[1];
    const cfg = JSON.parse(fs.readFileSync(file, "utf8"));
    if (cfg.hooks) {
      const isOurs = h => ["tab.sh", "tab-autoname.py", "ntfy.sh"]
        .some(name => JSON.stringify(h).includes(name));
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
  green "  stripped tab-status and phone-alerts hooks from ~/.claude/settings.json"

  # fable-plan: remove the opus→fable alias override if it's ours
  node -e '
    const fs = require("fs");
    const file = process.argv[1];
    const cfg = JSON.parse(fs.readFileSync(file, "utf8"));
    if (cfg.env && cfg.env.ANTHROPIC_DEFAULT_OPUS_MODEL === "claude-fable-5") {
      delete cfg.env.ANTHROPIC_DEFAULT_OPUS_MODEL;
      if (Object.keys(cfg.env).length === 0) delete cfg.env;
    }
    fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n");
  ' "$CLAUDE_SETTINGS"
  green "  removed fable-plan env override from ~/.claude/settings.json"
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
    if (cfg["terminal.integrated.stickyScroll.maxLineCount"] === 3) {
      delete cfg["terminal.integrated.stickyScroll.maxLineCount"];
    }
    fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n");
  ' "$VSCODE_SETTINGS"
  green "  reverted terminal.integrated.tabs.title + stickyScroll.maxLineCount in VS Code settings"
fi

# phone-alerts: keep ~/.claude/ntfy-topic so a reinstall lands on the same
# topic and the phone stays subscribed. Delete it by hand to cut it loose.
if [ -f "$CLAUDE_DIR/ntfy-topic" ]; then
  dim "  ntfy topic kept at ~/.claude/ntfy-topic - delete it to stop for good"
fi

# multi-model: remove the launcher and stop the proxy, but keep the OAuth
# logins in ~/.cli-proxy-api — re-signing in to every provider is a real cost
# to redo, and they are useless to anyone without the local key anyway.
if command -v brew >/dev/null 2>&1; then
  CCX_BIN="$(brew --prefix)/bin/ccx"
  if [ -L "$CCX_BIN" ] && [ "$(readlink "$CCX_BIN")" = "$CLAUDE_DIR/scripts/ccx" ]; then
    rm -f "$CCX_BIN"
  fi
fi
rm -f "$CLAUDE_DIR/scripts/ccx" "$CLAUDE_DIR/scripts/ccx-models.py" \
  "$CLAUDE_DIR/scripts/ccx-rewrite.js" "$CLAUDE_DIR/scripts/sanitize-schema.js" \
  "$CLAUDE_DIR/scripts/ccx-rewrite-selftest.js" "$CLAUDE_DIR/scripts/ccx-models-selftest.py" \
  "$CLAUDE_DIR/scripts/install-config.py" "$CLAUDE_DIR/scripts/install-config-selftest.py" \
  "$CLAUDE_DIR/scripts/config.template.yaml"
rm -f "$HOME/.claude-ccx/ccx-catalogue.json" "$HOME/.cli-proxy-api/ccx-defaults.json" "$HOME/.cli-proxy-api/ccx-mode"
rm -f "$HOME/.claude-ccx/agents/ask-chatgpt.md" "$HOME/.claude-ccx/agents/ask-antigravity.md" "$HOME/.claude-ccx/agents/ask-grok.md" "$HOME/.claude-ccx/agents/ask-kimi.md"
if command -v brew >/dev/null 2>&1 && brew list cliproxyapi >/dev/null 2>&1; then
  brew services stop cliproxyapi >/dev/null 2>&1 || true
  green "  removed ccx and stopped the model proxy"
  dim "  the proxy itself is still installed: brew uninstall cliproxyapi"
  dim "  provider logins kept at ~/.cli-proxy-api/ — delete that folder to sign out"
  if [ -f "$HOME/.cli-proxy-api/claude-defaults.stash.json" ]; then
    node -e '
      const fs=require("fs"), s=process.env.HOME+"/.claude/settings.json", b=process.env.HOME+"/.cli-proxy-api/claude-defaults.stash.json";
      const cfg=JSON.parse(fs.readFileSync(s,"utf8")), back=JSON.parse(fs.readFileSync(b,"utf8"));
      for (const k of ["model","effortLevel"]) { delete cfg[k]; if (k in back) cfg[k]=back[k]; }
      fs.writeFileSync(s, JSON.stringify(cfg,null,2)+"\n");
    '
    rm -f "$HOME/.cli-proxy-api/claude-defaults.stash.json"
    green "  restored your own default model and effort into ~/.claude/settings.json"
  fi
else
  green "  removed ccx"
fi

# Clean state dir
rm -rf "$CLAUDE_DIR/terminal-state"
green "  removed ~/.claude/terminal-state/"

echo
dim "Note: ~/.zshrc and gsd-statusline.js are NOT touched — remove manually if desired."
echo
green "Done."
