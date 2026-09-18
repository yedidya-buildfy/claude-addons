# ccx council Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `ccx council "<question>"` opens an arrow-key wizard, then several models write private plans, discuss them on a shared Markdown board in turns, and the chair writes a joint plan — with per-model effort, list-price budget, seats, and capped look-up steps.

**Architecture:** One Python program talks straight to the local proxy's Messages endpoint (probe 2026-09-18: per-request effort works, every response carries usage, tool use works). Pure logic (money, turns, stop rules, board text) lives in a core module; the wizard state is pure and drawn with curses; the runner holds the proxy client, three read-only look-up tools and the meeting loop.

**Tech Stack:** Python 3.11 stdlib only (`urllib`, `curses`, `concurrent.futures`, `json`, `re`), bash for the `ccx` subcommand.

**Spec:** `docs/superpowers/specs/2026-09-18-ccx-council-design.md`

## Global Constraints

- Stdlib only — no pip installs (ccx already needs python3).
- Proxy base for the council: `http://127.0.0.1:8317` (core proxy; tool use verified there). Key from `~/.cli-proxy-api/local-key`.
- Wizard chrome in English; the question is shown as typed.
- Efforts: `low / medium / high / xhigh / max`; default `high`.
- Max rounds 1–10 (default 5); steps per turn 1–6 (default 3); budget in cents, `0` = unlimited (default); presets `0, 50, 100, 200, 500, 1000` cents.
- Budget reserve for the joint plan: 15%. Seat = budget × 0.85 ÷ participants.
- Discussion message cap: 150 words.
- Look-ups: `read_file`, `list_dir`, `grep` only, confined to the folder the council runs in; each result capped at 20 KB. No shell.
- Remembered choices: `~/.claude/addons/council.json`, overridable with env `CCX_COUNCIL_STATE`. Self-tests never touch the real HOME.
- Board: `./council/YYYY-MM-DD-HHMM-<slug>.md`, append-only.
- Prices come from official pricing pages, never from memory; unknown model = priced as the most expensive row.
- New files are installed flat into `~/.claude/scripts/` via `RUNTIME` in `multi-model/install.sh`.

## File map

| File | Responsibility |
|---|---|
| `multi-model/ccx_council_core.py` | pure: prices, call cost, `Ledger`, turn/chair parsing, stop rules, labels, board text, worst-case estimate |
| `multi-model/ccx_council_wizard.py` | pure `Wizard` state machine + `render()` + curses `run_wizard()` |
| `multi-model/ccx-council.py` | proxy client, look-up tools, `Turn`, `Meeting`, `main()` |
| `multi-model/ccx-council-prices.json` | price table |
| `multi-model/ccx-council-selftest.py` | all self-tests (core, wizard, tools, meeting with fake proxy) |
| `multi-model/ccx` | `council` subcommand |
| `multi-model/install.sh` | add new files to `RUNTIME` |
| `multi-model/README.md` | short usage section |

All commands below run from `~/Desktop/Everything/old/claude-addons` in a worktree:

```bash
cd ~/Desktop/Everything/old/claude-addons
git worktree add ../claude-addons-council -b council master
cd ../claude-addons-council
```

---

### Task 1: Core — prices, cost, ledger

**Files:**
- Create: `multi-model/ccx_council_core.py`
- Create: `multi-model/ccx-council-selftest.py`

**Interfaces:**
- Produces: `EFFORTS`, `PRESETS_CENTS`, `RESERVE`, `WORD_CAP`, `load_prices(path) -> dict`, `price_for(prices, model_id) -> dict{in,cached,out,unknown}`, `call_cost(price, usage) -> float`, `usd(x) -> str`, `budget_label(cents) -> str`, `next_preset(cents, d) -> int`, `class Ledger(labels, budget_cents)` with `cap, seat, spent, reserve_spent, charge(label, cost, reserve=False), left(label), empty(label), all_empty(), total()`.

- [ ] **Step 1: Write the failing tests**

`multi-model/ccx-council-selftest.py`:

```python
#!/usr/bin/env python3
"""Self-test for ccx council. No network, no real HOME.  ./ccx-council-selftest.py"""
import os
import sys

HERE = os.path.dirname(os.path.realpath(__file__))
sys.path.insert(0, HERE)
import ccx_council_core as core

PRICES = {"models": {
    "cheap": {"in": 1.0, "cached": 0.1, "out": 4.0},
    "dear": {"in": 5.0, "cached": 0.5, "out": 25.0},
}}


def test_price_and_cost():
    assert core.price_for(PRICES, "cheap")["unknown"] is False
    unknown = core.price_for(PRICES, "mystery")
    assert unknown["unknown"] is True and unknown["out"] == 25.0   # never looks free
    usage = {"input_tokens": 1000, "cache_creation_input_tokens": 1000,
             "cache_read_input_tokens": 10000, "output_tokens": 2000}
    # (2000*1 + 10000*0.1 + 2000*4) / 1e6
    assert abs(core.call_cost(PRICES["models"]["cheap"] | {"unknown": False}, usage) - 0.011) < 1e-12
    assert core.call_cost(PRICES["models"]["cheap"], {}) == 0


def test_money_labels():
    assert core.usd(0.0123) == "$0.012" and core.usd(1.5) == "$1.50"
    assert core.budget_label(0) == "unlimited" and core.budget_label(235) == "$2.35"
    assert core.next_preset(0, 1) == 50 and core.next_preset(235, 1) == 500
    assert core.next_preset(235, -1) == 200 and core.next_preset(50, -1) == 0
    assert core.next_preset(1000, 1) == 1000 and core.next_preset(0, -1) == 0


def test_ledger():
    unlimited = core.Ledger(["A", "B"], 0)
    unlimited.charge("A", 5.0)
    assert unlimited.left("A") is None and not unlimited.empty("A") and not unlimited.all_empty()
    led = core.Ledger(["A", "B"], 100)                # $1.00 → seats $0.425, reserve $0.15
    assert abs(led.seat - 0.425) < 1e-12
    led.charge("A", 0.5)
    assert led.left("A") == 0.0 and led.empty("A") and not led.all_empty()
    led.charge("B", 0.425)
    assert led.all_empty()
    led.charge("B", 0.1, reserve=True)
    assert abs(led.total() - 1.025) < 1e-12        # one call may overshoot: stop signal, not a wall


TESTS = [v for k, v in sorted(globals().items()) if k.startswith("test_")]

if __name__ == "__main__":
    for t in TESTS:
        t()
        print("  ok  ", t.__name__)
    print("all passed")
```

- [ ] **Step 2: Run to verify it fails**

Run: `python3 multi-model/ccx-council-selftest.py`
Expected: `ModuleNotFoundError: No module named 'ccx_council_core'`

- [ ] **Step 3: Implement**

`multi-model/ccx_council_core.py`:

```python
"""Pure logic for `ccx council`: money, turns, stop rules, board text.

No network and no terminal here, so everything is testable from the self-test.
"""
import json
import re

EFFORTS = ["low", "medium", "high", "xhigh", "max"]
PRESETS_CENTS = [0, 50, 100, 200, 500, 1000]   # 0 = unlimited
RESERVE = 0.15      # share of a budget held back so the joint plan is always affordable
WORD_CAP = 150      # a discussion message, not a new plan


def load_prices(path):
    with open(path) as f:
        return json.load(f)


def price_for(prices, model):
    """Price row for a model. An unknown model is priced as the most expensive
    row, so it never looks free."""
    rows = prices["models"]
    if model in rows:
        return dict(rows[model], unknown=False)
    return dict(max(rows.values(), key=lambda r: r["out"]), unknown=True)


def call_cost(price, usage):
    """List-price dollars for one response. Cache writes count as fresh input;
    reasoning tokens are already inside output_tokens."""
    fresh = usage.get("input_tokens", 0) + usage.get("cache_creation_input_tokens", 0)
    cached = usage.get("cache_read_input_tokens", 0)
    out = usage.get("output_tokens", 0)
    return (fresh * price["in"] + cached * price["cached"] + out * price["out"]) / 1e6


def usd(x):
    return "$%.3f" % x if x < 0.1 else "$%.2f" % x


def budget_label(cents):
    return "$%d.%02d" % divmod(cents, 100) if cents else "unlimited"


def next_preset(cents, d):
    if d > 0:
        return next((p for p in PRESETS_CENTS if p > cents), cents)
    return next((p for p in reversed(PRESETS_CENTS) if p < cents), 0)


class Ledger:
    """Who spent what. With a budget: RESERVE is kept for the joint plan and the
    rest is split into equal seats (like speaking time)."""

    def __init__(self, labels, budget_cents):
        self.cap = budget_cents / 100 if budget_cents else None
        self.seat = self.cap * (1 - RESERVE) / len(labels) if self.cap else None
        self.spent = {label: 0.0 for label in labels}
        self.reserve_spent = 0.0

    def charge(self, label, cost, reserve=False):
        if reserve:
            self.reserve_spent += cost
        else:
            self.spent[label] += cost

    def left(self, label):
        return None if self.seat is None else max(0.0, self.seat - self.spent[label])

    def empty(self, label):
        return self.seat is not None and self.spent[label] >= self.seat

    def all_empty(self):
        return self.seat is not None and all(self.empty(label) for label in self.spent)

    def total(self):
        return sum(self.spent.values()) + self.reserve_spent
```

