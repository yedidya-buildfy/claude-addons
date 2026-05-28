# claude-addons

Three small add-ons for [Claude Code](https://claude.com/claude-code) on macOS + VS Code:

| Addon | What it does |
|---|---|
| [**tab-status**](./tab-status) | Colored dot (⚪🔴🔵🟡🟢) on the VS Code terminal tab showing whether Claude is idle, working, waiting on you, or waiting on a background agent. |
| [**skill-tab-name**](./skill-tab-name) | A Claude Code skill that auto-picks a short 1–3 word tab name based on what your conversation is about. Silent — no popup; one open question at the end of the response so you can override. |
| [**statusline-gsd**](./statusline-gsd) | Drops in the [GSD project's](https://github.com/gsd-build/get-shit-done) statusline — model name, current task, context-usage bar at the bottom of every Claude session. |

The three are independent — install any combination. They share zero hard dependencies, but `skill-tab-name` does use the `tn` CLI installed by `tab-status`, so it's most useful with both.

## Install

```bash
git clone https://github.com/yedidya-buildfy/claude-addons.git
cd claude-addons
./install.sh
```

The installer is interactive — it asks before each addon, makes timestamped backups of anything it changes (`*.bak.YYYY-MM-DD-HHMMSS`), and is idempotent (safe to re-run).

## Uninstall

```bash
./uninstall.sh
```

Removes installed scripts and reverts the hook entries it added. Leaves `~/.zshrc` and `~/.claude/gsd-statusline.js` in place if you want to keep using them standalone.

## Requirements

- macOS (Linux likely works too — none of the install logic is Mac-specific, but it's not regularly tested there)
- VS Code (for `tab-status`; the OSC tab-title behavior is VS Code-specific)
- Claude Code (any recent version with hook + skill support)
- Node.js (already required by Claude Code)
- Python 3 (for JSON parsing in the hook script — `/usr/bin/python3` ships with macOS)

## What lives where after install

```
~/.claude/
├── scripts/
│   ├── tab.sh                 ← from tab-status/
│   ├── tab-watcher.sh         ← from tab-status/
│   └── tn                     ← from tab-status/
├── skills/tab-name/
│   └── SKILL.md               ← from skill-tab-name/
├── gsd-statusline.js          ← from statusline-gsd/
├── settings.json              ← hooks block merged in
└── terminal-state/            ← runtime state, auto-created

~/.zshrc                       ← optional `tn` shell wrapper appended
~/Library/Application Support/Code/User/settings.json
                               ← terminal.integrated.tabs.title added
```

## License

The repo's own code is MIT — see [`LICENSE`](./LICENSE). The bundled GSD statusline is also MIT, Copyright Lex Christopherson — see [`statusline-gsd/LICENSE`](./statusline-gsd/LICENSE) and [`statusline-gsd/ATTRIBUTION.md`](./statusline-gsd/ATTRIBUTION.md).
