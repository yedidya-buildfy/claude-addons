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
import shlex
import shutil
import subprocess
import sys
import time
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


def _under(p, top):
    return p == top or p.startswith(top + os.sep)


def _inside(root, path, hide=()):
    """Resolve a look-up path. Refused outside the project folder, and inside
    any council folder — a seat must not read the other seats' plans."""
    real_root = os.path.realpath(root)
    p = os.path.realpath(os.path.join(real_root, path or "."))
    if not _under(p, real_root):
        raise ValueError("outside the project folder")
    if any(_under(p, os.path.realpath(h)) for h in (os.path.join(real_root, "council"), *hide)):
        raise ValueError("the council folder is off limits")
    return p


def _grep(root, pattern, path, hide=()):
    rx, hits, size = re.compile(pattern), [], 0
    hidden = {os.path.realpath(h) for h in hide}
    for d, dirs, files in os.walk(_inside(root, path, hide)):
        dirs[:] = sorted(x for x in dirs if x not in SKIP_DIRS and os.path.realpath(os.path.join(d, x)) not in hidden)
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


def run_tool(root, name, args, hide=()):
    try:
        if name == "read_file":
            with open(_inside(root, args["path"], hide), encoding="utf-8", errors="replace") as f:
                out = f.read(LIMIT + 1)
        elif name == "list_dir":
            p = _inside(root, args.get("path"), hide)
            out = "\n".join(e + ("/" if os.path.isdir(os.path.join(p, e)) else "") for e in sorted(os.listdir(p)))
        elif name == "grep":
            out = _grep(root, args["pattern"], args.get("path"), hide)
        else:
            return f"unknown tool {name}"
    except (OSError, ValueError, KeyError, re.error) as e:
        return f"error: {e}"
    return out[:LIMIT] + "\n[cut at 20 KB]" if len(out) > LIMIT else out


# ---- prompts ---------------------------------------------------------------

PLAN_SYSTEM = (
    "You are one of several AI models at a planning meeting. Write your own complete plan for "
    "the question, fully on your own: nobody else's plan exists for you yet. You may use the "
    "look-up tools to read the project folder (at most {steps} look-ups). Be concrete. Do not say "
    "which model you are. End with a numbered plan.")
WHY = ("If you change your mind or agree with someone else's point, start one sentence with "
       "'Convinced by <label>:' and say why (e.g. 'Convinced by B: the cache is per-user, so my "
       "global lock is wrong').")
SOURCE = ("Ground every objection that matters: end it with a line 'Source: <file or document "
          "section>' — e.g. 'Source: PRD.md §4' or 'Source: src/lib/calc.ts:42' — naming only what "
          "you actually read. If nothing backs it, write 'Source: none (opinion)'.")
TURN_SYSTEM = (
    "You are {me}, a participant in a planning meeting. The shared board holds everyone's first "
    "plans and the discussion so far. This is a discussion turn, not a new plan. Reply with "
    "exactly one of:\n"
    "- PASS — you have nothing important to add.\n"
    "- a short message (at most {words} words) about specific points: agree, object, ask, or "
    "propose a change. Refer to others by their label.\n"
    "- MORE: <reason> — you need more look-up steps than your {steps} before you can answer; "
    "the chair decides.\n"
    + WHY + "\n" + SOURCE + "\nYou may use the look-up tools before answering. Do not say which model you are.")
FIRST_SYSTEM = (
    "You are {me}, a participant in a planning meeting. The shared board holds everyone's first "
    "plans, written independently. This is your first discussion turn: react to the OTHER plans, "
    "by label — what is better than yours, what is wrong or missing, what you would take over. "
    "At most {words} words, no new full plan, no PASS. Or reply MORE: <reason> if you need more "
    "look-up steps than your {steps}; the chair decides.\n"
    + WHY + "\n" + SOURCE + "\nYou may use the look-up tools before answering. Do not say which model you are.")
CRITIQUE_SYSTEM = (
    "You are {me}, a participant in a planning meeting. The table reached agreement and the "
    "chair's draft joint plan is at the end of the board. Before it is final, attack it: look "
    "for a problem, risk, gap or mistake in it. Reply NO ISSUES if you honestly find nothing "
    "that matters, or ISSUE: <what is wrong and why it matters> in at most {words} words, "
    "ending with a line 'Source: <file or document section>' — only what you actually read — "
    "or 'Source: none (opinion)'. You may use the look-up tools first. Do not say which model you are.")
