---
name: council
description: Several models (Claude, GPT, Gemini, Grok) plan a question together on one shared board and a chair writes a joint plan. Use when the user types /council, or asks for a council, a meeting of models, or several models to plan something together.
argument-hint: "<question to plan>"
---

# /council — a planning meeting of several models

The meeting runs in `ccx council`: an arrow-key wizard (chair, who sits at the
table, effort per model, rounds, anonymous or named, list-price budget, look-up
steps per turn) and then private first plans, a turn-based discussion on a
Markdown board, and a joint plan. The wizard needs a real keyboard, which a
command you run never has — so you open it in a pane next to this session and
wait for the board.

## Steps

1. The question is `$ARGUMENTS`. If it is empty, ask the user for it in one
   line and stop until they answer.

2. Open the wizard next to this session (run from the project folder, so
   participants can look things up there):

   ```bash
   ccx council --split "<the question, verbatim>"
   ```

   It prints `opened in <vscode|tmux|terminal> · board: <absolute path>`.
   Tell the user in one short line, in their language, that the setup screen
   opened beside the session (or in a Terminal window when it says `terminal`)
   and that they choose the table there.

3. Wait for the board without polling in the foreground — one background
   command that ends when the meeting ends or is cancelled:

   ```bash
   until grep -qE '^## (Spend|Cancelled)$' "<board path>" 2>/dev/null; do sleep 5; done; echo finished
   ```

   Run it with `run_in_background: true`. You are re-invoked when it exits.

4. When it finishes, read the board from `## Joint plan` to the end (or the
   `## Cancelled` note). Report to the user, in their language:
   - the joint plan (short — its numbered points),
   - what is still disputed and who holds which side,
   - in anonymous mode, who was who,
   - the list-price total from `## Spend` (it runs on subscriptions; nothing is billed),
   - the board path, for the full discussion.
   If it says `## Stopped by owner` or `## Cancelled`, say so plainly and do
   not invent a plan.

## Do not

- Do not run `ccx council` without `--split` — the wizard would hang with no keyboard.
- Do not take part in the meeting, edit the board, or re-plan it yourself
  unless the user asks after reading the result.
