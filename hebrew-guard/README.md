# hebrew-guard

Keeps Hebrew readable when Claude Code runs in the VS Code terminal.

Every new Claude Code session runs `hebrew-guard.py` once. It repairs, silently unless it had to act:

1. **VS Code terminal GPU drawing must be on.** With it off, or on "auto" falling back, Hebrew
   letters come out reversed inside every word. Turning it off is the tempting cure for washed-out
   terminal text. Don't: use `Cmd+Shift+P` → **Reload Window** instead.
2. **No right-to-left plugin may be enabled in Claude Code.** VS Code already lays out
   right-to-left text, so a plugin that pre-flips Hebrew makes it flip twice. Any enabled plugin
   whose name contains `rtl` or `bidi` is switched off; restart that session afterwards.

When it fixes something, Claude Code shows a line starting with `Hebrew guard:`.

Files it never touches: settings files it can't parse (for example a VS Code settings file with
comments). The installer always installs this add-on.

Tests: `python3 -m unittest test_hebrew_guard` from this folder.
