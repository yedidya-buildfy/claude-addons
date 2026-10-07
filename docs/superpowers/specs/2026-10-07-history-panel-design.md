# history-panel — what each Claude session did, beside its terminal — design

Date: 2026-10-07 · Status: draft, awaiting owner review
Approved look: `2026-10-07-history-panel-designs.html` (variant B, timeline cards + compact mode)

## Why

The owner runs many Claude Code sessions side by side in VS Code terminals and
loses track of what each one did. Scrolling back does not work: a VS Code
terminal keeps 1,000 lines by default, so the start of a long session is gone.
The status line shows the session's total cost and context, but not which
message spent what. The owner wants a running, readable history per session —
what was asked, what happened, what it cost — plus the hard technical facts
(merges, pushes, deploys, local servers) recorded as facts, not AI prose.

## Goal

A new add-on, `history-panel`. Once it is on, VS Code shows a **History** view
in the bottom panel that follows the focused terminal:

- one entry per message the owner sent in that terminal's Claude session;
- per entry: a title (≤ 28 chars), "you asked" and "what happened" (one or two
  sentences each, written by the cheapest available model), the time, the
  cost in dollars and the context slice it added;
- under each entry, fixed-text technical rows taken from the session record,
  never from a model: commits, pushes, merges, worktrees, local servers with
  their port, production deploys, add-on updates, answered questions,
  mid-turn guidance, interrupts, slash commands, side questions, subagents;
- every technical row expands on click to its full facts;
- a click on an entry jumps to that prompt in the terminal, or, when the
  terminal no longer holds it, opens the prompt and the reply from the record;
- old sessions (from before the add-on) get the same history the first time
  their terminal is focused.

Non-goals (v1): the Claude chat panel of the VS Code extension, the desktop
app, sessions on other machines, search across sessions, editing or deleting
history, a terminal-only (non-VS Code) view.

## Owner decisions (from the brainstorm)

1. Placement: a view next to the terminal list in VS Code's bottom panel.
2. Scope: the view shows the focused terminal's session only, and switches as
   the owner switches terminals. A resumed old session shows its full history.
3. Cost: dollars by the public price list, computed exactly like the status
   line (`statusline-gsd`), so a session's entries sum to the status-line total.
4. Context: per entry, the slice it added — previous entry's end to this
   entry's end, out of the model's window — shown as a lit segment on a bar
   of the whole window, with "8%→12% +4%".
5. Look: variant B. Below 340 px of width the view turns compact: per entry a
   full title line, then a line with a mini context slice, cost and action
   icons; a click opens the entry in place without changing the layout.
6. Width: the view never gets narrower than one 28-char title; dragging past
   half of that closes it; dragging back from the edge reopens it.
7. Technical rows are fixed text from the record. The only model-written text
   is the entry title, "you asked", "what happened", and one line per subagent.
8. The cheapest model writes the summaries (owner asked explicitly).

## How it fits together

```
Claude Code session ──writes──▶ session record (~/.claude/projects/*/<id>.jsonl)
      │ Stop hook (end of each turn)                    │
      ▼                                                 │ read
history.mjs summarize <id> ──cheap model──▶ ~/.claude/history-panel/<id>.json
                                                        │ (summaries cache)
VS Code extension ──focused terminal──▶ tty ──▶ session id (tab-status state)
      │ runs `history.mjs build <id>` on focus and when the record changes
      ▼
webview view "History" (renders the approved mockup's markup)
```

### Units

1. **`history.mjs build <session>`** — pure read. Parses the session record
   and prints one JSON document: session header (name, total cost, minutes,
   context %), entries (time, cost, token breakdown, context start/end,
   prompt text, summary if cached, running flag) and each entry's technical
   rows. No network, no writes. This is where all the rules live, so it is
   the unit the tests exercise.
2. **`history.mjs summarize <session>`** — fills missing summaries for that
   session: one cheap-model call per entry without one (batched, at most 10
   entries per call), writes `~/.claude/history-panel/<session>.json`
   atomically. Run by the Stop hook (only the newest entry) and by `build`
   when it finds gaps (in the background, at most one per session at a time,
   guarded by a lock file).
3. **VS Code extension `claude-history`** — a webview view contributed to its
   own panel container. Maps the focused terminal to a session with the same
   tty lookup `tab-status` uses, runs `build`, watches the session record and
   re-runs `build` (debounced 500 ms) when it grows, and handles clicks
   (jump / open from record). Holds no rules of its own.
4. **Add-on manifest** — files, the Stop hook snippet, a VS Code settings
   snippet (terminal scrollback 50,000 lines), the extension files.

### Mapping a terminal to its session

Reuse `tab-status`: the focused terminal's shell pid → its process subtree's
tty → `~/.claude/terminal-state/tty.<tty>.session` → session id → the record
`~/.claude/projects/*/<id>.jsonl`. `history-panel` therefore `requires`
`tab-status`. A terminal with no session shows "אין שיחה של קלוד בטרמינל הזה".

### Entries

An entry starts at each record line that is a human prompt (`type: user`,
string or text content, not a tool result, not meta, not a `<command-…>`
wrapper) and runs until the next one. Its cost is the sum of every assistant
message in that span (deduplicated by message id, subagent records included),
priced with the status line's price table. Its context end is the last main
assistant call's input + cache read + cache creation tokens; its start is the
previous entry's end (0 for the first). The window size is the one the status
line uses for that model.

