#!/usr/bin/env python3
"""Self-test for ccx council. No network, no real HOME.  ./ccx-council-selftest.py"""
import datetime
import importlib.util
import os
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.realpath(__file__))
sys.path.insert(0, HERE)
import ccx_council_core as core  # noqa: E402
from ccx_council_wizard import Wizard, load_state, render, save_state  # noqa: E402

spec = importlib.util.spec_from_file_location("council", os.path.join(HERE, "ccx-council.py"))
council = importlib.util.module_from_spec(spec)
spec.loader.exec_module(council)

PRICES = {"models": {
    "cheap": {"in": 1.0, "cached": 0.1, "out": 4.0},
    "dear": {"in": 5.0, "cached": 0.5, "out": 25.0},
}}


# ---- core ----------------------------------------------------------------

def test_price_and_cost():
    assert core.price_for(PRICES, "cheap")["unknown"] is False
    unknown = core.price_for(PRICES, "mystery")
    assert unknown["unknown"] is True and unknown["out"] == 25.0   # never looks free
    usage = {"input_tokens": 1000, "cache_creation_input_tokens": 1000,
             "cache_read_input_tokens": 10000, "output_tokens": 2000}
    # (2000*1 + 10000*0.1 + 2000*4) / 1e6
    assert abs(core.call_cost(PRICES["models"]["cheap"], usage) - 0.011) < 1e-12
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
    assert core.seat_labels(3) == ["A", "B", "C"]
    now = datetime.datetime(2026, 9, 18, 14, 30)
    assert core.board_path(now, "Why is the Last-minute discount missing?") == \
        "council/2026-09-18-1430-why-is-the-last-minute-discount/board.md"
    assert core.board_path(now, "למה ההנחה לא מגיעה?") == "council/2026-09-18-1430-council/board.md"


def test_seat_specs():
    assert core.parse_seat("sonnet:high:2") == ("sonnet", "high", 2)
    assert core.parse_seat("grok") == ("grok", None, 1)
    assert core.parse_seat("sonnet:3") == ("sonnet", None, 3)
    for bad in ("sonnet:loud", ":2", "sonnet:0"):
        try:
            core.parse_seat(bad)
            raise AssertionError(bad)
        except ValueError:
            pass
    models = [{"id": "claude-sonnet-5", "label": "Claude Sonnet 5"},
              {"id": "claude-grok-46", "label": "Grok 4.6"}, {"id": "claude-opus-5", "label": "Claude Opus 5"}]
    seats = core.table_from_specs(models, ["sonnet:low:2", "grok"], saved_effort={"claude-grok-46": 4})
    assert [(s["id"], s["effort"]) for s in seats] == [
        ("claude-sonnet-5", "low"), ("claude-sonnet-5", "low"), ("claude-grok-46", "max")]   # grok chairs
    seats = core.table_from_specs(models, ["sonnet:2", "grok"], chair="sonnet")
    assert [s["id"] for s in seats] == ["claude-sonnet-5", "claude-grok-46", "claude-sonnet-5"]
    only = core.table_from_specs(models, ["opus:3"])                   # one model, three seats
    assert [s["id"] for s in only] == ["claude-opus-5"] * 3
    for specs, chair in ((["sonnet"], None), (["claude"], None), (["sonnet", "grok"], "opus")):
        try:
            core.table_from_specs(models, specs, chair)                 # 1 seat / ambiguous / chair not seated
            raise AssertionError(specs)
        except ValueError:
            pass


def test_stray_tokens():
    assert core.stray_tokens(["3", "how", "to", "fix"]) == ["3"]
    assert core.stray_tokens(["sonnet:2", "grok:high", "x2", "fix", "it"]) == ["sonnet:2", "grok:high", "x2"]
    assert core.stray_tokens(["why", "is", "the", "sync", "slow?"]) == []


def test_board_text():
    assert core.tag(0.081, 2, 0.005) == " · 2 steps · $0.081 · $0.005 left"
    assert core.tag(0.5) == " · $0.50"
    seats = [{"label": "GPT 5.6 Sol", "effort": "xhigh"}, {"label": "Claude Opus 5", "effort": "high"}]
    cfg = {"rounds": 5, "anon": False, "budget": 100, "steps": 3}
    led = core.Ledger(["GPT 5.6 Sol", "Claude Opus 5"], 100)
    head = core.board_header("Q?", seats, ["GPT 5.6 Sol", "Claude Opus 5"], cfg, led)
    assert "chair Claude Opus 5" in head and "$0.42 a seat" in head and "= GPT 5.6 Sol · xhigh" in head
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


