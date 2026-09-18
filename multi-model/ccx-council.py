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
        with open(self.board_file, "a") as f:                      # also creates it for an empty write
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


def split(question, board, requests=SPLIT_REQUESTS, run=subprocess.run, wait=3.0):
    """Open the wizard in a pane next to the calling session; it needs a real
    keyboard, which a command run by Claude never has. tmux if we are inside it,
    else ask the VS Code extension (it splits the terminal that owns our process),
    else a plain Terminal window. Returns where it opened."""
    cmd = shlex.join(["ccx", "council", "--board", board, question])
    cwd = os.getcwd()
    if os.environ.get("TMUX"):
        run(["tmux", "split-window", "-h", "-c", cwd, cmd + "; exec $SHELL"], check=True)
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
    # the command travels as an argument, so quotes and Hebrew need no AppleScript escaping
    run(["osascript", "-e", "on run argv", "-e", 'tell application "Terminal" to do script (item 1 of argv)',
         "-e", 'tell application "Terminal" to activate', "-e", "end run", script], check=True)
    return "terminal"


def main():
    ap = argparse.ArgumentParser(prog="ccx council", description="Several models plan together on one board.")
    ap.add_argument("question", nargs="+")
    ap.add_argument("--base", default="http://127.0.0.1:8317")
    ap.add_argument("--key-file", default=os.path.expanduser("~/.cli-proxy-api/local-key"))
    ap.add_argument("--no-open", action="store_true", help="do not open the board in the editor")
    ap.add_argument("--board", help="board file to write (default: ./council/<time>-<slug>.md)")
    ap.add_argument("--split", action="store_true",
                    help="open the wizard in a pane next to this session and print the board path")
    a = ap.parse_args()
    question = " ".join(a.question)
    root = os.getcwd()
    board = os.path.abspath(a.board or os.path.join(root, core.board_path(datetime.datetime.now(), question)))
    if a.split:
        print(f"opened in {split(question, board)} · board: {board}")
        return 0
    with open(a.key_file) as f:
        key = f.read().strip()
    locale.setlocale(locale.LC_ALL, "")
    prices = core.load_prices(os.path.join(HERE, "ccx-council-prices.json"))
    wizard = Wizard(load_models(a.base, key), load_state(STATE))
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
