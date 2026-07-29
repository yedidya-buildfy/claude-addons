---
name: tab-name
description: Set the VS Code terminal tab to a short name that reflects the current conversation topic. Naming is normally automatic (a hook names the tab from the user's own prompt), so this skill is for EXPLICIT rename requests and for the fallback case where a hook message says the automatic naming failed. Trigger on /tab-name, "rename tab", "change tab name", "set tab name", "tab name", "שנה שם לטרמינל", "תן שם לטרמינל", "החלף שם", "תקרא לטאב".
when_to_use: Fire when the user explicitly asks to rename the tab, or when a hook message reports that the automatic namer failed and the tab still shows the placeholder. Do NOT fire proactively otherwise — the hook already handles naming. Never rename over a pinned name unless the user asked.
disable-model-invocation: false
---

# Rename the VS Code terminal tab

This addon paints a colored dot + short name on each VS Code terminal tab. The default name is the project directory basename — a placeholder.

**Naming is normally not your job.** A `UserPromptSubmit` hook (`tab-autoname.py`) reads the user's own prompt, asks a cheap model for a 2–3 word topic label in the language the user wrote in, and applies it. You step in only when:

- the user explicitly asks for a rename, or
- a hook message tells you the automatic namer failed and the tab is still on the placeholder.

Everything below describes what to do in those two cases.

## The flow — low friction by default

1. **Decide** on a 1–3 word name yourself (prefer 2 words). Skill-style, lowercase, descriptive.
2. **Apply it silently** by running `~/.claude/scripts/tn --auto "<name>"`. The `--auto` flag marks it as an AI guess (NOT pinned) so you can still refine it on topic shifts. No announcement mid-response, no AskUserQuestion popup.
3. **At the end of your normal response**, add ONE short sentence — a plain open-ended question, like:
   > `(Renamed tab to "auth bug" — want a different one?)`

   That's it. One line. Question mark. Don't make it a separate paragraph or use any AskUserQuestion tool.
4. **If the user disagrees or suggests a different name** in their next message, apply it immediately with `tn "<their name>"` (no `--auto` — a name the user dictated is pinned). Acknowledge briefly. Move on.

The point: the user almost never has to engage with the rename. The name just appears, and they can correct it any time with a few words.

## When to fire

| Situation | Action |
|---|---|
| Automatic naming is working (the usual case) | Do nothing — the hook owns it |
| A hook message says the automatic namer failed | `tn --auto` your best guess + one-line confirm at end |
| User says `"rename tab to payplus"` (specific name) | `tn "payplus"` directly (pinned) — no question, no confirmation |
| User says `"rename tab"` / `/tab-name` (no name) | `tn --auto` your best guess + one-line confirm at end |
| You already named the tab AND topic hasn't changed | Do nothing |
| **Name is pinned** (`<session>.pinned` exists) AND user didn't ask | Respect it, do nothing — never `tn --auto` over a pin |

## Use AskUserQuestion only if explicitly asked

If the user says `"give me options for the tab name"` or `"let me pick between names"`, then use `AskUserQuestion` with 3 candidates. Otherwise, just pick and apply — that's the default path.

## Check first — is the name pinned by the human?

Resolve this terminal's session via the watcher's reverse map, then test for a pin marker:

```bash
sd=~/.claude/terminal-state
t=$(ps -o tty= -p $$ | tr -d ' ')
sess=$(cat "$sd/tty.$t.session" 2>/dev/null)
[ -f "$sd/$sess.pinned" ] && echo PINNED || echo free
```

- `free` → proceed with `tn --auto`.
- `PINNED` AND user didn't explicitly ask to rename → respect it; do nothing.
- `PINNED` AND user explicitly asked → proceed; `tn "<name>"` (re-pins to the new name).

A pin only suppresses AI auto-renaming. The colored status dot keeps updating either way — it's painted separately by `tab-watcher.sh`.

## Name style — 1–3 words, prefer 2, skill-like

**Two words is the target, three is the maximum, one only when it is genuinely enough — and write it in the language the user is writing in.** A Hebrew conversation gets a Hebrew name.

**Good:** `payplus`, `auth bug`, `tab dots`, `claude addons`, `docs cleanup`, `דשבורד וילות`, `תיקון הרשאות`, `claude api`

**Bad:**
- Long sentences: `fix-the-payplus-integration-webhook`
- Version suffixes: `dashboard-v2`, `auth-fix-attempt-3`
- IDs: `T1`, `task`, `current`
- Generic: `working on stuff`, `code`, `terminal`

## Closing-line examples

Match the tone of the rest of your response. Some patterns that work:

- `(Set tab → "auth bug" — sound right?)`
- `(Renamed tab to "payplus". Different name?)`
- `(Tab is now "claude api" — change it?)`
- One short sentence is enough. Don't elaborate.

If the user replies anything that isn't an alternative name (e.g. just says "yes", continues with the task, or ignores), the name stays. No re-confirmation needed.
