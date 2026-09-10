#!/usr/bin/env python3
"""One title writer per session; task completion comes from runtime notifications.

SubagentStop is deliberately not completion: a stop hook can be blocked and
helper agents emit it too. Read structured launch results and queued terminal
notifications instead. The main transcript is replayed once, then tailed.
"""
import contextlib
import datetime
import fcntl
import json
import os
from pathlib import Path
import re
import signal
import stat
import subprocess
import sys
import tempfile
import time
import unicodedata

STATE = Path.home() / ".claude/terminal-state"
DOTS = "⚪🔴🔵🟢🟡🟤🟠🟣"
TERMINAL = {"completed", "failed", "cancelled", "canceled", "killed", "stopped", "timeout", "timed_out"}


def valid_id(value):
    return isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9_-]{1,160}", value) is not None


def text(path, default=""):
    try:
        return Path(path).read_text(encoding="utf-8").strip()
    except (OSError, UnicodeError):
        return default


def json_file(path, default):
    try:
        return json.loads(text(path))
    except (ValueError, TypeError):
        return default


def atomic(path, value):
    path = Path(path)
    fd, tmp = tempfile.mkstemp(prefix="." + path.name, dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(value)
        os.replace(tmp, path)
    finally:
        with contextlib.suppress(FileNotFoundError):
            os.unlink(tmp)


@contextlib.contextmanager
def locked(path, nonblocking=False):
    with open(path, "a") as f:
        fcntl.flock(f, fcntl.LOCK_EX | (fcntl.LOCK_NB if nonblocking else 0))
        yield


def safe_name(value):
    return " ".join("".join(c for c in value if c not in DOTS and not unicodedata.category(c).startswith("C")).split())[:80] or "claude"


def badge(state, agents=False, shells=False, plan=False, waiting=False):
    if agents:
        return "🟡"
    if waiting:
        return "🟠"
    if state == "blue":
        return "🔵"
    if plan and state == "red":
        return "🟣"
    if state == "red":
        return "🔴"
    if shells:
        return "🟤"
    return {"green": "🟢", "white": "⚪"}.get(state, "⚪")


class Transcript:
    def __init__(self):
        self.offset = 0
        self.identity = None
        self.agents = set()
        self.shells = set()
        self.known_agents = set()
        self.changes = {}
        self.calls = {}
        self.resolved_calls = set()
        self.launching = set()
        self.plan = False
        self.order = 0
        self.ready = False

    @property
    def busy(self):
        return bool(self.agents or self.launching)

    def change(self, task, running, stamp, shell=False):
        if not valid_id(task) or stamp < self.changes.get(task, float("-inf")):
            return
        self.changes[task] = stamp
        if shell:
            if running:
                self.shells.add(task)
            else:
                self.shells.discard(task)
        elif running:
            self.known_agents.add(task)
            self.agents.add(task)
        else:
            self.agents.discard(task)
            self.shells.discard(task)

    def apply(self, row):
        if not isinstance(row, dict) or row.get("isSidechain"):
            return
        self.order += 1
        try:
            stamp = datetime.datetime.fromisoformat(row.get("timestamp", "").replace("Z", "+00:00")).timestamp()
        except (ValueError, AttributeError):
            stamp = float(self.order)
        kind = row.get("type")
        if kind == "permission-mode":
            self.plan = row.get("permissionMode") == "plan"
        if kind == "queue-operation" and row.get("operation") == "enqueue":
            content = row.get("content")
            # Only runtime queue metadata, never text in user/assistant messages.
            # Stop before result/summary content, which can contain arbitrary XML.
            if isinstance(content, str) and content.startswith("<task-notification>\n"):
                header = re.split(r"<(?:summary|result|note)>", content, maxsplit=1)[0]
                task = re.search(r"<task-id>([A-Za-z0-9_-]+)</task-id>", header)
                status = re.search(r"<status>([a-z_]+)</status>", header)
                call = re.search(r"<tool-use-id>([A-Za-z0-9_-]+)</tool-use-id>", header)
                if task and status and status[1] in TERMINAL:
                    self.change(task[1], False, stamp)
                    if call:
                        self.launching.discard(call[1])
                        self.resolved_calls.add(call[1])
            return
        message = row.get("message")
        blocks = message.get("content", []) if isinstance(message, dict) else []
        if not isinstance(blocks, list):
            return
        result = row.get("toolUseResult")
        for block in blocks:
            if not isinstance(block, dict):
                continue
            if kind == "assistant" and block.get("type") == "tool_use":
                tool = block.get("name")
                call = block.get("id")
                if tool in ("Agent", "Task", "SendMessage", "TaskStop", "Bash") and valid_id(call):
                    inputs = block.get("input")
                    self.calls[call] = (tool, inputs if isinstance(inputs, dict) else {}, stamp)
                    if tool in ("Agent", "Task"):
                        self.launching.add(call)
            if kind != "user" or block.get("type") != "tool_result":
                continue
            call = block.get("tool_use_id")
            if not valid_id(call):
                continue
            self.resolved_calls.add(call)
            self.launching.discard(call)
            tool, inputs, started = self.calls.pop(call, (None, {}, stamp))
            if block.get("is_error") or not isinstance(result, dict):
                continue
            agent = result.get("agentId")
            if valid_id(agent) and (result.get("isAsync") is True or result.get("status") == "async_launched"):
                self.known_agents.add(agent)
                self.change(agent, True, started)
            elif tool == "SendMessage" and result.get("success") is True and inputs.get("message"):
                pin = result.get("pin")
                target = pin.get("id") if isinstance(pin, dict) else inputs.get("to")
                if target in self.known_agents:
                    self.change(target, True, started)
            elif tool == "TaskStop" and not result.get("error"):
                target = result.get("task_id") or inputs.get("task_id")
                if result.get("success") is True or str(result.get("message", "")).startswith("Successfully stopped"):
                    self.change(target, False, stamp)
            elif tool == "Bash" and valid_id(result.get("backgroundTaskId")):
                self.change(result["backgroundTaskId"], True, started, shell=True)

    def hints(self, values):
        if not isinstance(values, dict):
            return
        for call, item in values.items():
            if not valid_id(call) or not isinstance(item, dict):
                continue
            agent = item.get("agent")
            resume = item.get("resume", False)
            if valid_id(agent) and (not resume or agent in self.known_agents):
                self.known_agents.add(agent)
                self.change(agent, True, item.get("started", 0))
            if item.get("pending") and call not in self.resolved_calls and (not resume or item.get("target") in self.known_agents):
                self.launching.add(call)
            else:
                self.launching.discard(call)

    def read(self, path):
        try:
            with Path(path).open("rb") as f:
                info = os.fstat(f.fileno())
                identity = (info.st_dev, info.st_ino)
                if self.identity != identity or info.st_size < self.offset:
                    self.__init__()
                    self.identity = identity
                f.seek(self.offset)
                while True:
                    line = f.readline()
                    if not line or not line.endswith(b"\n"):
                        break
                    self.offset = f.tell()
                    try:
                        self.apply(json.loads(line))
                    except (ValueError, UnicodeError):
                        continue
                self.ready = True
                return True
        except OSError:
            return False  # missing/in-flight transcript is not evidence of idle


def process(pid, columns):
    try:
        return subprocess.check_output(["ps", "-p", str(pid), "-o", columns], text=True, stderr=subprocess.DEVNULL, timeout=2).strip()
    except (subprocess.SubprocessError, OSError):
        return ""


TASK_END = re.compile(rb"\[(?:exited with code -?\d+|killed)\]\s*$")


def tasks_dir(sid, _cache={}):
    """Where the runtime streams this session's background-task output."""
    found, checked = _cache.get(sid, ("", 0.0))
    if found or (checked and time.monotonic() - checked < 30):
        return found
    for base in (os.environ.get("TMPDIR"), "/private/tmp", "/tmp"):
        if not base:
            continue
        for path in Path(base).glob(f"claude-*/*/{sid}/tasks"):
            found = path
            break
        if found:
            break
    _cache[sid] = (found, time.monotonic())
    return found


def shell_running(sid, task, _finished=set()):
    """Brown needs proof: an output file that has not reached its exit marker.

    A background shell often ends with no completion notification at all - a
    foreground command that the two-minute timeout pushes into the background
    almost never sends one - so trusting the transcript alone leaves the dot
    brown for the rest of the session. No file means nothing is running.
    """
    if not valid_id(task) or (sid, task) in _finished:
        return False
    directory = tasks_dir(sid)
    running = False
    if directory:
        try:
            with open(Path(directory) / f"{task}.output", "rb") as f:
                f.seek(max(0, os.fstat(f.fileno()).st_size - 200))
                running = not TASK_END.search(f.read().rstrip())
        except OSError:
            running = False
    if not running:
        _finished.add((sid, task))
    return running


def owner_identity(pid):
    return process(pid, "lstart=,comm=")


def terminal_owner():
    pid = os.getppid()
    for _ in range(12):
        tty = process(pid, "tty=")
        if tty and tty not in ("??", "?", "-"):
            return tty, pid, owner_identity(pid)
        parent = process(pid, "ppid=")
        if not parent.isdigit() or int(parent) < 2:
            break
        pid = int(parent)
    return None


def holds_terminal(sid):
    """A tty->session mapping only holds the terminal while that session lives.

    Without this a session that died without its session-end hook keeps the
    mapping forever: the next session in that terminal never claims it, so its
    watcher never paints and `tn` writes the name onto the corpse.
    """
    if not valid_id(sid) or not (STATE / f"{sid}.state").exists():
        return False
    owner = json_file(STATE / f"{sid}.owner", None)
    # The mapping and the owner are written under one lock, so a holder without
    # a live owner recorded is gone, not mid-claim.
    return (isinstance(owner, list) and len(owner) == 3
            and owner_identity(owner[0]) == owner[1])


def tty_key(tty):
    if re.fullmatch(r"(?:ttys?\d+|pts/\d+|tty[A-Za-z]+\d+)", tty or ""):
        return tty.replace("/", "_")
    raise ValueError("invalid terminal device")


def launch_hint(prefix, action, data):
    tool, call = data.get("tool_name"), data.get("tool_use_id")
    if tool not in ("Agent", "Task", "SendMessage") or not valid_id(call):
        return
    inputs = data.get("tool_input") or {}
    inputs = inputs if isinstance(inputs, dict) else {}
    path = prefix.with_suffix(".launches")
    hints = json_file(path, {})
    hints = hints if isinstance(hints, dict) else {}
    if action == "working":
        if tool == "SendMessage" and not inputs.get("message"):
            return
        hints.setdefault(call, {"started": time.time(), "pending": True, "resume": tool == "SendMessage",
                                "target": inputs.get("to") if isinstance(inputs.get("to"), str) else ""})
    elif action in ("tool-result", "tool-error"):
        if tool == "SendMessage" and call not in hints:
            return
        item = hints.setdefault(call, {"started": 0})
        item["pending"] = False
        result = data.get("tool_response") or {}
        if action == "tool-result" and isinstance(result, dict):
            if result.get("isAsync") is True or result.get("status") == "async_launched":
                item["agent"] = result.get("agentId")
            elif tool == "SendMessage" and result.get("success") is True:
                pin = result.get("pin")
                if isinstance(pin, dict):
                    item["agent"] = pin.get("id")
    else:
        return
    atomic(path, json.dumps(hints))


def hook(action, data):
    sid = data.get("session_id")
    if not valid_id(sid) or data.get("agent_id"):
        return  # subagent tools must not change the parent foreground state
    STATE.mkdir(parents=True, exist_ok=True)
    prefix = STATE / sid
    state_file = prefix.with_suffix(".state")
    ended = prefix.with_suffix(".ended")
    with locked(prefix.with_suffix(".lock")):
        if action != "white" and ended.exists():
            return
        owner = terminal_owner()
        recorded_owner = json_file(prefix.with_suffix(".owner"), None)
        if action != "white" and recorded_owner:
            if not owner or recorded_owner != [owner[1], owner[2], owner[0]]:
                return  # old hooks cannot edit or end a resumed session
        launch_hint(prefix, action, data)
        if action == "session-end":
            with locked(prefix.with_suffix(".name.lock")):
                atomic(ended, "ended\n")
                for suffix in (".state", ".name", ".name-generation", ".pinned", ".namer", ".plan_wait", ".bg", ".bg_hint", ".launches"):
                    prefix.with_suffix(suffix).unlink(missing_ok=True)
            return  # no PID killing; watcher sees liveness disappear
        if action == "remind-name":
            return  # naming is automatic; no competing assistant rename loop
        if action == "white":
            ended.unlink(missing_ok=True)
            atomic(state_file, "white\n")
            prefix.with_suffix(".plan_wait").unlink(missing_ok=True)
        elif action in ("red", "blue"):
            atomic(state_file, action + "\n")
            if action == "red":
                prefix.with_suffix(".plan_wait").unlink(missing_ok=True)
        elif action == "working":
            if text(state_file) != "blue" and not prefix.with_suffix(".plan_wait").exists():
                atomic(state_file, "red\n")
        elif action == "green":
            if text(state_file) != "blue":
                atomic(state_file, "green\n")
        elif action == "failure":
            atomic(state_file, "white\n")
        elif action == "plan-wait":
            atomic(prefix.with_suffix(".plan_wait"), "waiting\n")
        elif action == "plan-done":
            prefix.with_suffix(".plan_wait").unlink(missing_ok=True)
        elif action not in ("bg-inc", "bg-dec", "refresh", "tool-result", "tool-error"):
            return
        transcript = data.get("transcript_path")
        if isinstance(transcript, str) and os.path.isabs(transcript):
            atomic(prefix.with_suffix(".transcript"), transcript)
        if not owner or not state_file.exists():
            return
        tty, pid, identity = owner
        key = tty_key(tty)
        mapping = STATE / f"tty.{key}.session"
        with locked(STATE / f"tty.{key}.lock"):
            current = text(mapping)
            if current and current != sid and action != "white" and holds_terminal(current):
                return  # a late hook must not steal a reused terminal
            atomic(mapping, sid)
            atomic(prefix.with_suffix(".owner"), json.dumps([pid, identity, tty]))
        with locked(prefix.with_suffix(".name.lock")):
            name = prefix.with_suffix(".name")
            if not name.exists():
                atomic(name, Path(data.get("cwd") or os.getcwd()).name + "\n")
        try:
            with locked(STATE / f"{sid}.watch.{key}.lock", nonblocking=True):
                pass
        except BlockingIOError:
            return
        # The child must acquire this lock itself, not race a lock held by us.
        child = subprocess.Popen([sys.executable, str(Path(__file__).resolve()), "watch", sid, tty, str(pid)],
                                 stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                 start_new_session=True)
        atomic(prefix.with_suffix(".watcher_pid"), str(child.pid))


def watch(sid, tty, pid):
    if not valid_id(sid):
        raise ValueError("invalid session")
    key = tty_key(tty)
    device = Path("/dev") / tty
    if not stat.S_ISCHR(device.stat().st_mode):
        raise ValueError("not a terminal")
    STATE.mkdir(parents=True, exist_ok=True)
    prefix = STATE / sid
    mapping = STATE / f"tty.{key}.session"
    identity = owner_identity(pid)
    if not identity:
        return
    try:
        with locked(STATE / f"{sid}.watch.{key}.lock", nonblocking=True):
            with locked(STATE / f"tty.{key}.lock"):
                current = text(mapping)
                if current and current != sid and holds_terminal(current):
                    return
                atomic(mapping, sid)
            tracker = Transcript()
            last_title = None
            last_state = "white"
            last_owner_check = 0
            signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
            signal.signal(signal.SIGINT, lambda *_: sys.exit(0))
            while prefix.with_suffix(".state").exists() and not prefix.with_suffix(".ended").exists():
                recorded_owner = json_file(prefix.with_suffix(".owner"), None)
                if isinstance(recorded_owner, list) and len(recorded_owner) == 3:
                    if recorded_owner[2] != tty:
                        return  # the replacement TTY has its own writer lock
                    if recorded_owner[:2] != [pid, identity]:
                        pid, identity = recorded_owner[:2]
                        last_owner_check = 0  # same TTY, new process: hand off in place
                if time.monotonic() - last_owner_check >= 1:
                    if owner_identity(pid) != identity:
                        return
                    last_owner_check = time.monotonic()
                value = text(prefix.with_suffix(".state"))
                path = text(prefix.with_suffix(".transcript"))
                available = tracker.read(path) if path else False
                with locked(prefix.with_suffix(".lock")):
                    if text(prefix.with_suffix(".state")) != value:
                        continue  # never combine pre-launch history with post-stop state
                    if not prefix.with_suffix(".state").exists():
                        return
                    tracker.hints(json_file(prefix.with_suffix(".launches"), {}))
                    if value in ("white", "red", "blue", "green"):
                        last_state = value
                    state = last_state if available or last_state != "green" else "white"
                    shells = any(shell_running(sid, task) for task in tracker.shells)
                    dot = badge(state, tracker.busy, shells, tracker.plan, prefix.with_suffix(".plan_wait").exists())
                    title = dot + " " + safe_name(text(prefix.with_suffix(".name"), "claude"))
                    with locked(STATE / f"tty.{key}.lock"):
                        if text(mapping) != sid:
                            return
                        if title != last_title:
                            try:
                                fd = os.open(device, os.O_WRONLY | os.O_NOCTTY | os.O_NONBLOCK)
                                try:
                                    payload = ("\033]0;" + title + "\a").encode()
                                    if os.write(fd, payload) != len(payload):
                                        raise OSError("short title write")
                                finally:
                                    os.close(fd)
                            except OSError:
                                pass  # keep last_title unchanged, so next tick retries
                            else:
                                last_title = title
                time.sleep(0.2)
    except BlockingIOError:
        return


def main():
    if len(sys.argv) >= 3 and sys.argv[1] == "hook":
        data = json.load(sys.stdin)
        if isinstance(data, dict):
            hook(sys.argv[2], data)
    elif len(sys.argv) >= 4 and sys.argv[1] == "watch":
        watch(sys.argv[2], sys.argv[3], int(sys.argv[4]) if len(sys.argv) > 4 else os.getppid())


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, TypeError) as exc:
        print(f"tab-status: {exc}", file=sys.stderr)
        sys.exit(1)