# ---- wizard ----------------------------------------------------------------

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
    old = Wizard(MODELS, {"chair": "pro", "seated": ["opus", "pro"]})  # state saved before counts existed
    assert old.count == {0: 1, 2: 1}


def test_wizard_counts():
    w = Wizard(MODELS)
    press(w, "enter", "enter")                                          # opus chairs alone → refused
    assert w.step == 1 and "at least 2" in w.note
    press(w, "+", "+", "enter")                                         # opus ×3: one model, three seats
    assert w.step == 2 and w.count[0] == 3
    press(w, "esc")
    w.cur = 0
    press(w, "-", "-", "-", "-")
    assert w.count[0] == 1                                              # the chair keeps one seat
    w.cur = 2
    press(w, "space", "+", "left")                                      # pro ×2 at medium
    assert w.count[2] == 2 and w.effort["pro"] == 1
    cfg = w.config()
    assert [s["id"] for s in cfg["seats"]] == ["pro", "pro", "opus"]    # chair last
    assert Wizard(MODELS, w.saved()).count == {0: 1, 2: 2}
    shot = text_of(render(w, "Q?", lambda m: dict(PRICES["models"]["cheap"], unknown=False), lambda w: 1))
    assert "×2" in shot and "3 at the table" in shot


def text_of(lines):
    return "\n".join("".join(t for _, t in line) for line in lines)


def test_render():
    w = Wizard(MODELS)
    price = lambda mid: dict(PRICES["models"]["cheap"], unknown=mid == "pro")
    shot = text_of(render(w, "Q?", price, lambda w: 1.234))
    assert "1 chair" in shot and "Claude Opus 5" in shot and "high" in shot and "price ?" in shot
    press(w, "enter", "down", "space", "enter")
    w.cur = 2
    press(w, "space", "2")
    shot = text_of(render(w, "Q?", price, lambda w: 1.234))
    assert "$ 2.00" in shot and "worst case ≈ $1.23" in shot


# ---- runner ----------------------------------------------------------------

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
        run = os.path.join(root, "elsewhere")                           # a --board outside ./council
        for d in ("council/old/plans", "elsewhere/plans"):
            os.makedirs(os.path.join(root, d))
        for d in ("council/old/plans/B.md", "elsewhere/plans/B.md"):
            with open(os.path.join(root, d), "w") as f:
                f.write("sync_ secret plan\n")
        assert "off limits" in council.run_tool(root, "read_file", {"path": "council/old/plans/B.md"})
        assert "off limits" in council.run_tool(root, "read_file", {"path": "elsewhere/plans/B.md"}, (run,))
        assert "off limits" in council.run_tool(root, "list_dir", {"path": "elsewhere"}, (run,))
        assert "secret" not in council.run_tool(root, "grep", {"pattern": "sync_"}, (run,))


def fake_proxy(script, crit=None, review=None, chair=None):
    """script: model id -> replies for discussion turns. crit: model id -> replies
    for the final check (default NO ISSUES). review / chair: the chair's replies."""
    calls, crit, review, chair = [], crit or {}, review or [], chair or []

    def post(model, effort, system, messages, tools=None, max_tokens=16000):
        calls.append((model, effort, system[:30], system))
        usage = {"input_tokens": 1000, "output_tokens": 200}
        text = lambda t: {"content": [{"type": "text", "text": t}], "usage": usage}
        if model == "broken":
            raise council.CallError("429 usage_limit_reached")
        if "complete plan" in system:
            assert "Question:" in messages[0]["content"]                 # blind: nothing but the question
            return text(f"1. plan by {model}")
        if "attack it" in system:
            left = crit.get(model)
            return text(left.pop(0) if left else "NO ISSUES")
        if "checked your draft" in system:
            return text(review.pop(0) if review else "FINISH")
        if "go on" in system:
            return text(chair.pop(0) if chair else "STOP — agreement on the small fix")
        if "more look-up time" in system:
            return text("GRANT — could change the plan")
        if "reached agreement" in system:
            return text("1. draft: push discounted nights\n### Still disputed\n- none")
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


