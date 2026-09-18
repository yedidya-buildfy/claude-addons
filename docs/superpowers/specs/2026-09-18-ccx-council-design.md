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

Non-goals (v1): a browser board, write/edit tools for participants (look-ups
only — read files, search, run read-only checks), resuming a stopped council, more than one council at a time per
folder.

## Flow

### 0. Setup screen (terminal, arrow keys) — three-step wizard

Runs before Claude Code starts, so it can be a real TUI (Python `curses`,
stdlib — ccx already needs python3). Chosen from three browser mockups
(one table / wizard / round table) on 2026-09-18: the wizard. Chrome is
English (terminals render mixed Hebrew badly); the question itself stays as typed.

```
 ccx council  <question>

   1 chair ✓  ─  2 table  ─  3 settings
```

Step 1 — chair. One row per model with its effort:
```
 > (★) ● Claude Opus 5        ◀ high   ▶ ▁▃▅
   ( ) ● GPT 5.6 Sol          ◀ xhigh  ▶ ▁▃▅▆
```
`↑↓` move · `←→` effort · `space`/`Enter` choose (Enter also advances).

Step 2 — table. Same rows plus each model's list price (in / out per 1M
tokens); chair row locked in with ★; `space` seats/unseats, `←→` effort.
Shows "N at the table · worst case ≈ $X list price" (see Price model). Enter
refused under 2 participants.

Step 3 — settings, then a summary of who sits with which effort:
```
   max rounds      ◀  5 ▶   stops earlier if the chair calls it or everyone passes
   plans shown as  ◀ named ▶
   budget          ◀ unlimited ▶   (unlimited | $0.5 | $1 | $2 | $5 | $10)
   steps per turn  ◀  3 ▶          (1–6)
```
`Esc` goes back one step; `Enter` starts.

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
- Budget and steps per turn: see Price model and Turns below.
- Last choices remembered per machine in `~/.claude/addons/council.json`.

### 1. First plans (parallel, private)

Each participant gets the question plus the current folder as context and
writes a full plan without seeing anyone else's. All plans are appended to the
board under `## Plans`.

### 2. Discussion (turn queue)

Rounds go round-robin in a fixed order (chair last). On its turn a participant
reads the whole board, may take up to *steps per turn* look-ups (read a file,
search, run a read-only check — each one is another model call), and ends with
exactly one of:

- `PASS` — nothing to add; turn goes on.
- a short message (hard cap ~150 words) about specific points — agree,
  object, ask, propose a change. No new full plan.
- `MORE: <reason>` — "can I check something first?". The chair answers
  granted / denied in one line; granted = another *steps per turn* look-ups
  in this same turn. At most one request per participant per round, and it is
  denied automatically if the seat cannot afford it.

The turn prompt always tells the participant what it has left in its seat, so
it can pace itself; every message on the board carries its step count and
cost, so a heavy speaker is visible to everyone.

After each full round the chair is asked one question: continue or stop, with a
one-line reason. The discussion ends when:

- the chair says stop, or
- the budget is spent (seats empty), or
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
max rounds, anonymity, budget, seat size and steps per turn; the board ends
with `## Spend` — list-price cost per participant and the total. Each message: `### Round 2 · B` (or `· GPT 5.6 Sol`).

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

## Price model

Every model here runs on the owner's subscriptions, so a council bills
nothing. What it does spend is each subscription's usage quota. "Cost" is
therefore **list price**: what the same calls would cost at each provider's
published API prices. It is one yardstick across models of very different
weight, and it is what the budget counts.

- **Price table** — one file, one row per model: price per 1M tokens for fresh
  input, cached input, and output, plus the date and source page it was taken
  from. Filled from the providers' official pricing pages at build time, never
  from memory. A model with no row shows `price ?` in the wizard and counts as
  the most expensive row in the table (so an unknown never looks free).
- **Cost of one call** = fresh input × input price + cached input × cached
  price + output × output price. Reasoning ("thinking") tokens are billed as
  output — that is where effort shows up in the price.
- **Where the counts come from** — each call's own reported usage (fresh,
  cached, output). **Unverified** which layer exposes all three per call: the
  subagent result, or the proxy (every call passes through it and each response
  carries usage). Part of the first spike, together with per-agent effort.
- **Board growth** — every turn re-reads the whole board, so each round costs
  more than the last. Most of that re-read is cached (cheap), which is why the
  cached price matters and why turns stay short.

### Budget

- Default **unlimited**: nothing stops on price, but every message and the
  final `## Spend` still show list price.
- With a budget: **15% is held back for the joint plan**, so the meeting can
  always be summed up. The rest is split into equal **seats**, one per
  participant. A seat is like speaking time: spend little now, more later.
- Checked after every call. A participant whose seat is empty can only `PASS`.
  When all seats are empty the discussion ends and the chair writes the joint
  plan from the reserve. A single call may overshoot its seat — the cap is a
  stop signal, not a hard wall.
- Wizard shows a **worst-case estimate** before Enter: every seat uses every
  step and one extension every round, for max rounds, plus the joint plan; with
  a budget below it, it says "budget will stop it earlier".

### Turns — more than one call, without overdoing it

Four brakes, weakest first: steps-per-turn cap (default 3) → the seat → the
chair's granted/denied on `MORE` (once a round) → the overall budget. Plus the
social one: cost and steps printed on every message.

**Unverified**: whether a subagent's number of tool round-trips can be capped
from its definition. If not, the clerk enforces it by giving each look-up as
its own call and counting them.

## Testing

- Self-test for the setup screen's state logic (wizard steps and Esc back,
  toggle, chair move, effort / rounds / budget / steps bounds, ≥2 rule, remembered choices) without a terminal, in the style
  of the existing `ccx-*-selftest.py` files. Never against the real HOME.
- Self-test that per-run agent files are generated with the right model and
  effort and removed afterwards.
- Stop-rule check: a scripted board where all pass → ends; chair says stop →
  ends; rounds cap → ends; all seats empty → chair wraps up from the reserve;
  empty seat can only pass; `MORE` twice in a round → second one refused.
- Price self-test: a fixed usage record × a fixed price row gives the exact
  cost; a model missing from the table is priced as the most expensive row.
- Manual run: 3 cheap models, low effort, max 2 rounds, anonymous on; confirm
  the board fills live, labels hide names until the end, joint plan has a
  disputed section.
