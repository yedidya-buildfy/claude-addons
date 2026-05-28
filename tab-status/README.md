# tab-status — colored dot on the VS Code terminal tab

Each Claude Code session gets a colored circle prefix on its VS Code terminal tab title, reflecting Claude's current state at a glance:

| Dot | Meaning |
|---|---|
| ⚪ | Session just started, no commands yet |
| 🔴 | Claude is processing your prompt |
| 🔵 | Claude is waiting for your answer to a question (`AskUserQuestion`) |
| 🟡 | Main response done, background agents still running |
| 🟢 | Idle / done, ready for the next prompt |

## How it works

Two scripts plus seven Claude Code hooks:

- **`tab.sh`** — hook handler. Receives the event (`white`, `red`, `blue`, `green`, `bg-inc`, `bg-dec`, `session-end`) and updates a per-session state file in `~/.claude/terminal-state/<session>.state`. Does NOT paint directly.
- **`tab-watcher.sh`** — spawned by `tab.sh` on SessionStart (and self-respawned on any later hook if missing). Runs in the background for the life of the Claude session, reading the state file and writing OSC escape sequences (`\033]0;<dot> <name>\a`) to the controlling TTY every 300 ms.
- **`tn`** — small CLI that sets/clears a per-terminal name override. Callable from your shell (via the `tn()` zsh function) **or from Claude's Bash tool**.

The watcher exists because Claude Code itself emits OSC title sequences (its auto-summarized session label, e.g. `* Count to ten in Hebrew`). A one-shot paint from the hook would lose the race — Claude rewrites the title after our hook returns. The watcher paints fast enough (5 Hz) that we win within ~300 ms of any of Claude's writes, so the dot stays stable.

## Hooks wired up

| Hook | Action | State |
|---|---|---|
| `SessionStart` | `tab.sh white` | ⚪ |
| `UserPromptSubmit` | `tab.sh red` | 🔴 |
| `PreToolUse` (matcher: `Agent`) | `tab.sh bg-inc` | counter only |
| `PreToolUse` (matcher: `AskUserQuestion`) | `tab.sh blue` | 🔵 |
| `PostToolUse` (matcher: `AskUserQuestion`) | `tab.sh red` | 🔴 (back to working) |
| `SubagentStop` | `tab.sh bg-dec` | counter only |
| `Stop` | `tab.sh green` | 🟢 or 🟡 if `bg > 0` |
| `SessionEnd` | `tab.sh session-end` | cleanup |

## State files

In `~/.claude/terminal-state/`:

| File | Contents |
|---|---|
| `<session>.state` | `white` / `red` / `blue` / `green` |
| `<session>.bg` | background-agent counter (integer) |
| `<session>.name` | display name for the tab (auto = project basename) |
| `<session>.watcher_pid` | PID of the running watcher |
| `tty.<ttysNNN>.name` | manual override set by `tn <name>` |
| `hooks.log` | every hook fire |
| `watcher.log` | watcher start/exit + heartbeat every ~6 s |

## Manually renaming a tab

```bash
tn payplus     # tab becomes "🟢 payplus" (color updates with state)
tn             # clears override, back to auto-name (project basename)
```

Note: VS Code's right-click → Rename sets a *static* tab title that ignores OSC sequences. To get the dot, use `tn` instead.

## Letting Claude rename tabs for you (skill — optional)

This addon ships a Claude Code skill at [`skill-tab-name/SKILL.md`](./skill-tab-name/SKILL.md). When installed, Claude will:

- **Pick a name on its own** as soon as your intent is clear (usually after your 1st or 2nd substantive message)
- **Apply it silently** via `~/.claude/scripts/tn "<name>"` — no UI popup
- **Add one short text question at the end of the response** so you can override: `(Renamed tab to "auth bug" — want a different one?)`
- **Re-fire on topic shifts** the same way
- **Fire on `/tab-name`** or natural-language requests like "rename tab", "שנה שם לטרמינל"

The default is low friction — no `AskUserQuestion` popup, no separate confirmation step. The name just changes, and you correct it in a few words if you don't like it. The skill only uses `AskUserQuestion` if you explicitly ask for choices (e.g. "give me options for the name").

Install the skill manually (or let `install.sh` do it):
```bash
mkdir -p ~/.claude/skills/tab-name
cp tab-status/skill-tab-name/SKILL.md ~/.claude/skills/tab-name/SKILL.md
```

Name style: **1–3 words, prefer 2, lowercase, skill-like.** Good: `payplus`, `auth bug`, `tab dots`, `docs cleanup`. Bad: long sentences, version suffixes, generic words.

## Debugging

```bash
tail -f ~/.claude/terminal-state/watcher.log   # heartbeat every ~6 s, includes paint_ok=1/0
tail -f ~/.claude/terminal-state/hooks.log     # every hook fire
ps -ef | grep tab-watcher | grep -v grep       # running watchers
```

If `paint_ok=0` consistently, the watcher can't write to `/dev/<tty>` — check the TTY device exists and is writable.

If no watcher is running for a session that should have one, just submit a prompt in that terminal — the script will self-heal by spawning a fresh watcher.