def run_meeting(seats, script, crit=None, review=None, chair=None, **cfg):
    root = tempfile.mkdtemp()
    with open(os.path.join(root, "a.py"), "w") as f:
        f.write("sync_window = 2\n")
    post, calls = fake_proxy(script, crit, review, chair)
    conf = {"seats": seats, "rounds": 5, "anon": False, "budget": 0, "steps": 3} | cfg
    run = os.path.join(root, "council", "run")
    council.Meeting(conf, "Why?", post, PRICES, root, os.path.join(run, "board.md"), log=lambda *_: None).run()
    read = lambda rel: open(os.path.join(run, rel)).read()
    return read("board.md"), calls, read


def seat(i, e="high"):
    return {"id": i, "label": i.upper(), "effort": e}


def test_meeting_happy_path():
    board, calls, read = run_meeting(
        [seat("cheap", "low"), seat("dear")],
        {"cheap": ["TOOL", "Agree with B — convinced by its sync-window point."],
         "dear": ["MORE: need the sync log", "Then the small fix."]})
    assert "## Plans" in board and "1. plan by cheap" in board and "1. plan by dear" in board
    assert "- A = CHEAP · low" in board and "### A · 1 step" in board   # the grep counted as a step
    assert "### B asks for more time — need the sync log" in board and "granted" in board
    assert "discussion ended: chair called it" in board
    assert board.index("## Draft joint plan") < board.index("## Final check") < board.index("## Joint plan")
    assert "### A · no issues" in board and "the draft stands" in board
    assert "## Spend" in board
    assert read("plans/A.md").startswith("# A (CHEAP) — plan") and "1. plan by dear" in read("plans/B.md")
    assert "1. draft: push discounted nights" in read("final.md") and "- B = DEAR · high" in read("final.md")
    assert ("cheap", "low", "You are one of several AI mode") in [c[:3] for c in calls]   # effort per seat
    turns = [c[3] for c in calls if c[3].startswith("You are A, a participant")]
    assert "no PASS" in turns[0]                                          # round 1 must react to the plans


def test_round_one_must_react_and_explain():
    assert "no PASS" in council.FIRST_SYSTEM and "OTHER plans" in council.FIRST_SYSTEM
    for p in (council.FIRST_SYSTEM, council.TURN_SYSTEM):
        assert "why you were convinced" in p


def test_same_model_many_seats():
    board, calls, read = run_meeting([seat("cheap"), seat("cheap"), seat("cheap")],
                                     {"cheap": ["a", "b", "c"]})
    assert [read(f"plans/{x}.md").count("1. plan by cheap") for x in "ABC"] == [1, 1, 1]
    assert "- A = CHEAP" in board and "- C = CHEAP" in board and "chair C" in board
    assert sum(1 for c in calls if "several AI" in c[2]) == 3            # three independent plans


def test_failed_seat_is_marked_not_replaced():
    board, calls, read = run_meeting([seat("broken"), seat("cheap"), seat("dear")],
                                     {"cheap": ["x"], "dear": ["y"]})
    assert "### A (BROKEN) — failed" in board and "failed" in read("plans/A.md")
    assert sum(1 for c in calls if c[0] == "broken") == 1                # no retry
    assert {c[0] for c in calls} == {"broken", "cheap", "dear"}          # no stand-in model
    assert "### A" not in board.split("## Discussion")[1].replace("### A (BROKEN)", "")  # out for good
    assert "## Joint plan" in board and "- A = BROKEN · high · failed" in read("final.md")


def test_failed_chair_hands_over():
    board, _, read = run_meeting([seat("cheap"), seat("dear"), seat("broken")],
                                 {"cheap": ["x"], "dear": ["y"]})
    assert "chair C failed; B takes the chair" in board and "## Joint plan" in board


def test_final_check_reopens_the_discussion():
    board, _, read = run_meeting(
        [seat("cheap"), seat("dear")],
        {"cheap": ["plan A is fine", "fixed: add a rollback"], "dear": ["agree", "ok"]},
        crit={"cheap": ["ISSUE: no rollback if the push fails", "NO ISSUES"]},
        review=["CONTINUE: no rollback"])
    body = board.split("## Discussion")[1]
    assert "### A · issue" in body and "no rollback if the push fails" in body
    assert "back to the table — no rollback" in body
    assert body.count("## Draft joint plan") == 2 and body.count("## Final check") == 2
    assert "— round 2 —" in body and body.index("back to the table") < body.index("— round 2 —")
    assert "## Joint plan" in board


