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

1. The request is `$ARGUMENTS`. If it is empty, ask the user for the question
   in one line and stop until they answer.

   Split it into **table settings** and **the question**. Settings never go
   into the question. Settings are how many seats of which model, effort,
   rounds, budget, named/anonymous — e.g. "Sonnet ×2 + Grok", "3 Opus",
   "grok high", "2 rounds". Each model selection becomes one
   `--seat MODEL[:EFFORT][:COUNT]` (effort: low/medium/high/xhigh/max; count
   1-9; each count is its own independent seat A, B, C…). Also `--chair MODEL`,
   `--rounds N`, `--budget DOLLARS`, `--anon` / `--no-anon`. A bare number
   with no model ("3 …") is ambiguous — ask which model.

2. Open the council next to this session (run from the project folder, so
   participants can look things up there):

   ```bash
   ccx council --split [--seat ... ] -- "<the question, verbatim, settings removed>"
   ```

   With no `--seat` the pane shows the setup wizard; with `--seat` it starts
   the meeting straight away.

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

4. When it finishes, read `final.md` next to the board (the joint plan and who
   sat where), and on the board the `## Final check` section and anything
   still disputed (or the `## Cancelled` note). Each seat's blind first plan
   is in `plans/<letter>.md`. Report to the user, in their language:
   - the joint plan (short — its numbered points),
   - what is still disputed and who holds which side,
   - in anonymous mode, who was who,
   - the list-price total from `## Spend` (it runs on subscriptions; nothing is billed),
   - which seats failed, if any (they are marked failed, never replaced),
   - the run folder, for the full discussion.
   If it says `## Stopped by owner` or `## Cancelled`, say so plainly and do
   not invent a plan.

## Do not

- Do not run `ccx council` without `--split` — the wizard would hang with no keyboard.
- Do not take part in the meeting, edit the board, or re-plan it yourself
  unless the user asks after reading the result.
