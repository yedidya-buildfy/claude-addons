# claude-addons

Two small add-ons for [Claude Code](https://claude.com/claude-code) on macOS + VS Code:

| Addon | What it does |
|---|---|
| [**tab-status**](./tab-status) | Colored dot (⚪🔴🔵🟡🟢) on the VS Code terminal tab showing whether Claude is idle, working, waiting on you, or waiting on a background agent. Optional: Claude can suggest tab names when the task changes |
| [**statusline-gsd**](./statusline-gsd) | Drops in the [GSD project's](https://github.com/gsd-build/get-shit-done) statusline — model name, current task, context-usage bar at the bottom of every Claude session |

The two are independent — install one or both. They share zero code.

## Install

```bash
git clone https://github.com/<your-username>/claude-addons.git
cd claude-addons
./install.sh
```

The installer is interactive — it'll ask before touching each file, makes timestamped backups of anything it changes (`*.bak.YYYY-MM-DD-HHMMSS`), and prints what it did. Re-run it any time to update.

## Uninstall

```bash
./uninstall.sh
```

Removes the installed scripts and reverts the hook entries it added. Leaves the GSD statusline file in `~/.claude/` if you want to keep using it standalone.

## Requirements

- macOS (Linux likely works too — install.sh doesn't use anything Mac-specific, but I haven't tested it)
- VS Code (for tab-status; the OSC tab-title behavior is VS Code-specific)
- Claude Code (any recent version with hook support)
- Node.js (already required by Claude Code, so already installed)
- Python 3 (for JSON parsing in the hook script — `/usr/bin/python3` ships with macOS)

## What lives where after install

```
~/.claude/
├── scripts/
│   ├── tab.sh                 ← from tab-status/
│   └── tab-watcher.sh         ← from tab-status/
├── gsd-statusline.js          ← from statusline-gsd/
├── settings.json              ← hooks block merged in
└── terminal-state/            ← runtime state, auto-created

~/.zshrc                       ← optional `tn` function appended
~/Library/Application Support/Code/User/settings.json
                               ← terminal.integrated.tabs.title added
```

## License

The repo's own code is MIT — see [`LICENSE`](./LICENSE). The bundled GSD statusline is also MIT, copyright Lex Christopherson — see [`statusline-gsd/LICENSE`](./statusline-gsd/LICENSE) and [`statusline-gsd/ATTRIBUTION.md`](./statusline-gsd/ATTRIBUTION.md).
