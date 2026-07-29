#!/usr/bin/env python3
"""UserPromptSubmit hook: name the terminal tab from the user's own prompt.

Deterministic code owns the naming, not the assistant in the session. This
reads the prompt off the hook payload, asks a cheap model for a short topic
label, and writes it into the tab-status name file. The assistant is only a
fallback: on failure this leaves a marker that tab.sh's remind-name reads.

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
    "You name terminal tabs. Given a user's message to a coding assistant, reply with a short "
    "topic label naming what the session is about.\n"
    "- Two words is the target. Three is the hard maximum. One word only when it is genuinely enough.\n"
    "- Write the label in THE SAME LANGUAGE the user wrote their message in. A Hebrew message gets a "
    "Hebrew label. Keep a product or tool name in its original spelling.\n"
    "- Lowercase unless it is a proper noun. No quotes, no punctuation, no explanation — the label alone.\n"
    "- If the message reveals no work topic (a greeting, a thank-you, a throwaway one-liner), "
    "reply with exactly: NONE"
)


def mark(session, status):
    try:
        with open(os.path.join(STATE, session + ".namer"), "w", encoding="utf-8") as f:
            f.write(status + "\n")
    except OSError:
        pass


def ask(text):
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
    if not name or name.upper() == "NONE":
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
    if current and current != placeholder:
        return                                    # already carries a real name

    # Detach: the parent must return now or the user waits on the network call.
    if os.fork() > 0:
        return
    os.setsid()
    null = os.open(os.devnull, os.O_RDWR)
    for fd in (0, 1, 2):
        os.dup2(null, fd)

    try:
        name = clean(ask(prompt[:2000]))
    except Exception:
        mark(session, "fail")                     # lets the assistant fall back in
        os._exit(0)
    if not name:
        mark(session, "none")                     # nothing nameable yet; retry next prompt
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
