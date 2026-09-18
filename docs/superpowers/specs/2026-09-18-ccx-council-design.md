# ccx council — several models plan together on one board — design

Date: 2026-09-18 · Status: awaiting review

## Why

A second opinion today is one `ask-*` subagent at a time, and the main session
stitches the answers together by hand. The owner wants a meeting: every chosen
model writes its own first plan, then they talk it over on a shared board, each
one speaking only about what matters, until a chair calls it and writes the
joint plan. That is how people plan, and it is what the models are missing.

Prior art borrowed from:

- **Karpathy's llm-council** — private first answers, optional anonymisation so
  no model favours its own brand, a chair that synthesises.
- **Blackboard pattern / AutoGen group chat** — one shared page everyone reads
  and appends to; a moderator picks who speaks next.
- **PAL (ex-Zen) MCP `consensus`** — fan out to several providers, merge.

Difference from all three: after the first plans nobody rewrites a plan. Turns
are short comments or a pass, like people in a room.

## Goal

`ccx council "<question>"` → an arrow-key setup screen → a board file that
fills live → a joint plan at the bottom of the board.

Non-goals (v1): a browser board, tool use by participants (they read and write
text only), resuming a stopped council, more than one council at a time per
folder.

## Flow

### 0. Setup screen (terminal, arrow keys)

Runs before Claude Code starts, so it can be a real TUI (Python `curses`,
stdlib — ccx already needs python3).

```
 Council: איך לתמחר ביקורי סוף שנה?

   chair  in   model               effort
 > (•)   [x]  Claude Opus 5        ◀ high ▶
   ( )   [x]  GPT 5.6 Sol          ◀ xhigh ▶
   ( )   [x]  Gemini 3.1 Pro       ◀ high ▶
   ( )   [ ]  Grok 4.6             ◀ medium ▶

   max rounds      ◀ 5 ▶
   plans shown as  ◀ named ▶        (named | anonymous)

   ↑↓ move  space in/out  c chair  ←→ change  enter start  q quit
```

- Model list = the same list `ccx --list` shows (one row per model, not per
  provider, so e.g. GPT Sol and GPT Luna can both sit at the table).
- Chair is any model, Claude or not. The chair also writes a first plan and
  takes turns like everyone else.
- Effort per row: low / medium / high / xhigh / max. Default = the row's last
  used value, else high.
- Max rounds: 1–10, default 5.
- Anonymous: first plans and every board message are labelled A, B, C… instead
  of model names. The label↔model key is kept out of the board and revealed
  only in the final section.
- Needs ≥2 participants including the chair; Enter is refused otherwise.
- Last choices remembered per machine in `~/.claude/addons/council.json`.

### 1. First plans (parallel, private)

Each participant gets the question plus the current folder as context and
writes a full plan without seeing anyone else's. All plans are appended to the
board under `## Plans`.

### 2. Discussion (turn queue)

Rounds go round-robin in a fixed order (chair last). On its turn a participant
reads the whole board and answers with exactly one of:

- `PASS` — nothing to add; turn goes on.
- a short message (hard cap ~150 words) about specific points — agree,
  object, ask, propose a change. No new full plan.

After each full round the chair is asked one question: continue or stop, with a
one-line reason. The discussion ends when:

- the chair says stop, or
- every participant passed in the same round, or
- max rounds is reached.

### 3. Joint plan

The chair writes `## Joint plan` at the end of the board: the agreed plan, then
`### Still disputed` listing each open disagreement and who holds which side.
In anonymous mode, `## Who was who` follows.

## Board file

`./council/YYYY-MM-DD-HHMM-<slug>.md` in the folder the command ran in.
Plain Markdown, append-only, opened in the editor as soon as it is created so
the owner watches it fill. Header records the question, participants, efforts,
max rounds, anonymity. Each message: `### Round 2 · B` (or `· GPT 5.6 Sol`).

The board is the only memory participants share — each turn is a fresh
subagent call given the board text, so no hidden side channel.

## Architecture

| Unit | Job | Lives in |
|---|---|---|
| `council` subcommand of `ccx` | parse `ccx council "<q>"`, run the setup screen, write the run config, generate per-run agents, start Claude Code with the council prompt | `multi-model/ccx` |
| setup screen | the curses picker above; reads models from the same source as `--list`, writes `council.json` | `multi-model/ccx-council.py` |
| per-run agents | one agent file per participant: `council-<n>.md` with that row's `model:` and `effort:`; deleted when the council ends | written into `$CLAUDE_CONFIG_DIR/agents` |
| council skill | the moderator: runs stages 1–3, writes the board, never takes a side | `multi-model/skills/council/SKILL.md`, installed by the addon |

Moderator = the main Claude Code session. It only clerks: dispatches agents,
appends their output verbatim, applies the stop rules. It does not add opinions
of its own (the chair may be Claude; the clerk still is not a participant).

Stage 1 runs the participant agents in parallel; stage 2 runs them strictly one
at a time (each turn must see the previous one).

### Per-model effort — the one real risk

Today's `ask-*` agents carry a fixed `model:` and no effort, and the effort
chosen in the session is global. Plan: generated per-run agent files put
`effort:` in their frontmatter. **Unverified** that Claude Code honours
per-agent effort through the proxy for non-Claude models. First implementation
task is a spike: one agent at `low`, one at `max`, same prompt, capture what the
proxy forwards (method from the 8.9.2026 effort measurement). Fallback if
frontmatter is ignored: the proxy's per-alias level suffix, also unverified.
If neither works, the effort column ships disabled with a note, rather than
pretending.

## Errors

- A participant call fails or times out → one retry; then the board gets
  `### Round n · X — did not answer (error)` and the council continues without
  it. If the chair fails, the next participant in order takes the chair and the
  board says so.
- A turn that is a full new plan or over the cap → trimmed to the cap, board
  marks `(trimmed)`.
- Ctrl-C → board ends with `## Stopped by owner`; per-run agents are cleaned
  up on the next `ccx` start if still present.

## Cost guard

Cost ≈ participants × (1 plan + max rounds turns) + chair decisions. The
setup screen shows the worst-case call count under the rounds row so the owner
sees it before pressing Enter.

## Testing

- Self-test for the setup screen's state logic (toggle, chair move, effort and
  rounds bounds, ≥2 rule, remembered choices) without a terminal, in the style
  of the existing `ccx-*-selftest.py` files. Never against the real HOME.
- Self-test that per-run agent files are generated with the right model and
  effort and removed afterwards.
- Stop-rule check: a scripted board where all pass → ends; chair says stop →
  ends; rounds cap → ends.
- Manual run: 3 cheap models, low effort, max 2 rounds, anonymous on; confirm
  the board fills live, labels hide names until the end, joint plan has a
  disputed section.