- [ ] **Step 4: Run to verify it passes**

Run: `python3 multi-model/ccx-council-selftest.py`
Expected: three `ok` lines, then `all passed`.

- [ ] **Step 5: Commit**

```bash
git add multi-model/ccx_council_core.py multi-model/ccx-council-selftest.py
git commit -m "feat(council): list-price cost and seat ledger"
```

---

### Task 2: Core — turns, stop rules, board text, estimate

**Files:**
- Modify: `multi-model/ccx_council_core.py` (append)
- Modify: `multi-model/ccx-council-selftest.py` (add tests above `TESTS =`)

**Interfaces:**
- Consumes: Task 1 names.
- Produces: `parse_turn(text) -> (kind: "pass"|"more"|"say", body: str, trimmed: bool)`, `parse_chair(text) -> (stop: bool, reason: str)`, `parse_grant(text) -> bool`, `stop_reason(round_no, max_rounds, all_passed, chair_stop, all_empty) -> str|None`, `seat_labels(names, anon) -> list[str]`, `board_path(now, question) -> str`, `tag(cost, steps=None, left=None) -> str`, `board_header(question, seats, labels, cfg, ledger) -> str`, `spend_block(ledger, chair_label) -> str`, `EFF_X`, `worst_case(seated, rounds, steps) -> float` where `seated` is `[(price_row, effort_index)]`, chair last.

- [ ] **Step 1: Write the failing tests**

Add to `multi-model/ccx-council-selftest.py` above `TESTS =`:

```python
import datetime


def test_parse_turn():
    assert core.parse_turn("  PASS — nothing to add") == ("pass", "", False)
    assert core.parse_turn("more: need the sync log") == ("more", "need the sync log", False)
    kind, body, trimmed = core.parse_turn("word " * 200)
    assert kind == "say" and trimmed and len(body.split()) == core.WORD_CAP + 1   # + the "…"
    assert core.parse_turn("Agree with B.") == ("say", "Agree with B.", False)
    assert core.parse_turn("PASSIVE voice is fine")[0] == "say"


def test_parse_chair_and_grant():
    assert core.parse_chair("STOP — agreement reached") == (True, "agreement reached")
    assert core.parse_chair("continue: cache question open") == (False, "cache question open")
    assert core.parse_chair("hmm")[0] is False            # unclear → go on; rounds cap still guards
    assert core.parse_grant("GRANT — could change the plan") and not core.parse_grant("DENY")


def test_stop_reason():
    assert core.stop_reason(1, 5, False, False, False) is None
    assert core.stop_reason(5, 5, False, False, False) == "max rounds"
    assert core.stop_reason(2, 5, False, True, False) == "chair called it"
    assert core.stop_reason(2, 5, True, False, False) == "everyone passed"
    assert core.stop_reason(2, 5, False, False, True) == "budget spent"


def test_labels_and_path():
    assert core.seat_labels(["GPT", "Gemini", "Opus"], True) == ["A", "B", "C"]
    assert core.seat_labels(["GPT", "Opus"], False) == ["GPT", "Opus"]
    now = datetime.datetime(2026, 9, 18, 14, 30)
    assert core.board_path(now, "Why is the Last-minute discount missing?") == \
        "council/2026-09-18-1430-why-is-the-last-minute-discount.md"
    assert core.board_path(now, "למה ההנחה לא מגיעה?") == "council/2026-09-18-1430-council.md"


def test_board_text():
    assert core.tag(0.081, 2, 0.005) == " · 2 steps · $0.081 · $0.005 left"
    assert core.tag(0.5) == " · $0.50"
    seats = [{"label": "GPT 5.6 Sol", "effort": "xhigh"}, {"label": "Claude Opus 5", "effort": "high"}]
    cfg = {"rounds": 5, "anon": False, "budget": 100, "steps": 3}
    led = core.Ledger(["GPT 5.6 Sol", "Claude Opus 5"], 100)
    head = core.board_header("Q?", seats, ["GPT 5.6 Sol", "Claude Opus 5"], cfg, led)
    assert "chair Claude Opus 5" in head and "$0.43 a seat" in head and "GPT 5.6 Sol · xhigh" in head
    anon = core.board_header("Q?", seats, ["A", "B"], dict(cfg, anon=True), led)
    assert "GPT" not in anon and "chair B" in anon
    led.charge("GPT 5.6 Sol", 0.2)
    led.charge("Claude Opus 5", 0.1, reserve=True)
    spend = core.spend_block(led, "Claude Opus 5")
    assert "joint plan (Claude Opus 5, reserve): $0.10" in spend and "total $0.30** of $1.00" in spend


def test_worst_case():
    cheap = dict(PRICES["models"]["cheap"], unknown=False)
    one = core.worst_case([(cheap, 2), (cheap, 2)], 1, 1)
    more = core.worst_case([(cheap, 2), (cheap, 2)], 5, 3)
    assert 0 < one < more
```

- [ ] **Step 2: Run to verify they fail**

Run: `python3 multi-model/ccx-council-selftest.py`
Expected: `AttributeError: module 'ccx_council_core' has no attribute 'board_header'` (or the first missing name).

- [ ] **Step 3: Implement** — append to `multi-model/ccx_council_core.py`:

```python
# ---- turns ---------------------------------------------------------------

def parse_turn(text):
    """A discussion turn is PASS, MORE: <reason>, or a short message."""
    t = text.strip()
    if re.match(r"PASS\b", t, re.I):
        return ("pass", "", False)
    m = re.match(r"MORE\s*:\s*(.*)", t, re.I | re.S)
    if m:
        return ("more", m.group(1).strip(), False)
    words = t.split()
    if len(words) > WORD_CAP:
        return ("say", " ".join(words[:WORD_CAP]) + " …", True)
    return ("say", t, False)


def parse_chair(text):
    m = re.match(r"(STOP|CONTINUE)\b\W*(.*)", text.strip(), re.I | re.S)
    if not m:
        return (False, text.strip()[:200])
    return (m.group(1).upper() == "STOP", m.group(2).strip()[:200])


def parse_grant(text):
    return bool(re.match(r"GRANT", text.strip(), re.I))


def stop_reason(round_no, max_rounds, all_passed, chair_stop, all_empty):
    if all_empty:
        return "budget spent"
    if all_passed:
        return "everyone passed"
    if chair_stop:
        return "chair called it"
    if round_no >= max_rounds:
        return "max rounds"
    return None


# ---- board ---------------------------------------------------------------

def seat_labels(names, anon):
    return [chr(65 + i) for i in range(len(names))] if anon else list(names)


def board_path(now, question):
    slug = "-".join(re.findall(r"[a-z0-9]+", question.lower())[:6]) or "council"
    return f"council/{now:%Y-%m-%d-%H%M}-{slug}.md"


def tag(cost, steps=None, left=None):
    parts = [f"{steps} step{'' if steps == 1 else 's'}"] if steps else []
    parts.append(usd(cost))
    if left is not None:
        parts.append(f"{usd(left)} left")
    return " · " + " · ".join(parts)


def board_header(question, seats, labels, cfg, ledger):
    """seats/labels are in speaking order, chair last."""
    money = budget_label(cfg["budget"])
    if ledger.cap:
        money += f" ({usd(ledger.seat)} a seat + {usd(ledger.cap * RESERVE)} reserved for the joint plan)"
    lines = [f"# Council — {question}", "",
             f"chair {labels[-1]} · {len(seats)} at the table · max {cfg['rounds']} rounds · "
             f"{'anonymous' if cfg['anon'] else 'named'} · budget {money} · {cfg['steps']} steps a turn", ""]
    if not cfg["anon"]:          # in anonymous mode names and efforts wait for "Who was who"
        lines += [f"- {s['label']} · {s['effort']}" for s in seats] + [""]
    return "\n".join(lines)


def spend_block(ledger, chair_label):
    rows = [f"- {label}: {usd(cost)}" for label, cost in ledger.spent.items()]
    if ledger.reserve_spent:
        rows.append(f"- joint plan ({chair_label}, reserve): {usd(ledger.reserve_spent)}")
    total = f"**total {usd(ledger.total())}**" + (f" of {usd(ledger.cap)}" if ledger.cap else "")
    return ("\n## Spend\n\n_list price — nothing is billed, it runs on your subscriptions_\n\n"
            + "\n".join(rows) + "\n\n" + total + "\n")


# ---- wizard estimate -------------------------------------------------------

EFF_X = [0.6, 1, 1.6, 2.4, 3.5]   # rough output growth with effort; wizard estimate only


def worst_case(seated, rounds, steps):
    """Upper estimate shown before Enter: every seat uses every step plus one
    extension each round, for all rounds, plus chair calls and the joint plan.
    seated = [(price_row, effort_index)], chair last."""
    def call(p, e, board, out):
        return (500 * p["in"] + board * p["cached"] + out * EFF_X[e] * p["out"]) / 1e6
    board = 2000 * len(seated)
    total = sum(call(p, e, 4000, 2000) for p, e in seated)
    for _ in range(rounds):
        for p, e in seated:
            total += call(p, e, board, 300) * steps * 2
            board += 300
        total += call(*seated[-1], board, 60)
    return total + call(*seated[-1], board, 1500)
```

