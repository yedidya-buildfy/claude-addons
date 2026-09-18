#!/usr/bin/env python3
"""Keep Hebrew readable in Claude Code inside the VS Code terminal.

Runs at the start of every Claude Code session and repairs the two things
that have made Hebrew come out with its letters reversed:

1. VS Code's terminal must draw with the GPU. With it off, or on "auto"
   falling back, Hebrew letters come out reversed. (Turning it off is the
   tempting cure for washed-out terminal text; the right cure for that is
   "Reload Window".)
2. No right-to-left "fixer" plugin may be enabled in Claude Code. VS Code
   already lays out right-to-left text, so a plugin that pre-flips Hebrew
   makes it flip twice.

Silent when everything is fine. Never fails the session.
"""
import json
import os
import re
import sys

HOME = os.path.expanduser("~")
VSCODE = os.path.join(HOME, "Library/Application Support/Code/User/settings.json")
CLAUDE = [os.path.join(HOME, ".claude/settings.json"),
          os.path.join(HOME, ".claude-ccx/settings.json")]
GPU_KEY = "terminal.integrated.gpuAcceleration"
RTL_PLUGIN = re.compile(r"rtl|bidi", re.I)


def load(path):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return None  # missing, mid-write, or has comments: leave it alone


def save(path, data):
    tmp = f"{path}.tmp.{os.getpid()}"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
        f.write("\n")
    os.replace(tmp, path)


def fix_vscode():
    data = load(VSCODE)
    if not isinstance(data, dict) or data.get(GPU_KEY) == "on":
        return None
    was = data.get(GPU_KEY, "unset")
    data[GPU_KEY] = "on"
    save(VSCODE, data)
    return f'VS Code terminal GPU drawing was "{was}" - set it back to "on".'


def fix_plugins():
    fixed = []
    for path in CLAUDE:
        data = load(path)
        plugins = data.get("enabledPlugins") if isinstance(data, dict) else None
        if not isinstance(plugins, dict):
            continue
        bad = [k for k, on in plugins.items() if on and RTL_PLUGIN.search(k)]
        if bad:
            for k in bad:
                plugins[k] = False
            save(path, data)
            fixed += bad
    if fixed:
        return (f"Disabled right-to-left plugin(s) {', '.join(sorted(set(fixed)))}. "
                "Restart this Claude session for Hebrew to read correctly.")
    return None


def main():
    notes = []
    for fix in (fix_vscode, fix_plugins):
        try:
            note = fix()
        except Exception as e:  # a guard must never break the session
            note = f"hebrew-guard skipped a check: {e}"
        if note:
            notes.append(note)
    if notes:
        print(json.dumps({"systemMessage": "Hebrew guard: " + " ".join(notes)}))


if __name__ == "__main__":
    main()
    sys.exit(0)
