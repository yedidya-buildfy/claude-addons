# ccx council — several models plan together on one board — design

Date: 2026-09-18 · Status: approved (design + browser mockup), architecture revised after probe

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
only — read a file, list a folder, search text; no shell), resuming a stopped council, more than one council at a time per
folder.

## Flow

### 0. Setup screen (terminal, arrow keys) — three-step wizard

A real TUI (Python `curses`,
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
   budget          ◀ unlimited ▶   ←→ quick presets: unlimited · $0.50 · $1 · $2 · $5 · $10
   steps per turn  ◀  3 ▶          (1–6)
```

Exact budget: `space` on the budget row opens three dials,
`$ [ 2].[3][5]` — dollars (0–99), tenths, hundredths. `←→` picks a dial,
`↑↓` turns it (wraps), typing a digit sets it (dollars shift in two digits;
typing a tenth jumps to hundredths). `Enter` / `space` / `Esc` closes.
All dials at zero = unlimited. Stored in cents, so no rounding drift.
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
list a folder, search text — each one is another model call), and ends with
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
conversation given the board text, so no hidden side channel.

## Architecture

**No Claude Code session, no subagents.** A probe on 2026-09-18 called the
local proxy's Messages endpoint directly and showed everything the council
needs is there per request:

- effort per request works (`output_config.effort`): Gemini 3.7 Flash, same
  prompt, `low` → 112 output tokens, `high` → 555;
- every response carries usage (`input_tokens`, `output_tokens`, and
  `cache_read_input_tokens` where the provider caches — Grok did);
- a subscription at its limit answers `429 usage_limit_reached` at once (GPT
  did during the probe) — handled as "did not answer".

So one Python program talks to the proxy, runs the meeting deterministically
(stop rules and money are code, not an LLM clerk's judgement) and writes the
board. Look-ups are three read-only tools the program itself executes, which
is also how steps per turn are counted and capped.

| Unit | Job | Lives in |
|---|---|---|
| `council` subcommand | `ccx council "<q>"` → ensure proxy + key → run the program | `multi-model/ccx` |
| core (pure, no I/O) | prices + cost of a call, budget/seats/reserve, turn parsing, stop rules, board text | `multi-model/ccx_council_core.py` |
| wizard | wizard state (pure) + curses drawing | `multi-model/ccx_council_wizard.py` |
| runner | proxy client, look-up tools, the meeting loop, board file | `multi-model/ccx-council.py` |
| price table | one row per model | `multi-model/ccx-council-prices.json` |
| self-test | core + wizard state, fake proxy for the loop | `multi-model/ccx-council-selftest.py` |

Model rows come from `ccx-models.py picker` (the `/model` list), minus the
hybrid "plan → execute" rows; `[1m]` suffixes are stripped for the request.
Stage 1 runs participants in parallel threads; stage 2 strictly one at a time.

## Errors

- A participant call fails or times out → one retry; then the board gets
  `### Round n · X — did not answer (error)` and the council continues without
  it. If the chair fails, the next participant in order takes the chair and the
  board says so.
- A turn that is a full new plan or over the cap → trimmed to the cap, board
  marks `(trimmed)`.
- Ctrl-C → board ends with `## Stopped by owner` and `## Spend` so far.
- A look-up outside the folder the council runs in is refused (resolved path
  must stay inside it); each look-up result is capped at 20 KB.

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
- **Where the counts come from** — each response's own `usage` (verified by
  the probe). Cache-write tokens, when reported, are priced as fresh input.
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

The program counts steps itself: every tool round-trip is one step. When the
steps run out the model is told to answer in text now; a tool call after that
is treated as `PASS`.

## Testing

- Self-test for the setup screen's state logic (wizard steps and Esc back,
  toggle, chair move, effort / rounds / budget / steps bounds, ≥2 rule, remembered choices) without a terminal, in the style
  of the existing `ccx-*-selftest.py` files. Never against the real HOME.
- Loop test against a fake proxy (scripted replies): parallel plans land on
  the board, a tool call is executed and counted, `MORE` goes to the chair,
  a 429 becomes "did not answer", chair failure hands the chair on.
- Stop-rule check: a scripted board where all pass → ends; chair says stop →
  ends; rounds cap → ends; all seats empty → chair wraps up from the reserve;
  empty seat can only pass; `MORE` twice in a round → second one refused.
- Price self-test: a fixed usage record × a fixed price row gives the exact
  cost; a model missing from the table is priced as the most expensive row.
- Manual run: 3 cheap models, low effort, max 2 rounds, anonymous on; confirm
  the board fills live, labels hide names until the end, joint plan has a
  disputed section.