- [ ] **Step 4: Run to verify it passes**

Run: `python3 multi-model/ccx-council-selftest.py`
Expected: nine `ok` lines, `all passed`.

- [ ] **Step 5: Commit**

```bash
git add multi-model/ccx_council_core.py multi-model/ccx-council-selftest.py
git commit -m "feat(council): turn parsing, stop rules, board text"
```

---

### Task 3: Price table from official pages

**Files:**
- Create: `multi-model/ccx-council-prices.json`

**Interfaces:**
- Produces: `{"updated": "YYYY-MM-DD", "note": str, "models": {model_id: {"in": float, "cached": float, "out": float, "source": url}}}` — dollars per 1M tokens. Keys are the request ids the wizard uses (`ccx-models.py picker` ids without `[1m]`).

- [ ] **Step 1: List the ids to price**

```bash
K=$(cat ~/.cli-proxy-api/local-key)
curl -s -m10 -H "x-api-key: $K" -H "anthropic-version: 2023-06-01" "http://127.0.0.1:8317/v1/models?limit=1000" \
 | python3 multi-model/ccx-models.py picker \
 | python3 -c "import json,sys,re;[print(re.sub(r'\[.*\]$','',o['model']),'|',o['label']) for o in json.load(sys.stdin)['options'] if 'plan' not in o['model']]"
```

- [ ] **Step 2: Fetch each provider's official pricing page** (WebFetch; never from memory): Anthropic `https://www.anthropic.com/pricing` (API section) and `https://docs.anthropic.com/en/docs/about-claude/pricing`; OpenAI `https://openai.com/api/pricing/`; Google `https://ai.google.dev/gemini-api/docs/pricing`; xAI `https://docs.x.ai/docs/models`. For each listed id record input, cached-input (cache hit / cached input; if the page gives none, use the input price) and output per 1M tokens, plus the page URL. A model the pages do not price is left out — it will show `price ?` and count as the most expensive row.

- [ ] **Step 3: Write the file** in this exact shape (values from Step 2):

```json
{
  "updated": "2026-09-18",
  "note": "List price per 1M tokens from each provider's official page. Council runs on subscriptions; this is a yardstick, not a bill.",
  "models": {
    "claude-opus-5": {"in": 0, "cached": 0, "out": 0, "source": "https://docs.anthropic.com/en/docs/about-claude/pricing"}
  }
}
```

(one row per priced id; every `0` above replaced by the fetched value)

- [ ] **Step 4: Check it loads and every row is complete**

Run: `python3 -c "import json;d=json.load(open('multi-model/ccx-council-prices.json'));assert all({'in','cached','out','source'}<=set(r) and r['out']>0 for r in d['models'].values());print(len(d['models']),'rows ok')"`
Expected: `N rows ok`

- [ ] **Step 5: Commit**

```bash
git add multi-model/ccx-council-prices.json
git commit -m "feat(council): list-price table from official pricing pages"
```

---

### Task 4: Wizard state machine

**Files:**
- Create: `multi-model/ccx_council_wizard.py`
- Modify: `multi-model/ccx-council-selftest.py`

**Interfaces:**
- Consumes: `core.EFFORTS`, `core.next_preset`.
- Produces: `class Wizard(models: list[{"id","label"}], saved: dict|None)` with attributes `step, cur, chair, seated: set[int], effort: dict[id,int], rounds, anon, budget, steps, edit, seg, note`; `key(k) -> "start"|"quit"|None` where `k` ∈ `up down left right space enter esc q 0-9`; `config() -> {"seats": [{"id","label","effort"}] (chair last), "rounds", "anon", "budget", "steps"}`; `saved() -> dict`; `load_state(path) -> dict`, `save_state(path, data)`.

- [ ] **Step 1: Write the failing tests** (add above `TESTS =`):

```python
import json
import tempfile
from ccx_council_wizard import Wizard, load_state, save_state

MODELS = [{"id": "opus", "label": "Claude Opus 5"}, {"id": "sol", "label": "GPT 5.6 Sol"},
          {"id": "pro", "label": "Gemini 3.1 Pro"}]


def press(w, *keys):
    out = None
    for k in keys:
        out = w.key(k)
    return out


def test_wizard_flow():
    w = Wizard(MODELS)
    assert w.step == 0 and w.effort["opus"] == 2                       # default high
    press(w, "down", "right", "right", "enter")                         # chair = sol at max
    assert w.chair == 1 and w.effort["sol"] == 4 and w.step == 1
    assert w.seated == {0, 1}                                           # first default chair stays seated
    w.cur = 0
    press(w, "space", "enter")                                          # unseat opus → only the chair left
    assert w.step == 1 and "at least 2" in w.note
    press(w, "space", "left", "enter")                                  # seat opus again at medium
    assert w.step == 2 and w.effort["opus"] == 1
    press(w, "esc")
    assert w.step == 1 and w.cur == 0
    w.cur = 1
    press(w, "space")
    assert 1 in w.seated                                                # the chair can't be unseated
    press(w, "enter", "right", "down", "right", "down", "right", "down", "left")
    assert (w.rounds, w.anon, w.budget, w.steps) == (6, True, 50, 2)
    cfg = w.config()
    assert [s["id"] for s in cfg["seats"]] == ["opus", "sol"]           # chair last
    assert cfg["seats"][1]["effort"] == "max"
    assert press(w, "enter") == "start"


def test_wizard_budget_dials():
    w = Wizard(MODELS)
    press(w, "enter", "down", "space", "enter")                         # opus chair + sol → settings
    w.cur = 2
    press(w, "space", "2", "right", "3", "5")
    assert w.budget == 235 and w.edit
    press(w, "enter")
    assert not w.edit
    press(w, "7")                                                       # typing opens the dials too
    assert w.edit and w.budget == 2735                                  # dollars shift in: 2 → 27
    press(w, "esc", "space", "left", "up")                              # hundredths dial wraps 5 → 6
    assert w.budget == 2736
    press(w, "enter", "right")
    assert w.budget == 2736                                             # no preset above $27.36
    press(w, "left")
    assert w.budget == 1000


def test_wizard_remembers():
    with tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, "council.json")
        assert load_state(path) == {}
        w = Wizard(MODELS)
        press(w, "down", "down", "enter", "enter", "right")             # chair pro, opus seated, 6 rounds
        save_state(path, w.saved())
        w2 = Wizard(MODELS + [{"id": "new", "label": "New"}], load_state(path))
        assert w2.chair == 2 and w2.seated == {0, 2} and w2.rounds == 6
        assert w2.effort["new"] == 2                                    # unseen model → high
```

- [ ] **Step 2: Run to verify they fail**

Run: `python3 multi-model/ccx-council-selftest.py`
Expected: `ModuleNotFoundError: No module named 'ccx_council_wizard'`

- [ ] **Step 3: Implement** `multi-model/ccx_council_wizard.py` (state part):

