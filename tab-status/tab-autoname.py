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

import fcntl
import json
import os
import re
import sys
import tempfile
import time
import unicodedata
import urllib.request
import uuid

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
    "- NONE — there is no current name yet AND the message asks for nothing at all: a greeting, a "
    "thank-you, a bare acknowledgement. Any actual request counts as a topic and gets a label, "
    "however small or playful the request is.\n"
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


def read(path):
    try:
        with open(path, encoding="utf-8") as f:
            return f.read().strip()
    except OSError:
        return ""


def atomic_write(path, text):
    fd, temporary = tempfile.mkstemp(dir=os.path.dirname(path), prefix=".name-")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(text + "\n")
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def sanitize(text):
    # Remove whole terminal escape sequences, not just ESC (OSC can set titles).
    text = re.sub(r"\x1b\][^\x07\x1b]*(?:\x07|\x1b\\|$)", "", text)
    text = re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", text)
    text = "".join(" " if c.isspace() else c for c in text
                   if c.isspace() or not unicodedata.category(c).startswith("C"))
    text = " ".join(text.split())
    # Status belongs to the watcher; repeated pasted badges must not multiply it.
    return text.lstrip("🟢🔴🟡🟠🔵🟣⚫⚪🟤●○◉•·️ ").strip()


def mark(session, status):
    atomic_write(os.path.join(STATE, session + ".namer"), status)


def note(session, current, prompt, raw, decision):
    """One line per decision. Without the raw answer, a tab that failed to get
    named is indistinguishable from one the model deliberately left alone."""
    try:
        with open(os.path.join(STATE, "autoname.log"), "a", encoding="utf-8") as f:
            f.write("[%s] %s current=%r prompt=%r raw=%r → %s\n" % (
                time.strftime("%H:%M:%S"), session[:8], current,
                prompt[:60], (raw or "")[:80], decision))
    except OSError:
        pass


def ask(current, text, retry_of=None):
    text = ("Current tab name: %s\n\nNewest user message:\n%s"
            % (current or "(none yet — the tab is unnamed)", text))
    messages = [{"role": "system", "content": PROMPT},
                {"role": "user", "content": text}]
    if retry_of is not None:
        # Small models drift into a sentence. One corrective turn is cheaper
        # than losing the name and leaving the tab on the folder placeholder.
        messages += [{"role": "assistant", "content": retry_of},
                     {"role": "user", "content": "That is not a valid answer. Reply with KEEP, "
                                                 "or NONE, or a label of at most three words — "
                                                 "the answer alone, nothing else."}]
    body = json.dumps({
        "model": MODEL,
        "max_tokens": 24,
        "temperature": 0,
        "stream": False,   # the gateway streams SSE by default, which is not JSON
        "messages": messages,
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
    name = sanitize(name)
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
    if not isinstance(hook, dict):
        return
    session = hook.get("session_id") or ""
    prompt = hook.get("prompt") or ""
    if (not isinstance(session, str) or not re.fullmatch(r"[A-Za-z0-9_-]+", session)
            or not isinstance(prompt, str) or not prompt.strip()):
        return
    prompt = prompt.strip()

    name_file = os.path.join(STATE, session + ".name")
    pin_file = os.path.join(STATE, session + ".pinned")
    live_file = os.path.join(STATE, session + ".state")
    generation_file = os.path.join(STATE, session + ".name-generation")
    lock_file = os.path.join(STATE, session + ".name.lock")
    generation = uuid.uuid4().hex
    try:
        # Register before detaching: child scheduling must not reorder prompts.
        # tn and session-end use this same persistent lock; never unlink it.
        with open(lock_file, "a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            if not os.path.exists(live_file) or os.path.exists(pin_file):
                return
            original = read(name_file)
            atomic_write(generation_file, generation)
    except OSError:
        return
    placeholder = os.path.basename(hook.get("cwd") or os.getcwd())
    current = "" if original == placeholder else original

    # No lock is held across the slow network request.
    if os.fork() > 0:
        return
    os.setsid()
    null = os.open(os.devnull, os.O_RDWR)
    for fd in (0, 1, 2):
        os.dup2(null, fd)
    if null > 2:
        os.close(null)

    raw, name, failed = None, "", False
    try:
        raw = ask(current, prompt[:2000])
        name = clean(raw)
        if not name and (raw or "").strip().upper() not in ("KEEP", "NONE"):
            raw = ask(current, prompt[:2000], retry_of=raw)
            name = clean(raw)
    except Exception:
        failed = True
    try:
        with open(lock_file, "a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            if (not os.path.exists(live_file) or os.path.exists(pin_file)
                    or read(generation_file) != generation or read(name_file) != original):
                return                          # obsolete response, including its marker
            if failed:
                note(session, current, prompt, None, "fail")
                mark(session, "fail")
            elif not name or name == current:
                note(session, current, prompt, raw, "keep" if current else "none")
                mark(session, "ok" if current else "none")
            else:
                atomic_write(name_file, name)
                note(session, current, prompt, raw, "set " + name)
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
