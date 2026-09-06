#!/usr/bin/env python3
"""UserPromptSubmit hook: keep the terminal tab named after what the user is doing.

The hook payload is untrusted; the newest genuinely human turns are read from
the session transcript instead. One cheap model call decides whether the tab's
topic changed, and only a confident "change" writes a new label. Everything
that would let a follow-up, a peer agent, or a task notification rename the
tab is filtered out before any network call.

Runs the network call in a detached child so the hook returns instantly.

Overridable: TAB_NAME_API, TAB_NAME_MODEL, TAB_NAME_KEY, TAB_NAME_TIMEOUT.
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
API = os.environ.get("TAB_NAME_API", "http://127.0.0.1:8317/v1/chat/completions")
MODEL = os.environ.get("TAB_NAME_MODEL", "claude-haiku-4-5-20251001")
TIMEOUT = float(os.environ.get("TAB_NAME_TIMEOUT", "40"))
MAX_WORDS = 3
MAX_TOPIC = 300
MAX_TEXT = 6000                 # per message; a pasted log keeps its head and tail
FAIL_COOLDOWN = 120             # seconds before retrying the same pending human turn
TRANSCRIPT_GRACE = 0.5          # the transcript row can land just after the hook fires
INFLIGHT_TTL = 100              # a registered child older than this is presumed dead
MAX_ROUNDS = 3                  # re-asks after newer turns arrive mid-request


def api_key():
    key = os.environ.get("TAB_NAME_KEY")
    if key:
        return key
    try:
        with open(os.path.expanduser("~/.cli-proxy-api/local-key"), encoding="utf-8") as f:
            return f.read().strip() or "local"
    except OSError:
        return "local"


PROMPT = (
    "You maintain the name of a terminal tab where a user talks to a coding assistant. "
    "You receive the tab's current topic (if any), the message that started it, and the newest "
    "user messages. Decide whether the user moved to different work.\n"
    "\n"
    'Reply with ONE JSON object and nothing else: {"decision": ..., "name": ..., "topic": ...}\n'
    '- decision "same": the newest messages continue the current topic. Follow-ups, confirmations, '
    "corrections, small additions, and short replies are all \"same\". Then name and topic are empty strings.\n"
    '- decision "change": the user clearly moved to different work (a different bug, feature, area, or '
    "project). Then name is a label of at most three words and topic is one sentence describing the work.\n"
    '- decision "uncertain": there is no current topic yet and the message asks for nothing (a greeting, '
    "a thank-you, a bare acknowledgement). Then name and topic are empty strings.\n"
    "\n"
    "With no current topic, any actual request is a \"change\", however small.\n"
    "LANGUAGE RULE: the name must be in the same language as the user's messages. A Hebrew message gets "
    "a Hebrew name; never translate it. Product and tool names keep their spelling.\n"
    "Name shape: two words is the target, three is the maximum. Lowercase unless a proper noun. No quotes, "
    "no punctuation. No code fences around the JSON."
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


def note(session, current, raw, decision):
    """One line per decision. Without the raw answer, a tab that failed to get
    named is indistinguishable from one the model deliberately left alone."""
    try:
        with open(os.path.join(STATE, "autoname.log"), "a", encoding="utf-8") as f:
            f.write("[%s] %s current=%r raw=%r → %s\n" % (
                time.strftime("%H:%M:%S"), session[:8], current, (raw or "")[:120], decision))
    except OSError:
        pass


# ---- transcript -------------------------------------------------------------

def human_text(row):
    """The typed text of a genuinely human turn, else None."""
    if not isinstance(row, dict) or row.get("type") != "user":
        return None
    if row.get("isMeta") or row.get("isSidechain"):
        return None
    origin = row.get("origin")
    if origin is not None and (not isinstance(origin, dict) or origin.get("kind") != "human"):
        return None
    if origin is None and row.get("promptSource") not in (None, "typed"):
        return None
    if origin is None and row.get("userType") not in (None, "external"):
        return None
    content = (row.get("message") or {}).get("content")
    if isinstance(content, list):
        parts = [b.get("text", "") for b in content if isinstance(b, dict) and b.get("type") == "text"]
        content = "\n".join(parts)
    if not isinstance(content, str) or not content.strip():
        return None
    if origin is None and re.match(r"\s*<", content):
        return None                  # injected system/agent text without a human origin
    return content.strip()


def human_turns(path, after_uuid):
    """(uuid, text) of human turns newer than after_uuid, oldest first."""
    turns, found = [], not after_uuid
    try:
        with open(path, encoding="utf-8") as f:
            for line in f:
                try:
                    row = json.loads(line)
                except ValueError:
                    continue
                if not isinstance(row, dict):
                    continue
                if not found:
                    if row.get("uuid") == after_uuid:
                        found = True
                    continue
                text = human_text(row)
                if text is not None and isinstance(row.get("uuid"), str):
                    turns.append((row["uuid"], text))
    except OSError:
        return []
    if not found:
        # The anchor vanished (rotated transcript): treat everything as new.
        return human_turns(path, "") if after_uuid else turns
    return turns


def clip(text):
    if len(text) <= MAX_TEXT:
        return text
    half = MAX_TEXT // 2
    return text[:half] + "\n[... truncated %d characters ...]\n" % (len(text) - 2 * half) + text[-half:]


# ---- topic state --------------------------------------------------------------

def load_topic(path):
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def save_topic(path, data):
    atomic_write(path, json.dumps(data, ensure_ascii=False))


# ---- model ----------------------------------------------------------------------

def ask(current, topic, anchor, pending, retry_of=None):
    lines = ["Current tab name: %s" % (current or "(none yet — the tab is unnamed)"),
             "Current topic: %s" % (topic or "(none yet)")]
    if anchor:
        lines += ["", "Message that started the current topic:", clip(anchor)]
    lines += ["", "Newest user messages (oldest first):"]
    for text in pending:
        lines += ["---", clip(text)]
    messages = [{"role": "system", "content": PROMPT},
                {"role": "user", "content": "\n".join(lines)}]
    if retry_of is not None:
        messages += [{"role": "assistant", "content": retry_of},
                     {"role": "user", "content": "That is not a valid answer. Reply with only the JSON "
                                                 'object {"decision","name","topic"} and nothing else.'}]
    body = json.dumps({
        "model": MODEL,
        "max_tokens": 256,
        "temperature": 0,
        "stream": False,
        "messages": messages,
    }).encode("utf-8")
    req = urllib.request.Request(API, body, {"Content-Type": "application/json",
                                             "Authorization": "Bearer " + api_key()})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
        payload = json.load(r)
    choice = payload["choices"][0]
    if choice.get("finish_reason") not in (None, "stop", "end_turn"):
        return None                  # truncated: never trust a cut-off answer
    message = choice.get("message") or {}
    if message.get("refusal"):
        return None
    return message.get("content")


def parse(raw):
    """A verdict we would act on, or None. Fail closed on anything odd."""
    if not isinstance(raw, str):
        return None
    text = raw.strip()
    text = re.sub(r"^```[a-zA-Z]*\s*|\s*```$", "", text).strip()
    try:
        data = json.loads(text)
    except ValueError:
        return None
    if not isinstance(data, dict) or set(data) != {"decision", "name", "topic"}:
        return None
    decision, name, topic = data["decision"], data["name"], data["topic"]
    if decision not in ("same", "change", "uncertain"):
        return None
    if not isinstance(name, str) or not isinstance(topic, str):
        return None
    if decision != "change":
        return {"decision": decision, "name": "", "topic": sanitize(topic)[:MAX_TOPIC]}
    name = sanitize(name.strip().strip('"\'' + "`"))
    name = re.sub(r"[.,:;!?]+$", "", name).strip()
    topic = sanitize(topic)
    if not name or len(name.split()) > MAX_WORDS or len(name) > 32:
        return None
    if not topic or len(topic) > MAX_TOPIC:
        return None
    return {"decision": "change", "name": name, "topic": topic}


# ---- entry point ------------------------------------------------------------------

def main():
    child = [False]
    try:
        run(hook_from_stdin(), child)
    finally:
        if child[0]:
            os._exit(0)


def hook_from_stdin():
    try:
        hook = json.load(sys.stdin)
    except Exception:
        return None
    return hook if isinstance(hook, dict) else None


def run(hook, child):
    if hook is None:
        return
    session = hook.get("session_id") or ""
    transcript = hook.get("transcript_path") or ""
    if (not isinstance(session, str) or not re.fullmatch(r"[A-Za-z0-9_-]+", session)
            or not isinstance(transcript, str) or not transcript):
        return

    name_file = os.path.join(STATE, session + ".name")
    pin_file = os.path.join(STATE, session + ".pinned")
    live_file = os.path.join(STATE, session + ".state")
    generation_file = os.path.join(STATE, session + ".name-generation")
    lock_file = os.path.join(STATE, session + ".name.lock")
    topic_file = os.path.join(STATE, session + ".topic.json")
    generation = uuid.uuid4().hex

    # The transcript row for this prompt can land a moment after the hook fires.
    deadline = time.monotonic() + TRANSCRIPT_GRACE
    while True:
        saved = load_topic(topic_file)
        pending = human_turns(transcript, saved.get("last_processed_uuid") or "")
        if pending or time.monotonic() >= deadline:
            break
        time.sleep(0.02)
    if not pending:
        return

    failure = saved.get("failure") or {}
    signature = pending[-1][0]
    if failure.get("signature") == signature and time.time() < failure.get("retry_after", 0):
        return
    inflight = saved.get("inflight") or {}
    if (inflight.get("generation") and inflight["generation"] == read(generation_file)
            and time.time() - inflight.get("started", 0) < INFLIGHT_TTL):
        return                      # a child is already running; it re-reads new turns before committing

    try:
        # Register before detaching: child scheduling must not reorder prompts.
        # tn and session-end use this same persistent lock; never unlink it.
        with open(lock_file, "a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            if not os.path.exists(live_file) or os.path.exists(pin_file):
                return
            original = read(name_file)
            atomic_write(generation_file, generation)
            saved = load_topic(topic_file)
            saved["inflight"] = {"generation": generation, "started": time.time()}
            save_topic(topic_file, saved)
    except OSError:
        return
    placeholder = os.path.basename(hook.get("cwd") or os.getcwd())
    current = "" if original == placeholder else original

    # No lock is held across the slow network request.
    if os.fork() > 0:
        return
    child[0] = True
    os.setsid()
    null = os.open(os.devnull, os.O_RDWR)
    for fd in (0, 1, 2):
        os.dup2(null, fd)
    if null > 2:
        os.close(null)

    last_processed = saved.get("last_processed_uuid") or ""
    topic = saved.get("topic") or ""
    anchor = ""
    if saved.get("anchor_uuid"):
        for turn_uuid, text in human_turns(transcript, ""):
            if turn_uuid == saved["anchor_uuid"]:
                anchor = text
                break

    rounds, attempts, retry_of = 0, 0, None
    while True:
        signature = pending[-1][0]
        raw, verdict, failed = None, None, False
        try:
            raw = ask(current, topic, anchor, [text for _, text in pending], retry_of=retry_of)
            verdict = parse(raw)
        except Exception:
            failed = True
        attempts += 1
        if verdict is None and attempts < 2:
            # One more try; a turn that landed meanwhile joins the question.
            retry_of = None if failed else (raw or "")
            pending = human_turns(transcript, last_processed) or pending
            continue
        failed = verdict is None

        try:
            with open(lock_file, "a") as lock:
                fcntl.flock(lock, fcntl.LOCK_EX)
                if (not os.path.exists(live_file) or os.path.exists(pin_file)
                        or read(name_file) != original):
                    return                      # obsolete response, including its marker
                state = load_topic(topic_file)
                unprocessed = human_turns(transcript, state.get("last_processed_uuid") or "")
                if unprocessed and unprocessed[-1][0] != signature and rounds < MAX_ROUNDS:
                    # Newer human turns arrived during the request: this answer is stale.
                    rounds, attempts, retry_of = rounds + 1, 0, None
                    pending = unprocessed
                    generation = read(generation_file)      # adopt the newest registration
                    state["inflight"] = {"generation": generation, "started": time.time()}
                    save_topic(topic_file, state)
                    continue
                if read(generation_file) != generation:
                    return                      # tn or a reset took over the name
                state["inflight"] = None
                state["failure"] = None
                if failed:
                    state["failure"] = {"signature": signature,
                                        "retry_after": time.time() + FAIL_COOLDOWN}
                    state.setdefault("last_processed_uuid", last_processed)
                    save_topic(topic_file, state)
                    note(session, current, raw, "fail")
                    mark(session, "fail")
                    return
                state["last_processed_uuid"] = signature
                if verdict["decision"] == "change" and verdict["name"] != current:
                    state["topic"] = verdict["topic"]
                    state["anchor_uuid"] = pending[0][0]
                    save_topic(topic_file, state)
                    atomic_write(name_file, verdict["name"])
                    note(session, current, raw, "set " + verdict["name"])
                    mark(session, "ok")
                elif verdict["decision"] == "uncertain":
                    save_topic(topic_file, state)
                    note(session, current, raw, "none")
                    mark(session, "ok" if current else "none")
                else:
                    # "same" (or "change" to the identical label). Adopt the topic text
                    # when we had none, so a label set by hand still gets context.
                    if not state.get("topic") and verdict["topic"]:
                        state["topic"] = verdict["topic"]
                        state["anchor_uuid"] = pending[0][0]
                    save_topic(topic_file, state)
                    note(session, current, raw, "keep" if current else "none")
                    mark(session, "ok" if current else "none")
                return
        except OSError:
            return


def selftest():
    cases = [
        ('{"decision":"change","name":"auth bug","topic":"Fix login"}', ("change", "auth bug")),
        ('```json\n{"decision":"change","name":"auth bug","topic":"Fix login"}\n```', ("change", "auth bug")),
        ('{"decision":"same","name":"","topic":"Fix login"}', ("same", "")),
        ('{"decision":"uncertain","name":"","topic":""}', ("uncertain", "")),
        ('{"decision":"change","name":"a b c d","topic":"x"}', None),
        ('{"decision":"change","name":"auth bug","topic":""}', None),
        ('{"decision":"change","name":"auth bug","topic":"x","extra":1}', None),
        ('{"decision":"maybe","name":"auth bug","topic":"x"}', None),
        ("KEEP", None),
        ("", None),
    ]
    for raw, want in cases:
        got = parse(raw)
        got = (got["decision"], got["name"]) if got else None
        assert got == want, "parse(%r) = %r, expected %r" % (raw, got, want)
    print("tab-autoname selftest OK")


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        selftest()
    else:
        main()