```python
"""The `ccx council` setup wizard: pure state + drawing + a thin curses loop.

Three steps, chosen from browser mockups on 2026-09-18: chair → table → settings.
"""
import json
import os

import ccx_council_core as core


def load_state(path):
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def save_state(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        json.dump(data, f, indent=2)


class Wizard:
    STEPS = ("chair", "table", "settings")

    def __init__(self, models, saved=None):
        saved = saved or {}
        self.models = models
        ids = [m["id"] for m in models]
        self.effort = {i: saved.get("effort", {}).get(i, 2) for i in ids}
        self.chair = ids.index(saved["chair"]) if saved.get("chair") in ids else 0
        self.seated = {ids.index(i) for i in saved.get("seated", []) if i in ids} | {self.chair}
        self.rounds = saved.get("rounds", 5)
        self.anon = saved.get("anon", False)
        self.budget = saved.get("budget", 0)       # cents, 0 = unlimited
        self.steps = saved.get("steps", 3)
        self.step, self.cur, self.edit, self.seg, self.note = 0, self.chair, False, 0, ""

    def key(self, k):
        self.note = ""
        if self.edit:
            return self._dial(k)
        n = 4 if self.step == 2 else len(self.models)
        if k == "up":
            self.cur = (self.cur - 1) % n
        elif k == "down":
            self.cur = (self.cur + 1) % n
        elif k == "q":
            return "quit"
        elif k == "esc":
            if self.step == 0:
                return "quit"
            self.step -= 1
            self.cur = self.chair if self.step == 0 else 0
        elif self.step == 0:
            self._chair_key(k)
        elif self.step == 1:
            self._table_key(k)
        else:
            return self._settings_key(k)
        return None

    @staticmethod
    def _dir(k):
        return 1 if k == "right" else -1 if k == "left" else 0

    def _bump_effort(self, d):
        mid = self.models[self.cur]["id"]
        self.effort[mid] = min(4, max(0, self.effort[mid] + d))

    def _chair_key(self, k):
        if self._dir(k):
            self._bump_effort(self._dir(k))
        elif k in ("space", "enter"):
            self.chair = self.cur
            self.seated.add(self.cur)
            if k == "enter":
                self.step = 1

    def _table_key(self, k):
        if k == "space" and self.cur != self.chair:
            self.seated ^= {self.cur}
        elif self._dir(k) and self.cur in self.seated:
            self._bump_effort(self._dir(k))
        elif k == "enter":
            if len(self.seated) < 2:
                self.note = "need at least 2 at the table (chair included)"
            else:
                self.step, self.cur = 2, 0

    def _settings_key(self, k):
        if k == "enter":
            return "start"
        if self.cur == 2 and (k == "space" or k.isdigit()):
            self.edit, self.seg = True, 0
            return self._dial(k) if k.isdigit() else None
        d = self._dir(k)
        if not d:
            return None
        if self.cur == 0:
            self.rounds = min(10, max(1, self.rounds + d))
        elif self.cur == 1:
            self.anon = not self.anon
        elif self.cur == 2:
            self.budget = core.next_preset(self.budget, d)
        else:
            self.steps = min(6, max(1, self.steps + d))
        return None

    def _dial(self, k):
        """Three dials: dollars (0-99) . tenths . hundredths. All zero = unlimited."""
        dol, t, h = self.budget // 100, self.budget // 10 % 10, self.budget % 10
        if k == "left":
            self.seg = (self.seg - 1) % 3
        elif k == "right":
            self.seg = (self.seg + 1) % 3
        elif k in ("up", "down"):
            d = 1 if k == "up" else -1
            if self.seg == 0:
                dol = (dol + d) % 100
            elif self.seg == 1:
                t = (t + d) % 10
            else:
                h = (h + d) % 10
        elif k.isdigit():
            v = int(k)
            if self.seg == 0:
                dol = dol % 10 * 10 + v
            elif self.seg == 1:
                t, self.seg = v, 2
            else:
                h = v
        elif k in ("enter", "space", "esc"):
            self.edit = False
        self.budget = dol * 100 + t * 10 + h
        return None

    def order(self):
        """Seated model indexes in speaking order, chair last."""
        return [i for i in range(len(self.models)) if i in self.seated and i != self.chair] + [self.chair]

    def config(self):
        seats = [{"id": self.models[i]["id"], "label": self.models[i]["label"],
                  "effort": core.EFFORTS[self.effort[self.models[i]["id"]]]} for i in self.order()]
        return {"seats": seats, "rounds": self.rounds, "anon": self.anon,
                "budget": self.budget, "steps": self.steps}

    def saved(self):
        return {"effort": self.effort, "chair": self.models[self.chair]["id"],
                "seated": [self.models[i]["id"] for i in sorted(self.seated)],
                "rounds": self.rounds, "anon": self.anon, "budget": self.budget, "steps": self.steps}
```

- [ ] **Step 4: Run to verify it passes**

Run: `python3 multi-model/ccx-council-selftest.py`
Expected: all `ok`, `all passed`. Settings rows are `0 rounds · 1 names · 2 budget · 3 steps`; `right` on budget moves `0 → 50` cents.

- [ ] **Step 5: Commit**

```bash
git add multi-model/ccx_council_wizard.py multi-model/ccx-council-selftest.py
git commit -m "feat(council): wizard state with effort, seats, budget dials"
```

---

### Task 5: Wizard drawing + curses loop

**Files:**
- Modify: `multi-model/ccx_council_wizard.py` (append)
- Modify: `multi-model/ccx-council-selftest.py`

**Interfaces:**
- Consumes: `Wizard`, `core.usd`, `core.budget_label`, `core.RESERVE`.
- Produces: `render(w, question, price_of, estimate) -> list[list[(style, text)]]` (styles: `"" b dim cy ye gr re sel`); `run_wizard(w, question, price_of, estimate) -> "start"|"quit"`. `price_of(model_id) -> price_row`, `estimate(w) -> float`.

- [ ] **Step 1: Failing test** (add above `TESTS =`):

```python
from ccx_council_wizard import render


def text_of(lines):
    return "\n".join("".join(t for _, t in line) for line in lines)


def test_render():
    w = Wizard(MODELS)
    price = lambda mid: dict(PRICES["models"]["cheap"], unknown=mid == "pro")
    shot = text_of(render(w, "Q?", price, lambda w: 1.234))
    assert "1 chair" in shot and "Claude Opus 5" in shot and "high" in shot and "price ?" in shot
    press(w, "enter", "down", "space", "enter")
    w.cur = 2; press(w, "space", "2")
    shot = text_of(render(w, "Q?", price, lambda w: 1.234))
    assert "$ 2.00" in shot and "worst case ≈ $1.23" in shot
```

- [ ] **Step 2: Run to verify it fails**

Run: `python3 multi-model/ccx-council-selftest.py`
Expected: `ImportError: cannot import name 'render'`

- [ ] **Step 3: Implement** — append to `multi-model/ccx_council_wizard.py`:

```python
METER = "▁▃▅▆█"
HINTS = ["  ↑↓ move · ←→ effort · space choose · enter next · q quit",
         "  ↑↓ move · space seat/unseat · ←→ effort · enter next · esc back",
         "  ↑↓ move · ←→ change · space on budget: exact amount · enter start · esc back"]


def price_label(p):
    return "price ?" if p["unknown"] else f"${p['in']:g} / ${p['out']:g}"


def _cursor(w, i):
    return ("cy", "› ") if w.cur == i else ("", "  ")


def _effort(e):
    return [("dim", "◀ "), ("", f"{core.EFFORTS[e]:<6}"), ("dim", " ▶ "),
            ("", METER[:e + 1]), ("dim", METER[e + 1:])]


def _arrows(value, style=""):
    return [("dim", "◀ "), (style, value), ("dim", " ▶")]


def _dials(w):
    dol, t, h = w.budget // 100, w.budget // 10 % 10, w.budget % 10
    seg = lambda i, v: ("sel" if w.seg == i else "b", v)
    return [("", "$ "), seg(0, str(dol)), ("", "."), seg(1, str(t)), seg(2, str(h)),
            ("dim", "" if w.budget else "  = unlimited")]


def _budget_hint(w):
    if w.edit:
        return "←→ dial · ↑↓ or type 0-9 · enter done"
    if not w.budget:
        return "no cap · space: set an exact amount"
    cap, n = w.budget / 100, len(w.seated)
    return (f"each seat {core.usd(cap * (1 - core.RESERVE) / n)} + "
            f"{core.usd(cap * core.RESERVE)} held for the joint plan · space: fine-tune")


def render(w, question, price_of, estimate):
    lines = [[("b", "ccx council"), ("", "  " + question)], []]
    bar = [("", "  ")]
    for i, name in enumerate(Wizard.STEPS):
        if i:
            bar.append(("dim", "  ─  "))
        style = "cy" if i == w.step else "gr" if i < w.step else "dim"
        bar.append((style, f"{i + 1} {name}" + (" ✓" if i < w.step else "")))
    lines += [bar, []]
    if w.step < 2:
        if w.step == 0:
            lines += [[("b", "  Who chairs the meeting?")],
                      [("dim", "  The chair writes a plan too, grants extra time, decides when to stop, "
                               "and writes the joint plan.")], []]
        else:
            lines += [[("b", "  Who else sits at the table, and how hard does each one think?")],
                      [("dim", " " * 58 + "list price in / out per 1M")]]
        for i, m in enumerate(w.models):
            shown = w.step == 0 or i in w.seated
            if w.step == 0:
                mark = ("ye", "(★)") if i == w.chair else ("dim", "( )")
            else:
                mark = ("ye", " ★ ") if i == w.chair else ("cy", "[x]") if i in w.seated else ("dim", "[ ]")
            row = [_cursor(w, i), mark, ("" if shown else "dim", f" {m['label']:<22}")]
            row += _effort(w.effort[m["id"]]) if shown else [("", " " * 20)]
            row.append(("dim", "  " + price_label(price_of(m["id"]))))
            lines.append(row)
    else:
        budget_cell = (_dials(w) if w.edit
                       else _arrows(f"{core.budget_label(w.budget):<9}", "ye" if w.budget else ""))
        rows = [("max rounds", _arrows(f"{w.rounds:>2}"),
                 "stops earlier if the chair calls it or everyone passes"),
                ("plans shown as", _arrows("anonymous" if w.anon else "named    ", "ye" if w.anon else ""),
                 "A, B, C… revealed at the end" if w.anon else "model names on every message"),
                ("budget", budget_cell, _budget_hint(w)),
                ("steps per turn", _arrows(f"{w.steps:>2}"),
                 f"look-ups before speaking · chair may grant +{w.steps} once a round")]
        lines += [[("b", "  Meeting rules")], []]
        for i, (name, cell, hint) in enumerate(rows):
            lines.append([_cursor(w, i), ("", f"{name:<16}")] + cell + [("dim", "  " + hint)])
        lines += [[], [("dim", "  " + "─" * 44)]]
        chair_id = w.models[w.chair]["id"]
        for s in w.config()["seats"]:
            lines.append([("ye", "  ★ ") if s["id"] == chair_id else ("", "    "),
                          ("", f"{s['label']:<22}"),
                          ("dim", f"{s['effort']:<7}{price_label(price_of(s['id']))}")])
    lines.append([])
    if w.note:
        lines.append([("re", "  " + w.note)])
    else:
        est = estimate(w)
        foot = [("dim", f"  {len(w.seated)} at the table · worst case ≈ {core.usd(est)} list price")]
        if w.budget and est > w.budget / 100:
            foot.append(("ye", "  (budget will stop it earlier)"))
        lines.append(foot)
    lines += [[], [("dim", HINTS[w.step])]]
    return lines
```

Then the curses loop:

```python
KEYS = {"\n": "enter", "\r": "enter", "\x1b": "esc", " ": "space", "q": "q"}


def run_wizard(w, question, price_of, estimate):
    import curses
    os.environ.setdefault("ESCDELAY", "25")

    def loop(scr):
        curses.curs_set(0)
        scr.keypad(True)
        curses.start_color()
        curses.use_default_colors()
        attr = {"": 0, "b": curses.A_BOLD, "dim": curses.A_DIM, "sel": curses.A_REVERSE | curses.A_BOLD}
        for n, (name, color) in enumerate([("cy", curses.COLOR_CYAN), ("ye", curses.COLOR_YELLOW),
                                           ("gr", curses.COLOR_GREEN), ("re", curses.COLOR_RED)], 1):
            curses.init_pair(n, color, -1)
            attr[name] = curses.color_pair(n)
        arrows = {curses.KEY_UP: "up", curses.KEY_DOWN: "down",
                  curses.KEY_LEFT: "left", curses.KEY_RIGHT: "right", curses.KEY_ENTER: "enter"}
        while True:
            scr.erase()
            h, width = scr.getmaxyx()
            for y, line in enumerate(render(w, question, price_of, estimate)[:h - 1]):
                x = 0
                for style, text in line:
                    if x >= width - 1:
                        break
                    scr.addnstr(y, x, text, width - 1 - x, attr.get(style, 0))
                    x += len(text)
            scr.refresh()
            ch = scr.get_wch()
            k = arrows.get(ch) if isinstance(ch, int) else KEYS.get(ch, ch if ch.isdigit() else None)
            if k:
                out = w.key(k)
                if out:
                    return out

    return curses.wrapper(loop)
```

- [ ] **Step 4: Run to verify it passes**

Run: `python3 multi-model/ccx-council-selftest.py`
Expected: all `ok`. (`$ 2.00` in the test comes from `("", "$ ")` + `"2"` + `"."` + `"0"` + `"0"`.)

- [ ] **Step 5: Commit**

```bash
git add multi-model/ccx_council_wizard.py multi-model/ccx-council-selftest.py
git commit -m "feat(council): wizard drawing and curses loop"
```

---

### Task 6: Runner — proxy client and look-up tools

**Files:**
- Create: `multi-model/ccx-council.py`
- Modify: `multi-model/ccx-council-selftest.py`

**Interfaces:**
- Produces: `CallError(Exception)`, `make_post(base, key) -> post(model, effort, system, messages, tools=None, max_tokens=16000) -> dict` (raw Messages response), `TOOLS`, `run_tool(root, name, args) -> str`, `LIMIT = 20_000`.

- [ ] **Step 1: Failing tests** (add above `TESTS =`):

```python
import importlib.util

spec = importlib.util.spec_from_file_location("council", os.path.join(HERE, "ccx-council.py"))
council = importlib.util.module_from_spec(spec)
spec.loader.exec_module(council)


def test_tools_stay_inside():
    with tempfile.TemporaryDirectory() as root:
        os.makedirs(os.path.join(root, "src"))
        with open(os.path.join(root, "src", "a.py"), "w") as f:
            f.write("x = 1\nsync_window = 2\n")
        with open(os.path.join(root, "big.txt"), "w") as f:
            f.write("y" * 30_000)
        assert council.run_tool(root, "read_file", {"path": "src/a.py"}).startswith("x = 1")
        assert council.run_tool(root, "list_dir", {"path": "."}) == "big.txt\nsrc/"
        assert council.run_tool(root, "grep", {"pattern": "sync_"}) == "src/a.py:2: sync_window = 2"
        assert "outside" in council.run_tool(root, "read_file", {"path": "../../etc/passwd"})
        assert "outside" in council.run_tool(root, "read_file", {"path": "/etc/passwd"})
        assert council.run_tool(root, "read_file", {"path": "big.txt"}).endswith("[cut at 20 KB]")
        assert council.run_tool(root, "shell", {}) == "unknown tool shell"
        assert council.run_tool(root, "grep", {"pattern": "("}).startswith("error:")
```

- [ ] **Step 2: Run to verify it fails**

Run: `python3 multi-model/ccx-council-selftest.py`
Expected: `FileNotFoundError` for `ccx-council.py`.

- [ ] **Step 3: Implement** `multi-model/ccx-council.py` (first part):

