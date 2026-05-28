---
name: tab-name
description: Set the VS Code terminal tab to a short name that reflects the current conversation topic. Fires EARLY in any substantive working session (after 1–2 user turns once intent is clear) and AGAIN whenever the topic shifts. Picks a name on its own, applies it silently, and adds ONE short text-question at the end of the response so the user can override. Also fires on explicit requests. Trigger on /tab-name, "rename tab", "change tab name", "set tab name", "tab name", "שנה שם לטרמינל", "תן שם לטרמינל", "החלף שם", "תקרא לטאב".
when_to_use: As soon as you can identify what the user is working on (usually their first or second substantive message), pick a 1–3 word name yourself, apply it, and ask a short open question at the end so they can correct it. Also re-fire when the topic shifts mid-session. Do NOT fire on greetings, throwaway questions, or if a manual override is already pinned (unless the user explicitly asks to rename). The default project-basename name (`dashbord`, etc.) is a placeholder — replace it as soon as you know what the session is about.
disable-model-invocation: false
---

# Rename the VS Code terminal tab

This addon paints a colored dot + short name on each VS Code terminal tab. The default name is the project directory basename — a placeholder. **Your job is to replace it with a topic-specific name as soon as you know what the session is about — with minimal friction.**

## The flow — low friction by default

1. **Decide** on a 1–3 word name yourself (prefer 2 words). Skill-style, lowercase, descriptive.
2. **Apply it silently** by running `~/.claude/scripts/tn "<name>"`. No announcement mid-response, no AskUserQuestion popup.
3. **At the end of your normal response**, add ONE short sentence — a plain open-ended question, like:
   > `(Renamed tab to "auth bug" — want a different one?)`

   That's it. One line. Question mark. Don't make it a separate paragraph or use any AskUserQuestion tool.
4. **If the user disagrees or suggests a different name** in their next message, apply it immediately with `tn "<their name>"`. Acknowledge briefly. Move on.

The point: the user almost never has to engage with the rename. The name just appears, and they can correct it any time with a few words.

## When to fire — be proactive

Fire as soon as you can answer "what is this session about?" in 1–3 words. Usually within the first one or two substantive messages.

| Situation | Action |
|---|---|
| First substantive message gives clear intent | Apply name now + one-line confirm at end |
| User asks a specific topical question | Apply name now + one-line confirm at end |
| User just said "hi" / sent a screenshot with no context | Wait one more turn |
| Topic clearly shifted ("now let me work on the auth bug instead") | Apply NEW name + one-line confirm at end |
| User says `"rename tab to payplus"` (specific name) | Apply `tn "payplus"` directly — no question, no confirmation needed |
| User says `"rename tab"` / `/tab-name` (no name) | Apply your best guess + one-line confirm at end |
| You already named the tab AND topic hasn't changed | Do nothing |
| Manual override pinned by `tn` AND user didn't ask | Respect it, do nothing |

## Use AskUserQuestion only if explicitly asked

If the user says `"give me options for the tab name"` or `"let me pick between names"`, then use `AskUserQuestion` with 3 candidates. Otherwise, just pick and apply — that's the default path.

## Check first — is a manual override already pinned?

```bash
cat ~/.claude/terminal-state/tty.$(ps -o tty= -p $$ | tr -d ' ').name 2>/dev/null
```

- Empty → proceed.
- Non-empty AND user didn't explicitly ask to rename → respect it; do nothing.
- Non-empty AND user explicitly asked → proceed; your new name replaces the override.

## Name style — 1–3 words, prefer 2, skill-like

**Good:** `payplus`, `auth bug`, `tab dots`, `claude addons`, `docs cleanup`, `code review`, `migrations`, `context bar`, `whatsapp`, `claude api`

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
