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


# ---- drawing ---------------------------------------------------------------

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
                      [("dim", " " * 52 + "list price in / out per 1M")]]
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