```python
#!/usr/bin/env python3
"""ccx council — several models plan together on one shared board.

    ccx council "<question>"

Talks straight to the local proxy (per-request effort and usage verified on
2026-09-18). See docs/superpowers/specs/2026-09-18-ccx-council-design.md.
"""
import argparse
import datetime
import json
import locale
import os
import re
import shutil
import subprocess
import sys
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor

HERE = os.path.dirname(os.path.realpath(__file__))
sys.path.insert(0, HERE)
import ccx_council_core as core  # noqa: E402
from ccx_council_wizard import Wizard, load_state, run_wizard, save_state  # noqa: E402


class CallError(Exception):
    pass


def make_post(base, key):
    def post(model, effort, system, messages, tools=None, max_tokens=16000):
        body = {"model": model, "max_tokens": max_tokens, "system": system, "messages": messages,
                "thinking": {"type": "adaptive"}, "output_config": {"effort": effort}}
        if tools:
            body["tools"] = tools
        req = urllib.request.Request(
            base + "/v1/messages", data=json.dumps(body).encode(),
            headers={"x-api-key": key, "anthropic-version": "2023-06-01",
                     "content-type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=600) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            raise CallError(f"{e.code} {e.read()[:200].decode(errors='replace')}") from None
        except (urllib.error.URLError, OSError, ValueError) as e:
            raise CallError(str(e)) from None
    return post


# ---- look-ups: read-only, inside the folder the council runs in -----------

LIMIT = 20_000
SKIP_DIRS = {".git", "node_modules", ".next", "__pycache__", ".venv", "council"}


def _obj(**props):
    return {"type": "object", "properties": {k: {"type": "string", "description": v} for k, v in props.items()},
            "required": [next(iter(props))]}


TOOLS = [
    {"name": "read_file", "description": "Read a text file in the project folder.",
     "input_schema": _obj(path="path relative to the project folder")},
    {"name": "list_dir", "description": "List a folder in the project folder.",
     "input_schema": _obj(path="folder relative to the project folder, '.' for the top")},
    {"name": "grep", "description": "Search text files in the project folder for a regular expression. "
                                    "Returns path:line: text matches.",
     "input_schema": _obj(pattern="regular expression", path="folder to search, default '.'")},
]


def _inside(root, path):
    real_root = os.path.realpath(root)
    p = os.path.realpath(os.path.join(real_root, path or "."))
    if p != real_root and not p.startswith(real_root + os.sep):
        raise ValueError("outside the project folder")
    return p


def _grep(root, pattern, path):
    rx, hits, size = re.compile(pattern), [], 0
    for d, dirs, files in os.walk(_inside(root, path)):
        dirs[:] = sorted(x for x in dirs if x not in SKIP_DIRS)
        for name in sorted(files):
            full = os.path.join(d, name)
            try:
                with open(full, encoding="utf-8") as f:
                    for n, line in enumerate(f, 1):
                        if rx.search(line):
                            hit = f"{os.path.relpath(full, os.path.realpath(root))}:{n}: {line.rstrip()[:200]}"
                            hits.append(hit)
                            size += len(hit)
                            if size > LIMIT:
                                return "\n".join(hits)
            except (UnicodeDecodeError, OSError):
                continue
    return "\n".join(hits) or "no matches"


def run_tool(root, name, args):
    try:
        if name == "read_file":
            with open(_inside(root, args["path"]), encoding="utf-8", errors="replace") as f:
                out = f.read(LIMIT + 1)
        elif name == "list_dir":
            p = _inside(root, args.get("path"))
            out = "\n".join(e + ("/" if os.path.isdir(os.path.join(p, e)) else "") for e in sorted(os.listdir(p)))
        elif name == "grep":
            out = _grep(root, args["pattern"], args.get("path"))
        else:
            return f"unknown tool {name}"
    except (OSError, ValueError, KeyError, re.error) as e:
        return f"error: {e}"
    return out[:LIMIT] + "\n[cut at 20 KB]" if len(out) > LIMIT else out
```

- [ ] **Step 4: Run to verify it passes**

Run: `python3 multi-model/ccx-council-selftest.py`
Expected: all `ok`.

- [ ] **Step 5: Commit**

```bash
git add multi-model/ccx-council.py multi-model/ccx-council-selftest.py
git commit -m "feat(council): proxy client and read-only look-up tools"
```

---

### Task 7: Runner — turns and the meeting loop

**Files:**
- Modify: `multi-model/ccx-council.py` (append)
- Modify: `multi-model/ccx-council-selftest.py`

**Interfaces:**
- Consumes: `CallError`, `run_tool`, `TOOLS`, all of core.
- Produces: `class Turn(post, seat, system, user, steps, root, price, tools=True)` with `run() -> str`, `extend(last_text, steps)`, attrs `cost, used, allowance, msgs`; `class Meeting(cfg, question, post, prices, root, board_file, log)` with `run()` and `stopped()`; prompt constants `PLAN_SYSTEM TURN_SYSTEM CHAIR_SYSTEM GRANT_SYSTEM JOINT_SYSTEM`.

- [ ] **Step 1: Failing test** (add above `TESTS =`):

```python
def fake_proxy(script):
    """script: model id -> list of replies for discussion turns; everything else is canned."""
    calls = []

    def post(model, effort, system, messages, tools=None, max_tokens=16000):
        calls.append((model, effort, system[:30]))
        usage = {"input_tokens": 1000, "output_tokens": 200}
        text = lambda t: {"content": [{"type": "text", "text": t}], "usage": usage}
        if model == "broken":
            raise council.CallError("429 usage_limit_reached")
        if "complete plan" in system:
            return text(f"1. plan by {model}")
        if "go on" in system:
            return text("STOP — agreement on the small fix")
        if "more look-up time" in system:
            return text("GRANT — could change the plan")
        if "discussion is over" in system:
            return text("1. push discounted nights\n### Still disputed\n- none")
        last = messages[-1]["content"]
        if isinstance(last, list) and last and last[0].get("type") == "tool_result":
            assert "sync_window" in last[0]["content"]
        reply = script[model].pop(0)
        if reply == "TOOL":
            return {"content": [{"type": "tool_use", "id": "t1", "name": "grep",
                                 "input": {"pattern": "sync_"}}], "usage": usage}
        return text(reply)
    return post, calls


def run_meeting(seats, script, **cfg):
    root = tempfile.mkdtemp()
    with open(os.path.join(root, "a.py"), "w") as f:
        f.write("sync_window = 2\n")
    post, calls = fake_proxy(script)
    conf = {"seats": seats, "rounds": 5, "anon": False, "budget": 0, "steps": 3} | cfg
    board = os.path.join(root, "council", "b.md")
    council.Meeting(conf, "Why?", post, PRICES, root, board, log=lambda *_: None).run()
    return open(board).read(), calls


def seat(i, e="high"):
    return {"id": i, "label": i.upper(), "effort": e}


def test_meeting_happy_path():
    board, calls = run_meeting(
        [seat("cheap", "low"), seat("dear")],
        {"cheap": ["TOOL", "Agree with DEAR, it is the sync window."],
         "dear": ["MORE: need the sync log", "Then the small fix."]})
    assert "## Plans" in board and "1. plan by cheap" in board and "1. plan by dear" in board
    assert "### CHEAP · 1 step" in board                        # the grep counted as a step
    assert "### DEAR asks for more time — need the sync log" in board and "granted" in board
    assert "discussion ended: chair called it" in board
    assert "## Joint plan" in board and "### Still disputed" in board and "## Spend" in board
    assert ("cheap", "low", "You are one of several AI mode") in calls   # effort travels per seat


def test_meeting_everyone_passes_and_broken_seat():
    board, _ = run_meeting([seat("broken"), seat("cheap"), seat("dear")],
                           {"cheap": ["PASS"], "dear": ["PASS"]})
    assert "### BROKEN — did not answer" in board
    assert "discussion ended: everyone passed" in board and "## Joint plan" in board


def test_meeting_budget_and_anon():
    board, calls = run_meeting([seat("dear"), seat("dear"), seat("cheap")], {"cheap": ["y"]},
                               budget=1, anon=True)
    # $0.01 → seats of $0.0028: both dear plans ($0.01 each) empty their seats,
    # cheap (the chair) speaks once and empties its own → budget spent
    assert "### A passes · seat empty" in board and "### B passes · seat empty" in board
    assert "discussion ended: budget spent" in board and "from the reserve" in board
    assert "DEAR" not in board.split("## Who was who")[0]       # names hidden until the end
    assert "- A = DEAR · high" in board
```

- [ ] **Step 2: Run to verify they fail**

Run: `python3 multi-model/ccx-council-selftest.py`
Expected: `AttributeError: module 'council' has no attribute 'Meeting'`

- [ ] **Step 3: Implement** — append to `multi-model/ccx-council.py`:

```python
# ---- prompts ---------------------------------------------------------------

PLAN_SYSTEM = (
    "You are one of several AI models at a planning meeting. Write your own complete plan for "
    "the question. You have not seen anyone else's plan. You may use the look-up tools to read "
    "the project folder (at most {steps} look-ups). Be concrete. Do not say which model you are. "
    "End with a numbered plan.")
TURN_SYSTEM = (
    "You are {me}, a participant in a planning meeting. The shared board holds everyone's first "
    "plans and the discussion so far. This is a discussion turn, not a new plan. Reply with "
    "exactly one of:\n"
    "- PASS — you have nothing important to add.\n"
    "- a short message (at most {words} words) about specific points: agree, object, ask, or "
    "propose a change. Refer to others by their label.\n"
    "- MORE: <reason> — you need more look-up steps than your {steps} before you can answer; "
    "the chair decides.\n"
    "You may use the look-up tools before answering. Do not say which model you are.")
CHAIR_SYSTEM = (
    "You chair this planning meeting. A round just ended; decide whether the discussion should "
    "go on. Answer STOP or CONTINUE, then one short line why. Stop when more talk will not "
    "settle what is still open.")
GRANT_SYSTEM = (
    "You chair this planning meeting. A participant asks for more look-up time. Answer GRANT or "
    "DENY, then a few words why. Grant only when the look-up could change the plan.")
JOINT_SYSTEM = (
    "You chair this planning meeting and the discussion is over. Write the joint plan the table "
    "agreed on: a numbered plan first, then a section '### Still disputed' listing each open "
    "disagreement and who holds which side, by label. Add nothing nobody raised.")


class Turn:
    """One conversation with one model. Each tool round-trip is one step."""

    def __init__(self, post, seat, system, user, steps, root, price, tools=True):
        self.post, self.seat, self.system, self.root, self.price = post, seat, system, root, price
        self.tools = TOOLS if tools else None
        self.msgs = [{"role": "user", "content": user}]
        self.allowance, self.used, self.cost = steps, 0, 0.0

    def run(self):
        while True:
            r = self.post(self.seat["id"], self.seat["effort"], self.system, self.msgs, tools=self.tools)
            self.cost += core.call_cost(self.price, r.get("usage", {}))
            content = r.get("content", [])
            calls = [b for b in content if b.get("type") == "tool_use"]
            text = "".join(b.get("text", "") for b in content if b.get("type") == "text").strip()
            if not calls:
                return text
            if self.used >= self.allowance:
                return "PASS"               # told to stop looking and still looked
            self.msgs.append({"role": "assistant", "content": content})
            results = []
            for c in calls:
                self.used += 1
                results.append({"type": "tool_result", "tool_use_id": c["id"],
                                "content": run_tool(self.root, c["name"], c.get("input", {}))})
            if self.used >= self.allowance:
                results.append({"type": "text", "text": "Your look-up steps are used up. "
                                                        "Answer now, in text, without tools."})
            self.msgs.append({"role": "user", "content": results})

    def extend(self, last_text, steps):
        note = (f"Granted: {steps} more look-up steps. Use them, then answer." if steps
                else "Denied. Answer now with what you have, in text, without tools.")
        self.allowance = self.allowance + steps if steps else self.used
        self.msgs += [{"role": "assistant", "content": last_text or "MORE"},
                      {"role": "user", "content": note}]


class Meeting:
    def __init__(self, cfg, question, post, prices, root, board_file, log=print):
        self.cfg, self.question, self.post, self.root = cfg, question, post, root
        self.board_file, self.log = board_file, log
        self.seats = cfg["seats"]                                  # chair last
        self.labels = core.seat_labels([s["label"] for s in self.seats], cfg["anon"])
        self.prices = [core.price_for(prices, s["id"]) for s in self.seats]
        self.chair = len(self.seats) - 1
        self.gone = set()                                          # seats that did not answer
        self.ledger = core.Ledger(self.labels, cfg["budget"])

    # -- board --
    def write(self, text):
        os.makedirs(os.path.dirname(self.board_file), exist_ok=True)
        with open(self.board_file, "a") as f:
            f.write(text)
        first = text.strip().splitlines()[0] if text.strip() else ""
        if first:
            self.log(first[:110])

    def board(self):
        with open(self.board_file) as f:
            return f.read()

    def seat_note(self, i):
        lab, left = self.labels[i], self.ledger.left(self.labels[i])
        money = f" Your seat has {core.usd(left)} left of {core.usd(self.ledger.seat)}." if left is not None else ""
        return f"You are {lab}.{money} You may take up to {self.cfg['steps']} look-up steps this turn."

    # -- calls --
    def attempt(self, i, system, user, steps, tools=True):
        """(turn, text) or None when the seat failed twice."""
        err = None
        for _ in range(2):
            turn = Turn(self.post, self.seats[i], system, user, steps, self.root, self.prices[i], tools)
            try:
                return turn, turn.run()
            except CallError as e:
                err = e
        self.log(f"{self.labels[i]} did not answer: {err}")
        return None

    def handover(self):
        """Chair failed: the next seat that still answers takes the chair."""
        old = self.chair
        self.gone.add(old)
        live = [i for i in range(len(self.seats)) if i not in self.gone]
        if not live:
            return False
        self.chair = live[-1]
        self.write(f"\n_chair {self.labels[old]} did not answer; {self.labels[self.chair]} takes the chair_\n")
        return True

    def chair_call(self, system, user):
        while True:
            res = self.attempt(self.chair, system, user, 0, tools=False)
            if res:
                self.ledger.charge(self.labels[self.chair], res[0].cost)
                return res
            if not self.handover():
                return None

    # -- stages --
    def run(self):
        self.write(core.board_header(self.question, self.seats, self.labels, self.cfg, self.ledger))
        self.plans()
        self.discuss()
        self.joint()
        self.write(core.spend_block(self.ledger, self.labels[self.chair]))

    def stopped(self):
        self.write("\n## Stopped by owner\n")
        self.write(core.spend_block(self.ledger, self.labels[self.chair]))

    def plans(self):
        self.write("\n## Plans\n\n_written in parallel, nobody saw the others_\n")
        system = PLAN_SYSTEM.format(steps=self.cfg["steps"])
        user = f"Question: {self.question}\n\nProject folder: {self.root}"
        with ThreadPoolExecutor(len(self.seats)) as ex:
            results = list(ex.map(lambda i: self.attempt(i, system, user, self.cfg["steps"]),
                                  range(len(self.seats))))
        for i, res in enumerate(results):
            lab = self.labels[i]
            if res is None:
                self.gone.add(i)
                self.write(f"\n### {lab} — did not answer (error)\n")
                continue
            turn, text = res
            self.ledger.charge(lab, turn.cost)
            self.write(f"\n### {lab}{core.tag(turn.cost, turn.used, self.ledger.left(lab))}\n\n{text}\n")
        if self.chair in self.gone:
            self.gone.discard(self.chair)
            self.handover()

    def discuss(self):
        self.write("\n## Discussion\n")
        rounds = self.cfg["rounds"]
        for r in range(1, rounds + 1):
            self.write(f"\n— round {r} —\n")
            passed = True
            for i in range(len(self.seats)):
                if i in self.gone or self.ledger.all_empty():
                    continue
                passed = not self.turn(i) and passed
            chair_stop = False
            if not (passed or self.ledger.all_empty() or r >= rounds):
                res = self.chair_call(CHAIR_SYSTEM, self.board())
                if res:
                    turn, text = res
                    chair_stop, why = core.parse_chair(text)
                    lab = self.labels[self.chair]
                    self.write(f"\n**chair {lab}:** {'stop' if chair_stop else 'continue'} — {why}"
                               f"{core.tag(turn.cost, None, self.ledger.left(lab))}\n")
            why = core.stop_reason(r, rounds, passed, chair_stop, self.ledger.all_empty())
            if why:
                self.write(f"\n_discussion ended: {why}_\n")
                return

    def turn(self, i):
        """One discussion turn. True when the seat said something."""
        lab = self.labels[i]
        if self.ledger.empty(lab):
            self.write(f"\n### {lab} passes · seat empty\n")
            return False
        system = TURN_SYSTEM.format(me=lab, words=core.WORD_CAP, steps=self.cfg["steps"])
        res = self.attempt(i, system, self.board() + "\n\n" + self.seat_note(i), self.cfg["steps"])
        if res is None:
            self.write(f"\n### {lab} — did not answer (error)\n")
            return False
        turn, text = res
        kind, body, trimmed = core.parse_turn(text)
        if kind == "more":
            self.write(f"\n### {lab} asks for more time — {body}\n")
            left = self.ledger.left(lab)
            per_step = turn.cost / (turn.used + 1)
            affordable = left is None or left - turn.cost > per_step * self.cfg["steps"]
            granted = False
            if affordable:
                res = self.chair_call(GRANT_SYSTEM, self.board() + f"\n\n{lab} asks for more look-up time: {body}")
                granted = bool(res) and core.parse_grant(res[1])
            chair = self.labels[self.chair]
            self.write(f"**chair {chair}:** {'granted' if granted else 'denied'}"
                       f"{'' if affordable else ' — seat cannot afford it'}\n")
            turn.extend(text, self.cfg["steps"] if granted else 0)
            try:
                kind, body, trimmed = core.parse_turn(turn.run())
            except CallError:
                kind = "pass"
            if kind == "more":                                     # only one extension a round
                kind = "pass"
        self.ledger.charge(lab, turn.cost)
        tag = core.tag(turn.cost, turn.used, self.ledger.left(lab))
        if kind == "pass":
            self.write(f"\n### {lab} passes{tag}\n")
            return False
        self.write(f"\n### {lab}{tag}{' (trimmed)' if trimmed else ''}\n\n{body}\n")
        return True

    def joint(self):
        reserve = self.ledger.cap is not None
        while True:
            res = self.attempt(self.chair, JOINT_SYSTEM, self.board(), 0, tools=False)
            if res or not self.handover():
                break
        if not res:
            self.write("\n_no one could write the joint plan_\n")
            return
        turn, text = res
        self.ledger.charge(self.labels[self.chair], turn.cost, reserve=reserve)
        self.write(f"\n## Joint plan{core.tag(turn.cost)}{' from the reserve' if reserve else ''}\n\n{text}\n")
        if self.cfg["anon"]:
            self.write("\n## Who was who\n\n" + "\n".join(
                f"- {lab} = {s['label']} · {s['effort']}" for lab, s in zip(self.labels, self.seats)) + "\n")
```