def test_final_check_minor_issue_amends():
    board, _, read = run_meeting([seat("cheap"), seat("dear")], {"cheap": ["x"], "dear": ["y"]},
                                 crit={"dear": ["ISSUE: typo in step 1"]},
                                 review=["FINISH\n1. amended plan\n### Still disputed\n- none"])
    assert "**chair B:** finish" in board and "1. amended plan" in read("final.md")


def test_no_final_check_without_consensus():
    board, _, _ = run_meeting([seat("cheap"), seat("dear")], {"cheap": ["x"], "dear": ["y"]}, rounds=1)
    assert "discussion ended: max rounds" in board and "## Final check" not in board
    assert "1. push discounted nights" in board.split("## Joint plan")[1]


def test_meeting_everyone_passes_and_broken_seat():
    board, _, _ = run_meeting([seat("broken"), seat("cheap"), seat("dear")],
                              {"cheap": ["x", "PASS"], "dear": ["y", "PASS"]},
                              chair=["CONTINUE — still open"])
    assert "discussion ended: everyone passed" in board and "## Final check" in board
    assert "## Joint plan" in board


def test_meeting_budget_and_anon():
    board, calls, read = run_meeting([seat("dear"), seat("dear"), seat("cheap")], {"cheap": ["y"]},
                                     budget=1, anon=True)
    # $0.01 → seats of $0.0028: both dear plans ($0.01 each) empty their seats,
    # cheap (the chair) speaks once and empties its own → budget spent
    assert "### A passes · seat empty" in board and "### B passes · seat empty" in board
    assert "discussion ended: budget spent" in board and "## Joint plan" in board
    assert "DEAR" not in board.split("## Who was who")[0]       # names hidden until the end
    assert "DEAR" not in read("plans/A.md")
    assert "- A = DEAR · high" in board


def test_cli_keeps_settings_out_of_the_question():
    for argv in (["3", "plan", "a", "site"], ["plan", "sonnet:2", "site"]):
        try:
            council.main(argv + ["--split"])
            raise AssertionError(argv)
        except SystemExit as e:
            assert e.code == 2
    ran = []
    council.split, real = (lambda q, b, **k: ran.append((q, k["extra"])) or "tmux"), council.split
    try:
        council.main(["--seat", "sonnet:high:2", "3 ways to plan a site", "--seat=grok",
                      "--rounds", "4", "--no-anon", "--split"])
        council.main(["--split", "--seat", "grok:2", "--", "--why is it slow?"])
    finally:
        council.split = real
    assert ran[0] == ("3 ways to plan a site",
                      ["--seat=sonnet:high:2", "--seat=grok", "--rounds=4", "--no-anon"])
    assert ran[1][0] == "--why is it slow?"


def test_split_falls_back_when_nobody_claims():
    with tempfile.TemporaryDirectory() as d:
        ran = []
        env = os.environ.pop("TMUX", None)
        council.AUTOSTART_SKIP = os.path.join(d, "skip")
        try:
            where = council.split("Q it's?", "/tmp/b.md", requests=d, run=lambda a, **k: ran.append(a), wait=0.2)
        finally:
            if env is not None:
                os.environ["TMUX"] = env
        assert where == "terminal" and ran[0][0] == "osascript" and os.listdir(d) == ["skip"]
        assert ran[0][-1].endswith("ccx council --board /tmp/b.md -- 'Q it'\"'\"'s?'")


def test_split_uses_tmux_inside_tmux():
    ran = []
    os.environ["TMUX"] = "/tmp/fake,1,0"
    try:
        assert council.split("Q", "/tmp/b.md", run=lambda a, **k: ran.append(a)) == "tmux"
    finally:
        del os.environ["TMUX"]
    assert ran[0][:3] == ["tmux", "split-window", "-h"]


def test_split_claimed_by_editor():
    import threading
    with tempfile.TemporaryDirectory() as d:
        def claim():                                   # stands in for the VS Code extension
            for _ in range(50):
                for f in os.listdir(d):
                    if f.endswith(".json"):
                        os.remove(os.path.join(d, f))
                        return
                time.sleep(0.02)
        threading.Thread(target=claim).start()
        env = os.environ.pop("TMUX", None)
        try:
            assert council.split("Q", "/tmp/b.md", requests=d, run=lambda *a, **k: 1 / 0, wait=2) == "vscode"
        finally:
            if env is not None:
                os.environ["TMUX"] = env


TESTS = [v for k, v in sorted(globals().items()) if k.startswith("test_")]

if __name__ == "__main__":
    for t in TESTS:
        t()
        print("  ok  ", t.__name__)
    print("all passed")
