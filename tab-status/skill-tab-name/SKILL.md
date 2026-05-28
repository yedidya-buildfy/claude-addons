---
name: tab-name
description: Set the VS Code terminal tab to a short name that reflects the current conversation topic. Fires EARLY in any substantive working session (after 1–2 user turns once intent is clear) and AGAIN whenever the topic shifts. Also fires on explicit requests. Trigger on /tab-name, "rename tab", "change tab name", "set tab name", "tab name", "שנה שם לטרמינל", "תן שם לטרמינל", "החלף שם", "תקרא לטאב".
when_to_use: As soon as you can identify what the user is working on (usually their first or second substantive message), propose a tab name. Also re-fire when the topic shifts mid-session. Do NOT fire on greetings, throwaway questions, or if a manual override is already set. The default project-basename name (`dashbord`, etc.) is a placeholder — replace it as soon as you know what the session is actually about.
disable-model-invocation: false
---

# Rename the VS Code terminal tab

This addon paints a colored dot + a short name on each VS Code terminal tab. The default name is the project directory basename (e.g. `dashbord`) — a placeholder. **Your job is to replace it with something topic-specific as soon as you understand what the user is working on.**

## When to fire — be proactive, not cautious

Fire as soon as you can answer "what is this session about?" in 1–3 words. That's usually within the first one or two substantive messages from the user.

| Situation | Fire? |
|---|---|
| First substantive message gives clear intent (e.g. "let me fix the payplus webhook") | **Yes — fire now** |
| User asks a specific question on a specific topic | **Yes** |
| User just said "hi" or "look at this screenshot" with no topic context yet | No — wait one more turn |
| You already fired this session and the topic hasn't changed | No — don't repeat |
| Topic clearly shifts ("now let me work on the auth bug instead") | **Yes — fire again** |
| User explicitly asks ("rename tab", "/tab-name") | **Yes — always** |
| Manual override already pinned by `tn` | No — respect it unless asked to override |

## Check first — is a manual override pinned?

```bash
cat ~/.claude/terminal-state/tty.$(ps -o tty= -p $$ | tr -d ' ').name 2>/dev/null
```

- Empty → proceed.
- Non-empty AND the user didn't explicitly ask to rename → respect it; do nothing.
- Non-empty AND the user explicitly asked → proceed; the chosen name replaces the override.

## How to fire

### Path A — user gave an explicit name

User said something like `"rename tab to payplus"`, `"call this tab auth"`, `"שנה לX"`.

→ Skip the question. Run `~/.claude/scripts/tn "<name>"` directly. Done.

### Path B — you're proposing names

Call `AskUserQuestion` with **3 short name options** (the tool automatically adds an "Other" so the user can type a custom name):

- All lowercase
- 1–3 words each, **prefer 2 words**
- Skill-style — descriptive of the topic, not generic
- Each option's `description` is one short sentence saying why that name fits

Example:

```
question: "What should this tab be called?"
header:   "Tab name"
options:
  - label: "payplus"      description: "PayPlus webhook integration"
  - label: "auth bug"     description: "Fixing the Supabase auth bug"
  - label: "docs cleanup" description: "Restructuring docs/"
```

After the user picks (or types via "Other"), run:

```bash
~/.claude/scripts/tn "<chosen name>"
```

**No announcement.** The dot updates within ~20ms — the user can see it.

## Good names

`payplus`, `auth bug`, `tab dots`, `claude addons`, `docs`, `code review`, `migrations`, `context bar`, `whatsapp`, `claude api`

## Bad names — avoid

- Long sentences: `fix-the-payplus-integration-webhook`
- Version suffixes: `dashboard-v2`, `auth-fix-attempt-3`
- Single letters / IDs: `T1`, `task`, `current`
- Generic: `working on stuff`, `code`, `terminal`

## Don't be shy

The user wants the tab renamed. Being conservative ("the topic might shift later, let me wait") is worse than firing once. If you fire and the topic changes later, you'll just fire again — that's the design.
