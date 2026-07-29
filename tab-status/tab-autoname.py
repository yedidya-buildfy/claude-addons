#!/usr/bin/env python3
"""UserPromptSubmit hook: keep the terminal tab named after what the user is doing.

Deterministic code owns the naming, not the assistant in the session. This runs
on every prompt and asks a cheap model one question: given the tab's current
name and the newest message, does the name still fit? The usual answer is KEEP
and nothing happens; a genuine change of subject gets a new label. The
assistant is only a fallback: on failure this leaves a marker that tab.sh's
remind-name reads.

Runs the network call in a detached child so the hook returns instantly — a
UserPromptSubmit hook blocks the turn until it exits, and the first call
through a cold gateway route can take ~15s.

Overridable: TAB_NAME_API, TAB_NAME_MODEL, TAB_NAME_TIMEOUT.
"""

import json
import os
import re
import sys
import urllib.request

STATE = os.path.expanduser("~/.claude/terminal-state")
API = os.environ.get("TAB_NAME_API", "http://localhost:20128/v1/chat/completions")
MODEL = os.environ.get("TAB_NAME_MODEL", "auto/best-free")
TIMEOUT = float(os.environ.get("TAB_NAME_TIMEOUT", "40"))
MAX_WORDS = 3

PROMPT = (
    "You maintain the name of a terminal tab. You get the tab's current name and the newest message "
    "the user sent to a coding assistant working in that tab. Reply with ONE line and nothing else.\n"
    "\n"
    "LANGUAGE RULE — THE MOST IMPORTANT ONE: the label must be written in the same language as the "
    "user's message. If the message is in Hebrew, the label MUST be in Hebrew letters. Never translate "
    "a Hebrew message into an English label. Product and tool names keep their original spelling.\n"
    "\n"
    "What to reply:\n"
    "- KEEP — the current name still covers what the user is working on. Follow-ups, confirmations, "
    "corrections, and short messages that add no new subject are all KEEP.\n"
    "- A new label — the user moved to different work. Naming a different bug, feature, file or area "
    "than the current name IS different work, even when the sentence is short.\n"
    "- NONE — there is no current name yet and this message reveals no work topic (a greeting, a "
    "thank-you, a throwaway one-liner).\n"
    "\n"
    "Label shape: two words is the target, three is the hard maximum, one only when it is genuinely "
    "enough. Lowercase unless it is a proper noun. No quotes, no punctuation, no explanation.\n"
    "\n"
    "Examples:\n"
    "current: (none yet) | message: תוסיף טבלת הכנסות לדשבורד של הוילות -> דשבורד וילות\n"
    "current: דשבורד וילות | message: תוסיף גם עמודת רווח -> KEEP\n"
    "current: דשבורד וילות | message: אוקיי מעולה תדחף הכל -> KEEP\n"
    "current: דשבורד וילות | message: עכשיו בוא נתקן את הבאג שמנתק משתמשים -> באג התנתקות\n"
    "current: auth bug | message: now let's write the deployment docs -> deployment docs\n"
    "current: (none yet) | message: היי מה נשמע -> NONE"
)


def mark(session, status):
    try:
        with open(os.path.join(STATE, session + ".namer"), "w", encoding="utf-8") as f:
            f.write(status + "\n")
    except OSError:
        pass


def ask(current, text):
    text = ("Current tab name: %s\n\nNewest user message:\n%s"
            % (current or "(none yet — the tab is unnamed)", text))
    body = json.dumps({
        "model": MODEL,
        "max_tokens": 24,
        "temperature": 0,
        "stream": False,   # the gateway streams SSE by default, which is not JSON
        "messages": [{"role": "system", "content": PROMPT},
                     {"role": "user", "content": text}],
    }).encode("utf-8")
    req = urllib.request.Request(API, body, {"Content-Type": "application/json",
                                             "Authorization": "Bearer local"})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
        payload = json.load(r)
    return payload["choices"][0]["message"]["content"]


def clean(raw):
    """A label we would be willing to show. Returns '' to mean 'no name'."""
    name = (raw or "").strip().strip('"\'' + "`")
    name = name.splitlines()[0] if name else ""
    name = re.sub(r"[.,:;!?]+$", "", name).strip()
    if not name or name.upper() in ("NONE", "KEEP"):
        return ""
    words = name.split()
    if len(words) > MAX_WORDS:
        return ""          # model ignored the limit — a wrong name is worse than none
    name = " ".join(words)
    return name if len(name) <= 32 else ""


def main():
    try:
        hook = json.load(sys.stdin)
    except Exception:
        return
    session = hook.get("session_id") or ""
    prompt = (hook.get("prompt") or "").strip()
    if not session or not prompt:
        return

    name_file = os.path.join(STATE, session + ".name")
    if os.path.exists(os.path.join(STATE, session + ".pinned")):
        return                                    # the human named it — hands off
    try:
        with open(name_file, encoding="utf-8") as f:
            current = f.read().strip()
    except OSError:
        current = ""
    placeholder = os.path.basename(hook.get("cwd") or os.getcwd())
    if current == placeholder:
        current = ""                              # the folder name is not a real name

    # Detach: the parent must return now or the user waits on the network call.
    if os.fork() > 0:
        return
    os.setsid()
    null = os.open(os.devnull, os.O_RDWR)
    for fd in (0, 1, 2):
        os.dup2(null, fd)

    try:
        name = clean(ask(current, prompt[:2000]))
    except Exception:
        mark(session, "fail")                     # lets the assistant fall back in
        os._exit(0)
    if not name or name == current:
        # KEEP, or nothing nameable yet. Either way the tab stays as it is and
        # the question gets asked again on the next prompt.
        mark(session, "ok" if current else "none")
        os._exit(0)
    try:
        with open(name_file, "w", encoding="utf-8") as f:
            f.write(name + "\n")
        mark(session, "ok")
    except OSError:
        pass
    os._exit(0)


def selftest():
    cases = [
        ('"auth bug"', "auth bug"),          # models like to quote
        ("Auth Bug.", "Auth Bug"),           # trailing punctuation
        ("דשבורד וילות", "דשבורד וילות"),      # non-latin passes through
        ("NONE", ""),                        # nothing nameable
        ("none", ""),
        ("KEEP", ""),                        # name still fits — no write
        ("Keep", ""),
        ("", ""),
        ("a b c d", ""),                     # over the word limit → refuse
        ("Sure! The label is: auth bug", ""),  # chatty answer → refuse
        ("name\nexplanation line", "name"),   # only the first line counts
    ]
    for raw, want in cases:
        got = clean(raw)
        assert got == want, "clean(%r) = %r, expected %r" % (raw, got, want)
    print("tab-autoname selftest OK")


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        selftest()
    else:
        main()