Interrupts, mid-turn guidance and task notifications are not entries; the
first two become technical rows of the entry they happened in.

### Technical rows (fixed text)

Each row is `kind, time, what, short detail, [AI line], full facts`. Detected
from structured record fields only — never by searching free text, because
the record also contains our own tool output that quotes these phrases.

| Kind | Detected from | Full facts |
|---|---|---|
| answer ❓ | AskUserQuestion tool use + its result | question, options, choice or own text |
| note ✎ | queued command with `origin.kind = human` | the text, attachments |
| stop ⏹ | interrupt marker after a tool use | what was running, next prompt |
| slash ⌘ | `<command-name>` user lines (except `/btw`) | command, its output's first line |
| btw 💬 | `/btw` record, if Claude Code writes one (verify in build) | question, answer |
| agent 🤖 | Agent tool use + result + subagent record | type, model, task, time, cost, tool calls, AI line |
| commit ● | Bash `git commit` with exit 0 | repo, branch, id, message, files, +/− |
| push ⬆ | Bash `git push` with exit 0 (✕ on failure) | remote, branch, old→new, attempts |
| worktree ⑂ | Bash `git worktree add` / EnterWorktree | folder, branch, base |
| merge ⎇ | Bash `git merge` with exit 0 (✕ on conflict) | from, into, conflicts, worktree removed |
| server ▶ | Bash/background task output with `localhost:<port>` from a dev command | command, folder, URL, listening now (`lsof`, at render) |
| prod 🚀 | deploy commands in the built-in list (below) | target, version, duration, result |
| update ↻ | `claude-addons-update.sh` success line | before, after, what changed |

Production deploy list (v1): Coolify API `…/api/v1/deploy`, `git push` to a
branch named `production`, `vercel --prod`, `npx convex deploy`, `fly deploy`.
More are added to the list, not configured per project.

A failed action is a red ✕ row with the error's first line, never a success
row.

### Summaries (cheap model)

Prompt per entry: the owner's prompt (head and tail, 6,000 chars max), the
final assistant text of the entry, and the technical rows' one-liners. Output
JSON: `title` (≤ 28 chars, the owner's language), `asked` and `happened` (one
or two sentences each). One line per subagent from its task and result.

Model order: the same list and gateway `tab-autoname.py` uses (cheapest
first), then `claude -p --model haiku` as the last resort on machines without
the gateway. On total failure the entry shows the first 120 chars of the
prompt and "לא סוכם" and is retried on the next `build` after 2 minutes.

### Jump to a prompt

`sticky-prompt` already marks every prompt as a terminal command mark, which
VS Code's "scroll to previous command" uses. The extension scrolls to bottom,
then to the previous command mark N times, N = entries after the target. If
the terminal has fewer marks than needed (scrollback lost them, or
`sticky-prompt` is off), it opens a read-only editor tab with that entry's
prompt, reply and technical rows from the record, titled "<tab name> · #N".

### Width and compact mode

VS Code owns the sash between panel views; the view sets no width itself.
The owner drags the History view once into the Terminal panel container
beside the terminal (VS Code remembers it); after that, dragging the sash
resizes it and collapses it, as in the mockup. Compact mode is a CSS
container query at 340 px inside the webview. **Verify first in the build:**
that a contributed panel view can sit beside the terminal and shrink to the
28-char minimum. If VS Code cannot place it there, fall back to its own panel
tab and tell the owner before going further.

## Error handling

- Record missing or unreadable: the view says so with the path; no crash.
- A malformed record line is skipped and counted; the header shows "N שורות
  לא נקראו" when N > 0.
- `build` over 2 s on a huge record: the view keeps the last result and shows
  a spinner; `build` caches parsed entries by byte offset so re-runs read only
  the new tail.
- Summary calls never block the view and never run more than one per session.
- The Stop hook returns at once (spawns `summarize` detached) and never fails
  the turn.

## Testing

- `history.test.mjs` (node:test) over small synthetic records with known
  answers: entry splitting (prompt, interrupt, mid-turn note, task
  notification, command wrapper), cost per entry equals the status line's
  price function on the same usage, context slices chain (end of N = start of
  N+1), every technical row kind including the failure ✕ variants, and the
  "quoted phrase in tool output is not a row" case.
- A real-record smoke test: `build` on this brainstorm's own session must
  produce 3 answer rows, 1 note, 1 stop, 1 push to `master` of
  `claude-addons` at d5faff1, and a total equal to the status line's.
- Extension: the tty → session lookup is shared with `tab-status`; one test
  for the "no session" and "session ended" states.
- Engine: `node --test engine/test/engine.test.mjs` stays green.

## Files

```
history-panel/
├── addon.json                 requires tab-status; default on
├── history.mjs                build + summarize (+ shared price table)
├── history.test.mjs
├── settings.json.snippet      Stop hook → history.mjs summarize --latest
├── vscode-settings.snippet    terminal.integrated.scrollback: 50000
└── vscode-extension/
    ├── package.json           panel view container + webview view
    ├── extension.js           terminal→session, watch, click handling
    └── view.html              the approved mockup's markup and styles
```

The price table moves out of `gsd-statusline.js` into one small module both
files read, so the two can never disagree.
