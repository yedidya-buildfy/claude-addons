---
name: tab-name
description: Rename the VS Code terminal tab to a short label that reflects what the conversation is actually about. Fires automatically when the user's topic clearly shifts mid-session (different feature, bug, file area, or domain) and on explicit user requests. Trigger on /tab-name, "rename tab", "change tab name", "set tab name", "tab name", "שנה שם לטרמינל", "תן שם לטרמינל", "החלף שם", "תקרא לטאב".
when_to_use: When the active topic of the conversation has clearly changed from the previous topic — different feature, different bug, different codebase area — AND no manual override is already pinned. Also fires when the user explicitly asks to rename. Do NOT fire at session start (let the auto-derived project basename stand until the topic is clear) or during continuation of the same topic.
disable-model-invocation: false
---

# Rename the VS Code terminal tab

This machine has a `tab-status` addon — each terminal tab shows a colored status dot and a short name. The name lives in `~/.claude/terminal-state/tty.<ttysNNN>.name` (manual override) or `~/.claude/terminal-state/<session>.name` (auto, project basename).

## Step 1 — Check whether a manual override is already pinned

```bash
cat ~/.claude/terminal-state/tty.$(ps -o tty= -p $$ | tr -d ' ').name 2>/dev/null
```

- **Empty output** → no override; proceed.
- **Non-empty output** AND the user **did NOT explicitly ask to rename** → do nothing. They already set a name they like.
- **Non-empty output** AND the user explicitly asked → proceed; override will be replaced.

## Step 2 — Decide the path

| User said this | Action |
|---|---|
| `"rename tab to X"`, `"call this tab X"`, `"שנה לX"` (explicit name) | **Skip the question.** Run `~/.claude/scripts/tn "X"` directly. |
| `"rename tab"`, `/tab-name`, `"give this tab a name"` (no specific name) | Go to Step 3 — propose options via AskUserQuestion. |
| Auto-fired because topic shifted, no explicit user request | Go to Step 3 — propose options via AskUserQuestion. |

## Step 3 — Propose names via `AskUserQuestion`

Read the recent conversation. Identify the **active topic** in 1–3 words (prefer 2).

Call `AskUserQuestion` with **3 short name options** plus the implicit "Other" the tool always provides:

- All lowercase
- 1–3 words each, **prefer 2 words**
- Skill-style — descriptive of the topic, not generic
- Each option's `description` field is one short sentence explaining why that name fits

Example call:

```
question: "What should this tab be called?"
header:   "Tab name"
options:
  - label: "payplus"      description: "PayPlus webhook integration"
  - label: "auth bug"     description: "Fixing the Supabase auth bug"
  - label: "docs cleanup" description: "Cleaning up docs/ structure"
```

## Step 4 — Apply

Once the user picks (or types via "Other"), run:

```bash
~/.claude/scripts/tn "<chosen name>"
```

That's all. The watcher repaints the tab within ~20ms. **No announcement** — don't say "tab renamed". The user can see it.

## Good names

`payplus`, `auth bug`, `tab dots`, `docs`, `code review`, `whatsapp`, `claude api`, `migrations`, `context bar`

## Bad names (avoid)

- `fix-the-payplus-integration-webhook` — too long
- `dashboard-improvements-v2` — too long, version suffix
- `T1`, `task` — not descriptive
- `working on stuff`, `current` — generic, no information

## When NOT to fire

- Session just started; topic isn't clear yet
- Same topic is continuing; user is mid-task
- A tool call returned an error and you're debugging the same problem
- The user is asking a clarifying question, not pivoting

If unsure whether the topic shifted enough to rename, **don't**. False renames are more annoying than a stale name.