CHAIR_SYSTEM = (
    "You chair this planning meeting. A round just ended; decide whether the discussion should "
    "go on. Answer STOP or CONTINUE, then one short line why. Stop when more talk will not "
    "settle what is still open.")
GRANT_SYSTEM = (
    "You chair this planning meeting. A participant asks for more look-up time. Answer GRANT or "
    "DENY, then a few words why. Grant only when the look-up could change the plan.")
DRAFT_SYSTEM = (
    "You chair this planning meeting and the table has reached agreement. Write the draft joint "
    "plan: a numbered plan first, then a section '### Still disputed' listing each open "
    "disagreement and who holds which side, by label (or 'none'). Add nothing nobody raised. "
    "Everyone will now check it for problems before it is final.")
REVIEW_SYSTEM = (
    "You chair this planning meeting. The table checked your draft joint plan for problems; "
    "their findings are at the end of the board, each tagged by whether its source was found in "
    "the project ('source ✓'), named but missing ('source not found') or absent ('no source'). "
    "A checked source is evidence; the rest is opinion, which is significant only when the "
    "reasoning is self-evident. If any finding is a significant problem that "
    "needs discussion, answer CONTINUE: <the problem, one line>. Otherwise answer FINISH, then "
    "the final joint plan — the draft amended for the minor findings, same format "
    "(numbered plan, then '### Still disputed').")
LAST_REVIEW_SYSTEM = (
    "You chair this planning meeting. The table checked your draft joint plan for problems; "
    "their findings are at the end of the board. There is no time left for more discussion. "
    "Answer FINISH, then the final joint plan — the draft amended where a finding is clearly "
    "right, and every significant unresolved finding listed under '### Still disputed' "
    "with who raised it, by label.")
JUDGE_NOTE = ("\nYou are an independent chair: you wrote no plan and hold no position. Judge only "
              "on the arguments and their sources, never on who made them.")
JOINT_SYSTEM = (
    "You chair this planning meeting and the discussion is over. Write the joint plan the table "
    "agreed on: a numbered plan first, then a section '### Still disputed' listing each open "
    "disagreement and who holds which side, by label. Add nothing nobody raised.")


