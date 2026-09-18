# ccx build — plan and build a task with a team of models — design

Date: 2026-09-18 · Status: design approved in the browser mockup
(`2026-09-18-ccx-build-mockup.html`, next to this file); waiting for the
owner to review this written spec.

## Why

`ccx council` lets several models argue about a question. The owner wants the
next step as well: split a real task into roles (architecture, backend,
frontend, security, data, research, second opinion…), give each role the
model that fits it, have those models write the plan and pick holes in each
other's parts, and then build it. The owner should not have to choose
everything each time. A first model proposes the whole setup and the owner
only changes what they disagree with.

The owner's defaults, which become the shipped rules:

| Role | Model |
|---|---|
| Architecture, backend, security | Claude |
| Research and outside-facing development | GPT |
| Second opinion when more views are needed | Grok |
| Drafts, frontend, small tasks that need little thought | Gemini |

Prior art borrowed from:

- **Anthropic, "How we built our multi-agent research system"**: scale the
  number of agents with the task (1 agent for simple, 2–4 for comparisons,
  more only for truly complex work). Multi-agent runs cost about 15× a chat.
  Coding has fewer truly parallel parts than research.
- **Cognition, "Don't build multi-agents"**: parallel writers without shared
  context make conflicting decisions. Write in parallel only on separate files
  and only after the decisions are fixed.
- **mattpocock/skills `grilling`**: relentless numbered questions, each with a
  recommended answer. The asker looks up facts itself and puts only decisions
  to the owner.
- **ccx council (built 2026-09-18)**: setup screen, split pane, board file,
  list-price ledger, read-only look-up tools, "Source: file" grounding check,
  one folder per run.

## Goal

`ccx build "<task>"`, or the `/build` skill in a Claude Code session, opens a
three-step setup screen with the first model's proposal already filled in. A
**PLAN** board fills live and ends with a joint plan and the owner's
decisions. After the owner approves, a **BUILD** phase runs. Questions from
the models reach the owner through Claude Code's own question dialog.

A second way in (from the ccx-council session's open item): a row in the ccx
`/model` picker opens the same tool. There is **one engine with two ways in**;
the existing council stays as the discussion-only tool.

Non-goals (v1): a browser UI, resuming a stopped run, several runs at once in
one folder.

## Phases, always visible

Every screen and board starts with the phase line:

```
■ PLAN  ─  □ BUILD   · planning only: models read the project, nothing is changed yet
■ PLAN ✓  ─  ■ BUILD · models now write code
```

PLAN never writes to the project. BUILD starts only after the owner presses
Enter on the finished plan, and after they have answered any open decisions.

## Configuration (saved once per machine)

`~/.claude/addons/build.json`, edited from the setup screen's side tabs (and
later from the `addons` settings page):

- **Model classes.** Three ordered lists: `frontier`, `mid` and `small`.
  - The order inside a class is the backup order.
  - Shipped defaults: frontier = Claude Fable 5.1, GPT 6 Astra. Mid = Claude
    Opus 5, GPT Sol, Grok 4.6, Gemini Pro. Small = Claude Sonnet 5, Gemini
    Flash, GPT Terra, GPT Luna. (The owner never placed Gemini Pro; it is in
    mid until they move it.)
  - Any model the local proxy offers (the same model list `load_models()`
    gives the council) that is in no class shows under **"new — not in a class
    yet"** until the owner places it. So a future Gemini 4 appears there on its
    own.
  - Keys: ←/→ move a model up or down a class. Shift+↑/↓ reorder it within
    its class.
- **Your rules.** Role → default model + effort, for the fixed role list:
  Architecture, Backend, Security, Data, Frontend, Small tasks, Research,
  Second opinion. Keys: ←/→ change the model, -/= change the effort.

## Flow

### 1. Intake (the first model to get the request)

