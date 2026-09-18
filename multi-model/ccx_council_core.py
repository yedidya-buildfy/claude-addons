"""Pure logic for `ccx council`: money, turns, stop rules, board text.

No network and no terminal here, so everything is testable from the self-test.
"""
import json
import re

EFFORTS = ["low", "medium", "high", "xhigh", "max"]
PRESETS_CENTS = [0, 50, 100, 200, 500, 1000]   # 0 = unlimited
RESERVE = 0.15      # share of a budget held back so the joint plan is always affordable
WORD_CAP = 150      # a discussion message, not a new plan
FIRST_CAP = 250     # round 1: a reaction to every other plan
MAX_SEATS = 26      # one letter each


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


# ---- turns ---------------------------------------------------------------

def _cap(t, cap):
    words = t.split()
    return (" ".join(words[:cap]) + " …", True) if len(words) > cap else (t, False)


def parse_turn(text, cap=WORD_CAP):
    """A discussion turn is PASS, MORE: <reason>, or a short message."""
    t = text.strip()
    if re.match(r"PASS\b", t, re.I):
        return ("pass", "", False)
    m = re.match(r"MORE\s*:\s*(.*)", t, re.I | re.S)
    if m:
        return ("more", m.group(1).strip(), False)
    return ("say", *_cap(t, cap))


def parse_critique(text):
    """Final check on the agreed plan: NO ISSUES, or ISSUE: <what>. Anything
    else counts as an issue, so a vague answer still reaches the chair."""
    t = text.strip()
    if re.match(r"NO ISSUES?\b", t, re.I):
        return ("ok", "")
    m = re.match(r"ISSUES?\s*:\s*(.*)", t, re.I | re.S)
    return ("issue", _cap(m.group(1).strip() if m else t, WORD_CAP)[0])


def parse_review(text):
    """Chair after the final check: (True, why) to reopen the discussion, or
    (False, final plan) to finish — an empty plan means keep the draft."""
    t = text.strip()
    m = re.match(r"CONTINUE\b\W*(.*)", t, re.I | re.S)
    if m:
        return (True, m.group(1).strip()[:200])
    return (False, re.sub(r"^FINISH\b\W*", "", t, flags=re.I).strip())


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

def seat_labels(n):
    """Every seat gets its own letter, so the same model can sit twice."""
    return [chr(65 + i) for i in range(n)]


def board_path(now, question):
    """One folder per run: board.md, plans/<letter>.md, final.md."""
    slug = "-".join(re.findall(r"[a-z0-9]+", question.lower())[:6]) or "council"
    return f"council/{now:%Y-%m-%d-%H%M}-{slug}/board.md"


def parse_seat(spec):
    """--seat MODEL[:EFFORT][:COUNT], e.g. sonnet:high:2 or grok:1 → (model, effort|None, count)."""
    model, *rest = spec.split(":")
    effort, count = None, 1
    for part in rest:
        if part.lower() in EFFORTS:
            effort = part.lower()
        elif part.isdigit() and 1 <= int(part) <= 9:
            count = int(part)
        else:
            raise ValueError(f"--seat {spec}: '{part}' is neither an effort ({'/'.join(EFFORTS)}) nor a count 1-9")
    if not model:
        raise ValueError(f"--seat {spec}: no model")
    return model, effort, count


def match_model(models, name):
    """Exact id, else the one model whose id or label contains the name."""
    exact = [m for m in models if m["id"] == name]
    if exact:
        return exact[0]
    hits = [m for m in models if name.lower() in (m["id"] + " " + m["label"]).lower()]
    if len(hits) == 1:
        return hits[0]
    why = "matches nothing" if not hits else "matches " + ", ".join(m["id"] for m in hits)
    raise ValueError(f"model '{name}' {why}")


def stray_tokens(words):
    """Loose words that look like table settings (a bare count, sonnet:2, x3)
    and would otherwise slip into the question."""
    rx = re.compile(r"^(\d+|[x×]\d+|\d+[x×]|[\w.-]+[:x×]\d+|[\w.-]+:(%s)(:\d+)?)$" % "|".join(EFFORTS), re.I)
    return [w for w in words if rx.match(w)]


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
        lines += [f"- {lab} = {s['label']} · {s['effort']}" for lab, s in zip(labels, seats)] + [""]
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


def table_from_specs(models, specs, chair=None, saved_effort=None):
    """--seat flags → seats in speaking order, chair last. Each spec is one model
    selection (model, effort, count); a count of 2 is two independent seats."""
    saved_effort = saved_effort or {}
    seats = []
    for spec in specs:
        name, effort, count = parse_seat(spec)
        m = match_model(models, name)
        effort = effort or EFFORTS[saved_effort.get(m["id"], 2)]
        seats += [{"id": m["id"], "label": m["label"], "effort": effort} for _ in range(count)]
    if len(seats) < 2:
        raise ValueError("a council needs at least 2 seats (e.g. --seat sonnet:2)")
    if len(seats) > MAX_SEATS:
        raise ValueError(f"at most {MAX_SEATS} seats")
    if chair:
        cid = match_model(models, chair)["id"]
        at = max((i for i, s in enumerate(seats) if s["id"] == cid), default=None)
        if at is None:
            raise ValueError(f"--chair {chair}: that model has no seat")
        seats.append(seats.pop(at))
    return seats
