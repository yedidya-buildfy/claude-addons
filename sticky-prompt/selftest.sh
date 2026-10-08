#!/bin/bash
# Checks that the marks land on the right bytes of a recorded message block.
# Run: ./selftest.sh
cd "$(dirname "$0")" || exit 1
exec python3 - <<'PY'
import importlib.machinery, importlib.util, re, sys

spec = importlib.util.spec_from_loader(
    "sticky", importlib.machinery.SourceFileLoader("sticky", "./sticky-claude"))
sticky = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sticky)

BEL = b"\a"
fail = []


def check(label, condition):
    if not condition:
        fail.append(label)


def box(text):
    """A sent message the way Claude 2.1 draws it: background, grey glyph,
    then the text in its own colour."""
    return (b"\x1b[48;2;55;55;55m\x1b[38;2;153;153;153m" + "❯ ".encode()
            + b"\x1b[38;2;255;255;255m" + text.encode()
            + b"\x1b[39m   \r\x1b[1B\x1b[49m\x1b[K")


def marks(out):
    return out.count(b"\x1b]633;A\a")


# drawn once, then quiet: one mark, stepping up to the block and back
m = sticky.Marker(40, 10)
out = m.feed(b"\r\x1b[5A" + box("hello there") + b"\r\x1b[1Bspinner")
check("nothing is marked while the block is being drawn", marks(out) == 0)
done = m.settle()
check("settling marks the block once", marks(done) == 1)
check("the mark goes to the block's row and comes back",
      done.startswith(b"\x1b7\x1b[2A\r\x1b]633;D;0\a\x1b]633;A\a") and done.endswith(b"\x1b8"))
check("the whole message becomes the command name", b"\x1b]633;E;hello there\a" in done)
check("nothing but the marks is added", out == b"\r\x1b[5A" + box("hello there") + b"\r\x1b[1Bspinner")
check("settling again adds nothing", m.settle() == b"")

# moved while the turn runs: the old row now holds reply text
m = sticky.Marker(40, 39)
m.feed(b"\r\x1b[10A" + box("moving") + b"\r\x1b[8B")          # drawn at row 29
m.feed(b"\r\x1b[10Areply text here\r\x1b[1B" + box("moving") + b"\r\x1b[7B")  # moved to 30, cursor 38
done = m.settle()
check("a moved message is marked once", marks(done) == 1)
check("at the row it moved to", done.startswith(b"\x1b7\x1b[8A\r"))

# a queued message drawn above its hint is not marked
m = sticky.Marker(40, 39)
queued = b"\x1b[48;2;55;55;55m\x1b[38;2;153;153;153m" + "❯ ".encode() + b"queued one   \r\x1b[1B\x1b[49m"
m.feed(b"\r\x1b[5A" + queued + b"\r\x1b[3B")
check("queued message (all in the glyph's grey) is not marked", marks(m.settle()) == 0)
# its turn starts: Claude recolours just the text, in place
m.feed(b"\r\x1b[2C\x1b[4A\x1b[48;2;55;55;55m\x1b[38;2;255;255;255mqueued one\x1b[39m\x1b[49m\r\x1b[5B")
check("marked once its turn starts", marks(m.settle()) == 1)

# recoloured in place when its turn starts: still the same message
m = sticky.Marker(40, 39)
m.feed(b"\r\x1b[5A" + box("steer") + b"\r\x1b[3B")
m.feed(b"\r\x1b[2C\x1b[4A\x1b[48;2;55;55;55m\x1b[38;2;255;255;255msteer\x1b[39m\x1b[49m\r\x1b[5B")
check("a message recoloured in place keeps its block", marks(m.settle()) == 1)

# scrolling off the top before it settled: marked just before it leaves
m = sticky.Marker(5, 4)
m.feed(b"\r\x1b[4A" + box("top row") + b"\r\x1b[3B")
out = m.feed(b"\r\n")
check("marked just before scrolling into history",
      marks(out) == 1 and out.endswith(b"\x1b8\n"))
check("and not again later", m.settle() == b"")

