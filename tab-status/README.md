# tab-status — colored dot on the VS Code terminal tab

Each Claude Code session gets a colored circle prefix on its VS Code terminal tab title, reflecting Claude's current state at a glance:

| Dot | Meaning |
|---|---|
| ⚪ | Session just started, no commands yet |
| 🔴 | Claude is processing your prompt |
| 🟡 | Main response done, background agents still running |
| 🟢 | Idle / done, ready for the next prompt |

## How it works

Two scripts plus six Claude Code hooks:

- **`tab.sh`** — hook handler. Receives the event (`white`, `red`, `green`, `bg-inc`, `bg-dec`, `session-end`) and updates a per-session state file in `~/.claude/terminal-state/<session>.state`. Does NOT paint directly.
- **`tab-watcher.sh`** — spawned by `tab.sh` on SessionStart (and self-respawned on any later hook if missing). Runs in the background for the life of the Claude session, reading the state file and writing OSC escape sequences (`\033]0;<dot> <name>\a`) to the controlling TTY every 300 ms.

The watcher exists because Claude Code itself emits OSC title sequences (its auto-summarized session label, e.g. `* Count to ten in Hebrew`). A one-shot paint from the hook would lose the race — Claude rewrites the title after our hook returns. The watcher paints fast enough (5 Hz) that we win within ~300 ms of any of Claude's writes, so the dot stays stable.

State files live in `~/.claude/terminal-state/`:

| File | Contents |
|---|---|
| `<session>.state` | `white` / `red` / `green` |
| `<session>.bg` | background-agent counter (integer) |
| `<session>.name` | display name for the tab |
| `<session>.watcher_pid` | PID of the running watcher |
| `tty.<ttysNNN>.name` | manual override set by `tn <name>` from the shell |
| `hooks.log` | every hook fire |
| `watcher.log` | watcher start/exit + heartbeat every ~6 s |

## Manual install

If you don't use the top-level `install.sh`:

1. Copy `tab.sh` and `tab-watcher.sh` into `~/.claude/scripts/` (create the directory if needed) and `chmod +x` both.
2. Merge the contents of `settings.json.snippet` into your `~/.claude/settings.json` under the existing `hooks` key (don't overwrite the file — preserve `statusLine`, `theme`, etc.).
3. Add the contents of `vscode-settings.snippet` to your VS Code user settings (`Cmd+Shift+P` → "Preferences: Open User Settings (JSON)") — specifically the line `"terminal.integrated.tabs.title": "${sequence}"`.
4. (Optional) Append `zshrc.snippet` to your `~/.zshrc` for the `tn <name>` shell function.

## Manually renaming a tab

```bash
tn payplus     # tab becomes "🟢 payplus" (color updates with state)
tn             # clears override, back to auto-name (project basename)
```

Note: VS Code's right-click → Rename sets a *static* tab title that ignores OSC sequences. To get the dot, use `tn` instead.

## Debugging

```bash
tail -f ~/.claude/terminal-state/watcher.log   # heartbeat every ~6 s, includes paint_ok=1/0
tail -f ~/.claude/terminal-state/hooks.log     # every hook fire
ps -ef | grep tab-watcher | grep -v grep       # running watchers
```

If `paint_ok=0` consistently, the watcher can't write to `/dev/<tty>` — check the TTY device exists and is writable.

If no watcher is running for a session that should have one, just submit a prompt in that terminal — the script will self-heal by spawning a fresh watcher.
