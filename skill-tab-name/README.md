# skill-tab-name — Claude proposes a short tab name on its own

A Claude Code skill that watches what your conversation is about and silently sets the VS Code terminal tab name to a short, topic-appropriate label (1–3 words, prefer 2, lowercase, skill-style). At the end of each response it adds one short open question so you can override:

> *(Renamed tab to "auth bug" — want a different one?)*

## Triggers

Fires automatically when:
- Your intent becomes clear in your first or second substantive message
- The topic shifts mid-session (different feature, bug, area)

Fires on explicit requests:
- `/tab-name`
- Phrases like "rename tab", "tab name", "שנה שם לטרמינל", "תן שם לטרמינל"

Does NOT fire on:
- Greetings, throwaway messages, single screenshots without context
- Continuation of the same topic
- Tabs where you've already pinned a manual name with `tn`

## Behavior

| User says | What the skill does |
|---|---|
| `"let me fix the payplus webhook"` | Picks `payplus`, runs `tn "payplus"` silently, adds *(Renamed tab to "payplus" — different name?)* at the end |
| `"rename tab to auth"` (explicit name) | Runs `tn "auth"` directly, no question |
| `"rename tab"` (no name given) | Picks best guess, applies, adds confirm-question at end |
| `"give me options for the name"` | Uses `AskUserQuestion` with 3 candidates |

## Requires

This skill calls `~/.claude/scripts/tn`, which is installed by the [`tab-status`](../tab-status) addon. Install `tab-status` first (or together via the top-level `install.sh`).

## Manual install

```bash
mkdir -p ~/.claude/skills/tab-name
cp skill-tab-name/SKILL.md ~/.claude/skills/tab-name/SKILL.md
```

Claude Code discovers the skill automatically on its next session start.

## Name style

**Good:** `payplus`, `auth bug`, `tab dots`, `claude addons`, `docs cleanup`, `code review`, `migrations`, `context bar`

**Bad (skill rejects):**
- Long sentences (`fix-the-payplus-integration-webhook`)
- Version suffixes (`auth-fix-attempt-3`)
- Single letters / IDs (`T1`, `current`)
- Generic words (`working on stuff`, `code`)
