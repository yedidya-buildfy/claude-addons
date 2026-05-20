# statusline-gsd — bundled GSD statusline

This directory bundles `gsd-statusline.js` from the [GSD project](https://github.com/gsd-build/get-shit-done) so the install script can drop it into `~/.claude/` without you needing to install the full GSD distribution.

**This is not my code.** It's an unmodified copy. See [`ATTRIBUTION.md`](./ATTRIBUTION.md) for credits and [`LICENSE`](./LICENSE) for the upstream MIT license.

## What it shows

Inside the Claude Code statusline at the bottom of every terminal:

```
Opus 4.7 (1M context) │ dashbord │ ████░░░░░░ 48%
```

- **Model** — current Claude model
- **Middle** — currently active TODO task, OR GSD planning state if any `.planning/STATE.md` is found in your workspace, OR omitted
- **Directory** — basename of cwd
- **Context bar** — 10-segment progress bar showing how much of the *usable* context window is consumed. Color-coded:
  - 🟩 green < 50%
  - 🟨 yellow 50–65%
  - 🟧 orange 65–80%
  - 🟥 blinking red 💀 ≥ 80%

The bar accounts for Claude Code's auto-compact buffer (~16.5% by default), so 100% on the bar = full usable context (compaction trigger), not 100% of the raw token budget.

## Manual install

Copy `gsd-statusline.js` into `~/.claude/` and point your `~/.claude/settings.json` `statusLine` at it:

```json
{
  "statusLine": {
    "type": "command",
    "command": "node ~/.claude/gsd-statusline.js"
  }
}
```

## Full GSD distribution

This is a one-file convenience copy. If you want the **complete** GSD experience — planning workflows, slash commands like `/gsd-plan-phase`, the context-monitor PostToolUse hook, the update checker, the skills plugin — install GSD directly from upstream: https://github.com/gsd-build/get-shit-done

I am not affiliated with TÂCHES or Lex Christopherson. This bundle exists only because I find the statusline genuinely useful and wanted my repo to be self-contained.