# Hebrew is drawn reversed; the command name is in reading order
check("Hebrew name in reading order",
      sticky.command_name(["❯ השקבב תואקספ שולש קר"]) == "רק שלוש פסקאות בבקשה".encode())
check("Latin inside Hebrew keeps its order",
      sticky.command_name(["❯ api.py ןקת"]) == "תקן api.py".encode())
check("semicolon and backslash escaped in the name",
      sticky.command_name(["❯ a;b\\c"]) == b"a\\x3bb\\x5cc")

# a whole recorded session: a message, a steering message sent mid-turn, /exit.
# The old wrapper set 13 marks on it. Mid-turn Claude reprints the whole
# conversation below the history, so the first message is on screen twice and
# each copy gets its mark; the steering message, queued and redrawn every
# frame, gets exactly one.
rec = open("fixtures/steering.raw", "rb").read()
m = sticky.Marker(40, 0)
out = m.feed(rec[:50000]) + m.feed(rec[50000:]) + m.settle()
names = re.findall(rb"\x1b\]633;E;([^\a]*)\a", out)
check("recorded session: one mark per message on screen", marks(out) == 4)
check("recorded session: the steering message is marked once",
      names.count("רק שלוש פסקאות בבקשה".encode()) == 1)
check("recorded session: nothing but the marks is added",
      re.sub(rb"\x1b7(?:\x1b\[\d+[AB])?\r\x1b\]633;D.*?\x1b8", b"", out, flags=re.S) == rec)

# Hebrew keyboard on a slash command: typed key by key, as a terminal sends it
def typed(keys, names=("מועצה",), fix=None):
    fix = fix or sticky.SlashFix(names)
    out = b"".join(fix.feed(k.encode()) for k in keys)
    # replay the backspaces the way the input box would
    box = ""
    for c in out.decode():
        box = box[:-1] if c == "\x7f" else box + c
    return box

check("/בךקשר becomes /clear", typed("/בךקשר") == "/clear")
check("the slash key on Hebrew (a dot) also works", typed(".בךקשר") == "/clear")
check("dash inside a command", typed("/בםגק-רקהןק'") == "/code-review")
check("arguments after the command stay Hebrew", typed("/צםגקך שלום") == "/model שלום")
check("a Hebrew-named command is left alone", typed("/מועצה") == "/מועצה")
check("leaves the Hebrew name when it stops matching", typed("/מם") == "/no")
check("an ordinary Hebrew message is untouched", typed("שלום /בךקשר") == "שלום /בךקשר")
check("a path is untouched", typed("/tmp/קובץ") == "/tmp/קובץ")
check("a sentence starting with a dot is untouched", typed(". שלום") == ". שלום")
check("after Enter the next message counts again",
      typed(["שלום", "\r", "/", "בךקשר"]).endswith("/clear"))
check("deleting the slash and retyping works",
      typed(["/", "\x7f", "/", "בךקשר"]) == "/clear")
check("Esc on an empty box does not break it", typed(["\x1b", "/בךקשר"]) == "\x1b/clear")
split_fix = sticky.SlashFix()
check("Hebrew split mid-letter across reads",
      split_fix.feed(b"/\xd7") + split_fix.feed(b"\x91") == b"/c")

# Ctrl/Alt shortcuts on the Hebrew layout, in both detailed key formats
es = sticky.english_shortcuts
check("Ctrl-ב becomes Ctrl-C", es(b"\x1b[1489;5u") == b"\x1b[99;5u")
check("Ctrl-ב (other format) becomes Ctrl-C", es(b"\x1b[27;5;1489~") == b"\x1b[27;5;99~")
check("Ctrl-ב with event type kept", es(b"\x1b[1489;5:1u") == b"\x1b[99;5:1u")
check("Shift-only Hebrew letter untouched", es(b"\x1b[1489;2u") == b"\x1b[1489;2u")
check("plain text untouched", es("שלום".encode()) == "שלום".encode())

if fail:
    for f in fail:
        print("FAIL:", f)
    sys.exit(1)
print("all checks passed")
PY
