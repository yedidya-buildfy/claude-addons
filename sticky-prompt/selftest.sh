#!/bin/bash
# Checks that the marks land on the right bytes of a recorded message block.
# Run: ./selftest.sh
cd "$(dirname "$0")" || exit 1
exec python3 - <<'PY'
import importlib.machinery, importlib.util, sys

spec = importlib.util.spec_from_loader(
    "sticky", importlib.machinery.SourceFileLoader("sticky", "./sticky-claude"))
sticky = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sticky)

BEL = b"\a"
# Byte-for-byte how Claude 2.1 draws a submitted two-row message (light theme).
BOX = (b"\x1b[?2026h\x1b[?25l\x1b[33D\x1b[6B\r\x1b[8A"
       b"\x1b[48;2;240;240;240m\x1b[38;2;175;175;175m\xe2\x9d\xaf "
       b"\x1b[38;2;0;0;0mfirst row of the message\x1b[39m \r\x1b[1B"
       b"  \x1b[38;2;0;0;0msecond row\x1b[39m      \r\x1b[2C\x1b[1B"
       b"\x1b[49m\x1b[K\r\x1b[1Bspinner")

fail = []


def check(label, condition):
    if not condition:
        fail.append(label)


out = sticky.Marker().feed(BOX)

check("previous command is closed first",
      b"\x1b]633;D;0\a\x1b]633;A\a\x1b[48;2;240" in out)
check("prompt-start sits before the block, not inside it",
      out.index(b"\x1b]633;A") < out.index(b"\x1b[48;2;240"))
check("command-start closes the final row before the cursor parks",
      b"second row\x1b[39m      \x1b]633;B\a\x1b]633;C\a" in out)
check("running mark comes before the background is turned off",
      out.index(b"\x1b]633;C") < out.index(b"\x1b[49m"))
check("the whole message becomes the command name",
      b"\x1b]633;E;first row of the message second row\a" in out)
check("nothing but the marks is added",
      sticky.ANSI.sub(b"", out).replace(b"\r", b"") ==
      sticky.ANSI.sub(b"", BOX).replace(b"\r", b""))

# a stream with no message in it must come out untouched
check("untouched when there is no message",
      sticky.Marker().feed(b"\x1b[2mjust output\x1b[0m\r\n") ==
      b"\x1b[2mjust output\x1b[0m\r\n")

# the block may be split across two reads
marker = sticky.Marker()
split = len(BOX) - 30
piece = marker.feed(BOX[:split]) + marker.feed(BOX[split:])
check("block split across reads is still marked", piece == out)
check("nothing is held back once the block is complete", marker.held == b"")

# a run that stalls mid-block must not swallow the output
marker = sticky.Marker()
held = marker.feed(BOX[:split])
check("incomplete block is held, not printed", b"\x1b[48;2;240" not in held)
check("holding it back can be undone", marker.drain() + b"" == BOX[held.__len__():split])

# a taller message: the block is closed after three rows, so exactly the first
# three get pinned however long the message is
ROW = b"  \x1b[38;2;0;0;0mrow %d\x1b[39m   \r\x1b[1B"
TALL = (b"\x1b[48;2;240;240;240m\x1b[38;2;175;175;175m\xe2\x9d\xaf "
        b"\x1b[38;2;0;0;0mrow 1\x1b[39m   \r\x1b[1B"
        + b"".join(ROW % n for n in (2, 3, 4, 5))
        + b"  \x1b[38;2;0;0;0mrow 6\x1b[39m   \r\x1b[2C\x1b[1B\x1b[49m\x1b[K")
tall_out = sticky.Marker().feed(TALL)
check("tall message is closed after the third row",
      b"row 3\x1b[39m   \x1b]633;B\a\x1b]633;C\a" in tall_out)
check("rows past the third are left alone",
      b"\x1b]633;E;" in tall_out and b"row 4" in tall_out.split(b"\a")[-1])
check("the command name is still the whole message",
      b"\x1b]633;E;row 1 row 2 row 3 row 4 row 5 row 6\a" in tall_out)

# escaping in the command name
odd = BOX.replace(b"first row of the message", b"a;b\\c")
check("semicolon and backslash escaped in the name",
      b"\x1b]633;E;a\\x3bb\\x5cc second row\a" in sticky.Marker().feed(odd))

if fail:
    for f in fail:
        print("FAIL:", f)
    sys.exit(1)
print("all checks passed")
PY