One model (default: the Architecture rule's model) reads the project with the
council's read-only look-ups, then does two things.

1. **If the request is unclear**, it stops and asks. It asks only what it could
   not look up, and every question carries a recommended answer. See
   *Questions to the owner* below.
2. **It returns a run card.** Strict JSON, parsed and validated. If it cannot
   be parsed, the run stops and says so. It never guesses. The card holds:
   - `size`: small / medium / large, plus one line of why
   - `roles`: on or off for each fixed role, a one-line task for each (Hebrew
     when the request is Hebrew), and an optional model override with `why`
     when it departs from the owner's rule
   - new roles it invents (for example "Message copy") with a suggested model,
     marked `new`
   - `plan_agents`, `build_agents` (with how many at once), and what it left
     out and why
   - `grill_rounds` cap, and a suggested budget

   Sizing rule given to the model: small → 1 chapter, no grilling, 1 build
   agent. Medium → 2–5 chapters plus a critic. Large → more, but only with
   clearly separate responsibilities. Never use more agents than the work can
   actually split into.

### 2. Roles screen

The screen opens with the intake's proposal already filled in. The owner
never has to choose; Enter three times accepts it all. Each row shows:
- on/off, the role, and its one-line task
- the model, with its class letter (F / M / S / ?), and the effort
- a mark: ★ your rule · ◆ the intake departed from your rule (the "why" is
  shown under the row) · ✎ you changed it · `new` for an invented role
- on the selected row: which model backs it up if it does not answer

Keys: ↑/↓ move between roles. Space turns a role on or off. ←/→ change the
model. Tab moves between the model and effort columns.

### 3. Settings

| Row | Values | Meaning |
|---|---|---|
| plan budget | presets, or space → three digit dials like the council ($ dollars . tenths hundredths) | list-price cap. Split by role; 15% is held back for the joint plan |
| steps per role | 1–6 | look-ups before writing a chapter |
| agents | auto / max 1 / 2 / 4 / 6 | auto = the intake decides. A cap means the intake may use fewer, never more |
| grilling | auto / off / 1 round / until settled | auto = the intake's cap. "until settled" stops after at most 4 rounds |

### 4. PLAN board

The board lives in the per-run folder, as in the council:
`build/<time>-<slug>/{board.md, chapters/<role>.md, plan.md}`.

1. **Chapters.** Every active role except Second opinion writes its chapter
   in parallel. It sees the task, the run card and its own line, but not the
   other chapters.
2. **Grilling.** This follows the `grilling` skill, but between the models.
   - Each model asks the others at most **3 numbered questions per round**.
   - Every question names the chapter line it is about. It carries a
     recommended answer, and `Source: <file>` whenever it claims a fact. The
     council's source check marks each source ✓ or not found.
   - The model being asked replies in one of three ways: *accepted*, *revised*
     (its chapter changes), or *held: decision for the owner*.
   - Second opinion asks questions and writes no chapter.
3. **Referee.** After each round, a model that takes no side does the
   following:
   - It drops questions that point at no line, repeat an earlier question, or
     state a fact with no source. They are shown struck through, with the
     reason.
   - It writes a tally: questions, closed, sent to the owner, still open.
   - It decides whether to go on. It stops when any of these is true: no
     question is open between the models · only owner decisions are left ·
     the round cap is reached · the budget is spent.
4. **Joint plan.** The planner writes the joint plan: numbered tasks, each
   tagged with its role, its model and what it waits for. After it come
   "Still disputed" (who holds which side), "Backups used", and **"Questions
   for you"**.
5. The board ends with `✓ PLAN done — no code was changed`, then Spend and a
   Health line (reused from the council).

### 5. BUILD (phase 2, its own spec before coding)

The boundary is fixed now so that the plan's format supports it:

- **A lead model runs the build.** It decides, per group of tasks, whether
  agents work **in parallel, each in its own git worktree**, or **one after
  another in the same checkout**. This is how Claude already manages
  subagents.
- **The ownership table comes before any code.** The lead writes, on the
  board, which agent owns which files. Two agents never own the same file at
  the same time. If they overlap, they run one after the other. Tasks that
  share files go to one agent, in order.
- **Security reviews separately.** The security role gets its own agent, so
  it reviews code it did not write. Anything it finds goes back to the owning
  agent.
- **The lead merges and tests.** It reviews every change and merges. Tests and
  the typecheck run on the merged result. It reports which page to open on the
  owner's dev server.

## Questions to the owner: through Claude Code's question tool

The question dialog is a Claude Code tool, so the questions have to be asked
by the Claude session, not by the setup pane:

1. The runner writes `questions-<n>.json` in the run folder and pauses. The
   board shows `## Waiting for you`, and the pane says "answer in the Claude
   session".
2. The `/build` skill waits in the background, as the council skill does,
   until either an end marker appears (`## Spend` / `## Cancelled`) or a
   questions file appears.
3. The skill asks the questions with the question tool:
   - at most 4 questions per dialog, and more dialogs one after another if
     there are more
   - 2–4 options per question, with the recommended answer first and marked
     "(Recommended)"
   - the tool's own "Other" option carries a free-text answer
4. The skill writes `answers-<n>.json`, the runner continues, and the skill
   goes back to waiting.

Because of this, the models are told to phrase every question to the owner as
multiple choice. If a run is started from a bare terminal, where no Claude
session is waiting, the pane asks the questions itself.

## Backup model when a model does not answer

This applies in **both phases**. A call is tried twice. After that, the next
model **in the same class** takes over, trying a different provider first,
because a provider outage usually takes all of that provider's models down. If
the class has no one else, the role is marked "did not answer" and nobody
invents its part.

The board always shows the swap:
`GPT 6 Astra did not answer (503, tried twice) → Claude Fable 5.1 · backup · same class`.
In BUILD, the backup continues from the last saved step. This replaces the
council's "no stand-in" rule for this tool only; the council itself keeps its
own rule.

## Reuse from ccx council

- The setup-screen class and its patterns, and saved state next to
  `council.json`
- `split()`, for the side pane, the VS Code split, tmux or Terminal
- `load_models()`, the price table, `price_for` and the `Ledger`
- The read-only `run_tool` sandbox, which refuses the run folders
- The "Source:" check, the Health line, and the per-run folder layout
- `parse_seat`/`match_model`, for picking models from the command line

## Testing

- A self-test with no network, in the council's style, run against a temporary
  HOME and never the real one. It covers:
  - the choice of backup model: same class, other provider first, none left
  - moving models between classes, and a model offered but not sorted
  - rules defaults, intake overrides, and the ✎ and ◆ marks
  - budget split and reserve, and the digit dials
  - parsing the run card: a valid card, and a rejected invalid one
  - the referee's stop rules, and which questions it drops
  - batching questions into at most 4 per dialog, with 2–4 options each
- One live run through the local proxy with a medium task in PMS. Then one
  with a forced model failure, to see the backup on the board.

## Open, decided later

- The exact behaviour of the `/model` picker row (the second way in). The
  council session left notes: plan-mode requests go to the lead with
  coordinator instructions, and build mode gets lead instructions.
- The BUILD spec (phase 2): how write-capable agents run through ccx in
  worktrees, and where each model's build budget comes from.