class Turn:
    """One conversation with one model. Each tool round-trip is one step."""

    def __init__(self, post, seat, system, user, steps, root, price, tools=True, hide=()):
        self.post, self.seat, self.system, self.root, self.price = post, seat, system, root, price
        self.hide = hide
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
                                "content": run_tool(self.root, c["name"], c.get("input", {}), self.hide)})
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
    """One run lives in one folder: board.md (the shared board), plans/<letter>.md
    (each first plan, written blind), final.md (the joint plan)."""

    CONSENSUS = ("chair called it", "everyone passed")

    def __init__(self, cfg, question, post, prices, root, board_file, log=print):
        self.cfg, self.question, self.post, self.root = cfg, question, post, root
        self.board_file, self.log = board_file, log
        self.run_dir = os.path.dirname(board_file)
        judge = cfg.get("judge")                                   # independent chair: no plan, no turns
        self.members = list(range(len(cfg["seats"])))              # the seats that plan and talk
        self.seats = cfg["seats"] + ([judge] if judge else [])     # chair last
        self.labels = core.seat_labels(len(cfg["seats"])) + (["Chair"] if judge else [])
        self.judge = len(self.seats) - 1 if judge else None
        self.prices = [core.price_for(prices, s["id"]) for s in self.seats]
        self.chair = len(self.seats) - 1
        self.gone = set()                                          # failed seats: out for the rest of the run
        self.round = 0
        self.changed = set()                                       # seats that said "Convinced by …"
        self.checks = []                                           # one outcome per final check
        self.grounding = [0, 0, 0]                                 # sources checked · not found · none
        self.ledger = core.Ledger(self.labels, cfg["budget"])

    # -- files --
    def write(self, text):
        os.makedirs(self.run_dir, exist_ok=True)
        with open(self.board_file, "a") as f:                      # also creates it for an empty write
            f.write(text)
        first = text.strip().splitlines()[0] if text.strip() else ""
        if first:
            self.log(first[:110])

    def save(self, rel, text):
        path = os.path.join(self.run_dir, rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w") as f:
            f.write(text)

    def board(self):
        with open(self.board_file) as f:
            return f.read()

    def who(self, i):
        return "" if self.cfg["anon"] else f" ({self.seats[i]['label']})"

    def live(self):
        return [i for i in self.members if i not in self.gone]

    def grade(self, text):
        """Check each 'Source:' against the project folder. Returns a short board
        tag: ' · source ✓', or ' · sources 2 ✓ 1 not found' when there are several."""
        got = {"✓": 0, "not found": 0, "none": 0}
        for src in core.sources(text):
            paths = core.source_paths(src)
            got["none" if not paths else "✓" if any(self.exists(p) for p in paths) else "not found"] += 1
        for n, k in enumerate(got):
            self.grounding[n] += got[k]
        if sum(got.values()) == 1:
            k = next(k for k, v in got.items() if v)
            return " · " + {"✓": "source ✓", "not found": "source not found", "none": "no source"}[k]
        return (" · sources " + " ".join(f"{v} {k}" for k, v in got.items() if v)) if any(got.values()) else ""

    def exists(self, path):
        try:
            return os.path.exists(_inside(self.root, path.split(":")[0], (self.run_dir,)))
        except ValueError:
            return False

    def seat_note(self, i):
        lab, left = self.labels[i], self.ledger.left(self.labels[i])
        money = f" Your seat has {core.usd(left)} left of {core.usd(self.ledger.seat)}." if left is not None else ""
        return f"You are {lab}.{money} You may take up to {self.cfg['steps']} look-up steps this turn."

    # -- calls --
    def attempt(self, i, system, user, steps, tools=True):
        """(turn, text), or None when the seat failed. No retry, no stand-in model:
        a failed seat is marked failed and the rest of the table goes on."""
        turn = Turn(self.post, self.seats[i], system, user, steps, self.root, self.prices[i], tools,
                    hide=(self.run_dir,))
        try:
            return turn, turn.run()
        except CallError as e:
            self.fail(i, e)
            return None

    def fail(self, i, err):
        self.gone.add(i)
        self.log(f"{self.labels[i]} failed: {err}")

    def handover(self):
        """The chair failed: the chair's job (not its seat) moves to the last seat still in."""
        old = self.chair
        live = self.live()
        if not live:
            return False
        self.chair = live[-1]
        self.write(f"\n_chair {self.labels[old]} failed; {self.labels[self.chair]} takes the chair_\n")
        return True

    def chair_call(self, system, user, reserve=False):
        if self.chair in self.gone and not self.handover():
            return None
        while True:
            note = JUDGE_NOTE if self.chair == self.judge else ""
            res = self.attempt(self.chair, system + note, user, 0, tools=False)
            if res:
                self.ledger.charge(self.labels[self.chair], res[0].cost, reserve=reserve)
                return res
            if not self.handover():
                return None

    # -- stages --
    def run(self):
        self.write(core.board_header(self.question, self.seats, self.labels, self.cfg, self.ledger))
        self.plans()
        final = None
        if len(self.live()) < 1:
            self.write("\n_every seat failed; no discussion_\n")
        else:
            self.write("\n## Discussion\n")
            while final is None:
                why = self.discuss()
                self.write(f"\n_discussion ended: {why}_\n")
                if not self.live():
                    break
                if why not in self.CONSENSUS:
                    final = self.joint(JOINT_SYSTEM)                  # no rounds/budget left: no final check
                    break
                draft = self.joint(DRAFT_SYSTEM, "Draft joint plan")
                if draft is None:
                    break
                final = self.final_check(draft)                    # None = a real problem, talk on
        self.finish(final)
        self.write(core.spend_block(self.ledger, self.labels[self.chair]) + self.health())

    def stopped(self):
        self.write("\n## Stopped by owner\n")
        self.write(core.spend_block(self.ledger, self.labels[self.chair]) + self.health())

    def plans(self):
        """Every seat plans blind, in parallel; the discussion waits for all of them."""
        self.write("\n## Plans\n\n_written in parallel, nobody saw the others · each also in plans/_\n")
        system = PLAN_SYSTEM.format(steps=self.cfg["steps"])
        user = f"Question: {self.question}\n\nProject folder: {self.root}"

        def one(i):
            res = self.attempt(i, system, user, self.cfg["steps"])
            lab = self.labels[i]
            body = res[1] if res else "_failed — no plan_"
            self.save(f"plans/{lab}.md", f"# {lab}{self.who(i)} — plan\n\n{self.question}\n\n{body}\n")
            return res

        with ThreadPoolExecutor(len(self.members)) as ex:
            results = list(ex.map(one, self.members))
        for i, res in enumerate(results):
            lab = self.labels[i]
            if res is None:
                self.write(f"\n### {lab}{self.who(i)} — failed\n")
                continue
            turn, text = res
            self.ledger.charge(lab, turn.cost)
            self.write(f"\n### {lab}{self.who(i)}{core.tag(turn.cost, turn.used, self.ledger.left(lab))}"
                       f"\n\n{text}\n")
        if self.chair in self.gone:
            self.handover()

    def discuss(self):
        """Rounds from where the last one stopped, until a stop reason."""
        rounds = self.cfg["rounds"]
        while self.round < rounds:
            self.round += 1
            r = self.round
            self.write(f"\n— round {r} —\n")
            passed = True
            for i in self.members:
                if i in self.gone or self.ledger.all_empty():
                    continue
                passed = not self.turn(i, first=r == 1) and passed
            chair_stop = False
            if not (passed or self.ledger.all_empty() or r >= rounds):
                res = self.chair_call(CHAIR_SYSTEM, self.board())
                if res:
                    turn, text = res
                    chair_stop, why = core.parse_chair(text)
                    lab = self.labels[self.chair]
                    self.write(f"\n**chair {lab}:** {'stop' if chair_stop else 'continue'} — {why}"
                               f"{core.tag(turn.cost, None, self.ledger.left(lab))}\n")
            if not self.live():
                return "every seat failed"
            why = core.stop_reason(r, rounds, passed, chair_stop, self.ledger.all_empty())
            if why:
                return why
        return "max rounds"

    def turn(self, i, first=False):
        """One discussion turn. True when the seat said something."""
        lab = self.labels[i]
        if self.ledger.empty(lab):
            self.write(f"\n### {lab} passes · seat empty\n")
            return False
        cap = core.FIRST_CAP if first else core.WORD_CAP
        system = (FIRST_SYSTEM if first else TURN_SYSTEM).format(me=lab, words=cap, steps=self.cfg["steps"])
        res = self.attempt(i, system, self.board() + "\n\n" + self.seat_note(i), self.cfg["steps"])
        if res is None:
            self.write(f"\n### {lab} — failed\n")
            return False
        turn, text = res
        kind, body, trimmed = core.parse_turn(text, cap)
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
                kind, body, trimmed = core.parse_turn(turn.run(), cap)
            except CallError:
                kind = "pass"
            if kind == "more":                                     # only one extension a round
                kind = "pass"
        self.ledger.charge(lab, turn.cost)
        tag = core.tag(turn.cost, turn.used, self.ledger.left(lab))
        if kind == "pass":
            self.write(f"\n### {lab} passes{tag}\n")
            return False
        if core.changed_mind(body):
            self.changed.add(i)
        self.write(f"\n### {lab}{tag}{self.grade(body)}{' (trimmed)' if trimmed else ''}\n\n{body}\n")
        return True

    def joint(self, system, title=None):
        """The chair writes the (draft) joint plan, paid from the reserve.
        With a title it goes on the board now; the final one goes on in finish()."""
        res = self.chair_call(system, self.board(), reserve=self.ledger.cap is not None)
        if not res:
            self.write("\n_no one could write the joint plan_\n")
            return None
        turn, text = res
        if title:
            self.write(f"\n## {title} · by {self.labels[self.chair]}{core.tag(turn.cost)}\n\n{text}\n")
        return text

    def final_check(self, draft):
        """Agreement is not the end: every seat hunts for a flaw in the draft.
        Returns the final plan, or None when the chair reopens the discussion."""
        self.write("\n## Final check\n\n_every seat looks for a problem, risk, gap or mistake in the draft_\n")
        system = CRITIQUE_SYSTEM
        issues = 0
        for i in self.live():
            lab = self.labels[i]
            if self.ledger.empty(lab):
                continue
            res = self.attempt(i, system.format(me=lab, words=core.WORD_CAP),
                               self.board() + "\n\n" + self.seat_note(i), self.cfg["steps"])
            if res is None:
                self.write(f"\n### {lab} — failed\n")
                continue
            turn, text = res
            self.ledger.charge(lab, turn.cost)
            kind, body = core.parse_critique(text)
            issues += kind == "issue"
            tag = core.tag(turn.cost, turn.used, self.ledger.left(lab))
            if kind == "ok":
                self.write(f"\n### {lab} · no issues{tag}\n")
            else:
                self.write(f"\n### {lab} · issue{self.grade(body) or ' · no source'}{tag}\n\n{body}\n")
                self.grounding[2] += not core.sources(body)
        n = f"{issues} issue{'' if issues == 1 else 's'}"
        if not issues:
            self.write("\n_no issues found — the draft stands_\n")
            self.checks.append("no issues")
            return draft
        more = self.round < self.cfg["rounds"] and not self.ledger.all_empty()
        res = self.chair_call(REVIEW_SYSTEM if more else LAST_REVIEW_SYSTEM, self.board(),
                              reserve=self.ledger.cap is not None)
        if not res:
            self.checks.append(f"{n}, draft kept (chair failed)")
            return draft
        turn, text = res
        reopen, body = core.parse_review(text)
        lab = self.labels[self.chair]
        if reopen and more:
            self.write(f"\n**chair {lab}:** back to the table — {body}{core.tag(turn.cost)}\n")
            self.checks.append(f"{n} → back to discussion")
            return None
        self.write(f"\n**chair {lab}:** finish{core.tag(turn.cost)}\n")
        amended = bool(body) and not reopen
        self.checks.append(f"{n} {'fixed' if amended else 'noted, draft kept'}")
        return body if amended else draft

    def health(self):
        if self.judge is None:
            chair = ""
        elif self.judge in self.gone:
            chair = f"independent chair failed → {self.labels[self.chair]}"
        else:
            chair = "independent chair"
        failed = len(self.gone & set(self.members))
        return core.health(len(self.members), len(self.members) - failed, failed, len(self.changed),
                           self.round, self.checks, chair, self.grounding)

    def finish(self, final):
        if final:
            self.write(f"\n## Joint plan\n\n{final}\n")
        who = "\n".join(f"- {lab} = {s['label']} · {s['effort']}"
                        f"{' · independent chair' if i == self.judge else ''}{' · failed' if i in self.gone else ''}"
                        for i, (lab, s) in enumerate(zip(self.labels, self.seats)))
        if self.cfg["anon"]:
            self.write("\n## Who was who\n\n" + who + "\n")
        self.save("final.md", f"# Council — {self.question}\n\n"
                  + (final or "_no joint plan — see board.md_") + "\n\n## Seats\n\n" + who + "\n"
                  + self.health())


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


SPLIT_REQUESTS = os.path.expanduser("~/.claude/terminal-state/split-requests")
AUTOSTART_SKIP = os.path.expanduser("~/.claude/terminal-state/autostart-skip-once")


def split(question, board, requests=SPLIT_REQUESTS, run=subprocess.run, wait=3.0, extra=()):
    """Open the wizard in a pane next to the calling session; it needs a real
    keyboard, which a command run by Claude never has. tmux if we are inside it,
    else ask the VS Code extension (it splits the terminal that owns our process),
    else a plain Terminal window. Returns where it opened."""
    cmd = shlex.join(["ccx", "council", "--board", board, *extra, "--", question])
    cwd = os.getcwd()
    if os.environ.get("TMUX"):
        run(["tmux", "split-window", "-h", "-c", cwd, cmd + "; printf 'press Enter to close '; read _"], check=True)
        return "tmux"
    os.makedirs(requests, exist_ok=True)
    req = os.path.join(requests, f"{os.getpid()}.json")
    with open(req + ".tmp", "w") as f:
        json.dump({"pid": os.getpid(), "cwd": cwd, "command": cmd, "name": "council"}, f)
    os.replace(req + ".tmp", req)          # the watcher only ever sees a whole file
    end = time.time() + wait
    while time.time() < end:
        if not os.path.exists(req):
            return "vscode"
        time.sleep(0.1)
    try:
        os.remove(req)
    except FileNotFoundError:
        return "vscode"                    # claimed at the last moment
    script = "cd " + shlex.quote(cwd) + "; " + cmd
    # a new Terminal shell would auto-start Claude and swallow the command; auto-claude skips once on this file
    open(AUTOSTART_SKIP, "w").close()
    # the command travels as an argument, so quotes and Hebrew need no AppleScript escaping
    run(["osascript", "-e", "on run argv", "-e", 'tell application "Terminal" to do script (item 1 of argv)',
         "-e", 'tell application "Terminal" to activate', "-e", "end run", script], check=True)
    return "terminal"


def main(argv=None):
    ap = argparse.ArgumentParser(
        prog="ccx council", description="Several models plan together on one board.",
        epilog='example: ccx council --seat sonnet:high:2 --seat grok -- "how do we fix X?"')
    ap.add_argument("question", nargs="+")
    ap.add_argument("--base", default="http://127.0.0.1:8317")
    ap.add_argument("--key-file", default=os.path.expanduser("~/.cli-proxy-api/local-key"))
    ap.add_argument("--no-open", action="store_true", help="do not open the board in the editor")
    ap.add_argument("--board", help="board file to write; plans/ and final.md go next to it "
                                    "(default: ./council/<time>-<slug>/board.md)")
    ap.add_argument("--split", action="store_true",
                    help="open the wizard in a pane next to this session and print the board path")
    ap.add_argument("--seat", action="append", default=[], metavar="MODEL[:EFFORT][:COUNT]",
                    help="seat a model, repeatable; e.g. sonnet:high:2 = two independent Sonnet seats. "
                         "Skips the wizard.")
    ap.add_argument("--chair", metavar="MODEL", help="which seated model chairs (default: the last --seat)")
    ap.add_argument("--independent-chair", metavar="MODEL[:EFFORT]",
                    help="an extra seat that writes no plan and takes no side; it only runs the meeting "
                         "and judges which objections matter")
    ap.add_argument("--rounds", type=int, choices=range(1, 11), metavar="1-10")
    ap.add_argument("--steps", type=int, choices=range(1, 7), metavar="1-6", help="look-ups per turn")
    ap.add_argument("--budget", type=float, metavar="DOLLARS", help="list-price cap, 0 = unlimited")
    ap.add_argument("--anon", action=argparse.BooleanOptionalAction, default=None,
                    help="hide which model is which until the end")
    a = ap.parse_intermixed_args(argv)
    if len(a.question) > 1 and core.stray_tokens(a.question):
        ap.error(f"{', '.join(core.stray_tokens(a.question))} looks like a table setting, not part of "
                 "the question. Use --seat MODEL:EFFORT:COUNT, and quote the question.")
    question = " ".join(a.question)
    root = os.getcwd()
    board = os.path.abspath(a.board or os.path.join(root, core.board_path(datetime.datetime.now(), question)))
    rules = {k: v for k, v in (("rounds", a.rounds), ("steps", a.steps), ("anon", a.anon),
                               ("budget", None if a.budget is None else round(a.budget * 100)))
             if v is not None}
    if a.split:
        extra = [f"--seat={s}" for s in a.seat] + ([f"--chair={a.chair}"] if a.chair else [])
        extra += [f"--independent-chair={a.independent_chair}"] if a.independent_chair else []
        extra += [f"--{k}={v}" for k, v in (("rounds", a.rounds), ("steps", a.steps), ("budget", a.budget))
                  if v is not None]
        extra += [] if a.anon is None else ["--anon" if a.anon else "--no-anon"]
        print(f"opened in {split(question, board, extra=extra)} · board: {board}")
        return 0
    with open(a.key_file) as f:
        key = f.read().strip()
    locale.setlocale(locale.LC_ALL, "")
    prices = core.load_prices(os.path.join(HERE, "ccx-council-prices.json"))
    models, state = load_models(a.base, key), load_state(STATE)
    judge = None
    if a.independent_chair:
        if a.chair:
            ap.error("--chair and --independent-chair: pick one")
        try:
            judge = core.judge_from_spec(models, a.independent_chair, state.get("effort"))
        except ValueError as e:
            ap.error(str(e))
    if a.seat:
        try:
            seats = core.table_from_specs(models, a.seat, a.chair, state.get("effort"))
        except ValueError as e:
            ap.error(str(e))
        cfg = {"rounds": state.get("rounds", 5), "anon": state.get("anon", False),
               "budget": state.get("budget", 0), "steps": state.get("steps", 3)} | rules | {"seats": seats}
    else:
        wizard = Wizard(models, state | rules)
        price_of = lambda mid: core.price_for(prices, mid)
        estimate = lambda w: core.worst_case(
            [(price_of(s["id"]), core.EFFORTS.index(s["effort"])) for s in w.config()["seats"]], w.rounds, w.steps)
        if run_wizard(wizard, question, price_of, estimate) != "start":
            if a.board:                             # whoever waits on this file learns it will not come
                os.makedirs(os.path.dirname(board), exist_ok=True)
                with open(board, "a") as f:
                    f.write(f"# Council — {question}\n\n## Cancelled\n\nThe wizard was closed before the meeting started.\n")
            return 1
        save_state(STATE, wizard.saved())
        cfg = wizard.config()
    cfg["judge"] = judge
    meeting = Meeting(cfg, question, make_post(a.base, key), prices, root, board,
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
    print(f"done · {core.usd(meeting.ledger.total())} list price · {os.path.relpath(os.path.dirname(board))}/",
          file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