- [ ] **Step 4: Run to verify it passes**

Run: `python3 multi-model/ccx-council-selftest.py`
Expected: all `ok`. If `test_meeting_happy_path` fails on the effort tuple, check `calls` — `system[:30]` of `PLAN_SYSTEM` is `"You are one of several AI mode"`.

- [ ] **Step 5: Commit**

```bash
git add multi-model/ccx-council.py multi-model/ccx-council-selftest.py
git commit -m "feat(council): turns with capped look-ups, MORE, chair, joint plan"
```

---

### Task 8: `main()`, `ccx council`, install, README, live run

**Files:**
- Modify: `multi-model/ccx-council.py` (append `main`)
- Modify: `multi-model/ccx` (arg parsing + case)
- Modify: `multi-model/install.sh:100` (`RUNTIME`)
- Modify: `multi-model/README.md` (new section)

**Interfaces:**
- Consumes: everything above.

- [ ] **Step 1: Append `main()`** to `multi-model/ccx-council.py`:

```python
# ---- entry -----------------------------------------------------------------

STATE = os.environ.get("CCX_COUNCIL_STATE", os.path.expanduser("~/.claude/addons/council.json"))


def load_models(base, key):
    """The /model list from ccx-models.py, minus hybrid plan→execute rows."""
    req = urllib.request.Request(base + "/v1/models?limit=1000",
                                 headers={"x-api-key": key, "anthropic-version": "2023-06-01"})
    raw = urllib.request.urlopen(req, timeout=10).read()
    out = subprocess.run([sys.executable, os.path.join(HERE, "ccx-models.py"), "picker"],
                         input=raw, capture_output=True, check=True).stdout
    return [{"id": re.sub(r"\[.*\]$", "", o["model"]), "label": o["label"]}
            for o in json.loads(out)["options"] if "plan" not in o["model"]]


def open_board(path):
    opener = ["code", path] if shutil.which("code") else ["open", path]
    subprocess.Popen(opener, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def main():
    ap = argparse.ArgumentParser(prog="ccx council", description="Several models plan together on one board.")
    ap.add_argument("question", nargs="+")
    ap.add_argument("--base", default="http://127.0.0.1:8317")
    ap.add_argument("--key-file", default=os.path.expanduser("~/.cli-proxy-api/local-key"))
    ap.add_argument("--no-open", action="store_true", help="do not open the board in the editor")
    a = ap.parse_args()
    question = " ".join(a.question)
    with open(a.key_file) as f:
        key = f.read().strip()
    locale.setlocale(locale.LC_ALL, "")
    prices = core.load_prices(os.path.join(HERE, "ccx-council-prices.json"))
    wizard = Wizard(load_models(a.base, key), load_state(STATE))
    price_of = lambda mid: core.price_for(prices, mid)
    estimate = lambda w: core.worst_case(
        [(price_of(s["id"]), core.EFFORTS.index(s["effort"])) for s in w.config()["seats"]], w.rounds, w.steps)
    if run_wizard(wizard, question, price_of, estimate) != "start":
        return 1
    save_state(STATE, wizard.saved())
    root = os.getcwd()
    board = os.path.join(root, core.board_path(datetime.datetime.now(), question))
    meeting = Meeting(wizard.config(), question, make_post(a.base, key), prices, root, board,
                      log=lambda line: print("  " + line, file=sys.stderr))
    print(f"board: {os.path.relpath(board)}", file=sys.stderr)
    try:
        meeting.write("")                       # create the file so the editor can open it
        if not a.no_open:
            open_board(board)
        meeting.run()
    except KeyboardInterrupt:
        meeting.stopped()
        return 130
    print(f"done · {core.usd(meeting.ledger.total())} list price · {os.path.relpath(board)}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
```

`meeting.write("")` must create the file: change the first line of `Meeting.write` to keep working with empty text — it already opens the file in append mode before checking `text`, so an empty write creates it.

- [ ] **Step 2: Wire `ccx council`** in `multi-model/ccx`. In the `while` argument loop, before the `-*)` case, add:

```bash
    council)   CMD=council; shift; COUNCIL_ARGS=("$@"); break ;;
```

and in the `case "$CMD" in` block, next to `agents)`, add:

```bash
  council)
    require_key || exit 1; ensure_proxy || exit 1
    exec python3 "$SCRIPT_DIR/ccx-council.py" --base "http://127.0.0.1:$PORT" --key-file "$KEY_FILE" "${COUNCIL_ARGS[@]}" ;;
```

and one line in `usage()` under the other commands:

```
  ccx council "<question>"   several models plan together on one board
```

- [ ] **Step 3: Install list** — in `multi-model/install.sh` line 100 append to `RUNTIME`:

```bash
ccx-council.py ccx_council_core.py ccx_council_wizard.py ccx-council-prices.json ccx-council-selftest.py
```

(`*.py` already gets mode 755 in the loop below; the two importable modules only need to be readable, 755 is harmless.)

- [ ] **Step 4: README section** — add to `multi-model/README.md` after the "סוכני משנה של ספקים אחרים" section:

````markdown
---

## מועצה: כמה מודלים מתכננים יחד

```bash
ccx council "איך לתקן את ההנחה של הרגע האחרון?"
```

נפתח אשף בשלושה שלבים: יושב ראש, מי עוד יושב ליד השולחן (ורמת המאמץ של כל אחד),
וחוקי הישיבה — סבבים, שמות או אנונימי, תקציב לפי מחירון, וצעדי בדיקה לתור.
הלוח נכתב לתיקייה `council/` בתיקייה הנוכחית ונפתח בעורך תוך כדי.
המחיר הוא "לפי מחירון" בלבד — הכול רץ על המנויים.
````

- [ ] **Step 5: Run all self-tests and a syntax check**

Run:
```bash
python3 multi-model/ccx-council-selftest.py && bash -n multi-model/ccx && echo SHELL-OK
```
Expected: `all passed` then `SHELL-OK`.

- [ ] **Step 6: Install into this Mac and live run** (cheap: two cheap models, low effort, 2 rounds, $0.20 budget, anonymous on)

```bash
./multi-model/install.sh --yes --skip-login
mkdir -p /tmp/council-try && cd /tmp/council-try && printf 'sync runs twice a week\n' > notes.txt
ccx council "Should the price sync run daily instead of twice a week? Look at notes.txt."
```

In the wizard: pick Gemini 3.7 Flash as chair at `low`, seat Grok 4.6 at `low`, settings rounds `2`, names `anonymous`, budget `$0.20` via space → `0` `right` `2` `0`. Expected: the board opens in the editor and fills: two plans, round lines with costs and `left`, discussion end line, joint plan with `### Still disputed`, `## Who was who`, `## Spend` with total ≤ about `$0.20`. Terminal ends with `done · $… list price · council/…md`. Any model returning `429` shows as "did not answer" and the meeting still finishes.

- [ ] **Step 7: Commit**

```bash
git add multi-model/ccx multi-model/ccx-council.py multi-model/install.sh multi-model/README.md
git commit -m "feat(council): ccx council command, install and docs"
```

---

## Self-review notes

- Spec coverage: wizard 3 steps + effort in step 1 (T4/T5) · models from picker minus hybrids (T8) · chair any model, writes a plan (T7) · anonymous labels + Who was who (T2/T7) · rounds / steps / budget presets + dials (T4) · remembered choices (T4/T8) · parallel private plans (T7) · PASS / message / MORE, 150-word trim (T2/T7) · chair continue/stop each round (T7) · stop rules incl. budget (T2/T7) · joint plan + Still disputed + reserve (T7) · board path, live open, header/footer (T2/T8) · price table from official pages, unknown = dearest (T1/T3) · seats, reserve, worst-case estimate (T1/T2/T5) · look-ups confined + 20 KB (T6) · errors: retry once, did-not-answer, chair handover, Ctrl-C (T7/T8) · tests with fake proxy (T7).
- `Meeting.write("")` creates the file because the append-open happens before the empty check.
- Prices are the only step that needs the network at build time (T3).
````
