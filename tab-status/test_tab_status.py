#!/usr/bin/env python3
"""Regression checks; every terminal below is a private pseudoterminal."""
import importlib.util
import json
import os
from pathlib import Path
import pty
import select
import shutil
import subprocess
import tempfile
import time
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parent
SID = "test-session"
LEGACY_TN = r'''tn() {
  local state_dir="$HOME/.claude/terminal-state"
  mkdir -p "$state_dir"
  local tty_dev=$(ps -o tty= -p $$ 2>/dev/null | tr -d ' ')
  [ -n "$tty_dev" ] && [ "$tty_dev" != "??" ] || { echo "tn: no TTY" >&2; return 1; }
  if [ -z "$1" ]; then
    rm -f "$state_dir/tty.$tty_dev.name"
    printf '\033]0;\a'
  else
    echo "$1" > "$state_dir/tty.$tty_dev.name"
    printf '\033]0;🟢 %s\a' "$1"
  fi
}'''


def load_core():
    spec = importlib.util.spec_from_file_location("tab_state", ROOT / "tab-state.py")
    core = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(core)
    return core


def launch(agent="agent-one", call="call-one", stamp="2026-09-05T10:00:00Z"):
    return {"type": "user", "timestamp": stamp,
            "message": {"content": [{"type": "tool_result", "tool_use_id": call}]},
            "toolUseResult": {"isAsync": True, "status": "async_launched", "agentId": agent}}


def done(agent="agent-one", stamp="2026-09-05T10:01:00Z", status="completed"):
    return {"type": "queue-operation", "operation": "enqueue", "timestamp": stamp,
            "content": f"<task-notification>\n<task-id>{agent}</task-id>\n<status>{status}</status>\n<summary>Finished</summary>\n<result>Untrusted text</result>\n</task-notification>"}


class TerminalChecks(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.home = Path(self.tmp.name)
        self.state = self.home / ".claude/terminal-state"
        self.state.mkdir(parents=True)
        scripts = self.home / ".claude/scripts"
        shutil.copytree(ROOT, scripts, ignore=shutil.ignore_patterns("__pycache__"))
        self.transcript = self.home / ".claude/projects/demo" / (SID + ".jsonl")
        self.transcript.parent.mkdir(parents=True)
        self.transcript.write_text("")
        (self.state / (SID + ".transcript")).write_text(str(self.transcript))
        (self.state / (SID + ".state")).write_text("green\n")
        (self.state / (SID + ".name")).write_text("בדיקת נקודות\n")
        self.master, self.slave = pty.openpty()
        self.tty = os.ttyname(self.slave).removeprefix("/dev/")
        self.processes = []
        self.output = b""

    def tearDown(self):
        for proc in self.processes:
            proc.terminate()
            try:
                proc.communicate(timeout=3)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.communicate()
        os.close(self.master)
        os.close(self.slave)
        self.tmp.cleanup()

    def append(self, row):
        with self.transcript.open("a") as f:
            f.write(json.dumps(row) + "\n")

    def start(self):
        env = dict(os.environ, HOME=str(self.home))
        env.pop("CLAUDE_CONFIG_DIR", None)
        proc = subprocess.Popen(["bash", str(self.home / ".claude/scripts/tab-watcher.sh"),
                                 SID, self.tty, str(os.getpid())], env=env,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.processes.append(proc)
        return proc

    def collect(self, seconds=0.7):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            ready, _, _ = select.select([self.master], [], [], max(0, deadline-time.monotonic()))
            if ready:
                self.output += os.read(self.master, 65536)
        return self.output

    def titles(self):
        return [part.split(b"\a", 1)[0].decode() for part in self.output.split(b"\x1b]0;")[1:]]

    def test_active_agent_is_yellow_only(self):
        self.append(launch())
        # The old reader only knows turn-duration snapshots: even when it knows
        # an agent is active, it incorrectly appends yellow to green.
        self.append({"type": "system", "subtype": "turn_duration", "pendingBackgroundAgentCount": 1})
        self.start()
        self.collect()
        self.assertEqual(self.titles(), ["🟡 בדיקת נקודות"])

    def test_real_async_launch_without_background_flag_is_detected(self):
        self.append(launch())
        self.start()
        self.collect()
        self.assertEqual(self.titles(), ["🟡 בדיקת נקודות"])

    def test_unchanged_title_is_not_repainted(self):
        self.start()
        self.collect(1.2)
        self.assertEqual(self.titles(), ["🟢 בדיקת נקודות"])

    def test_two_agents_stay_yellow_until_last_completion(self):
        self.append(launch())
        self.append(launch("agent-two", "call-two"))
        self.start()
        self.collect()
        self.append(done())
        self.collect()
        self.assertEqual(self.titles(), ["🟡 בדיקת נקודות"])
        self.append(done("agent-two"))
        self.collect()
        self.assertEqual(self.titles(), ["🟡 בדיקת נקודות", "🟢 בדיקת נקודות"])

    def test_duplicate_watcher_has_no_second_writer(self):
        self.start()
        self.collect()
        second = self.start()
        self.collect()
        self.assertEqual(self.titles(), ["🟢 בדיקת נקודות"])
        self.assertIsNotNone(second.poll())

    def run_hook(self, core, action, data=None, tty=None):
        popen = core.subprocess.Popen
        def record_child(*args, **kwargs):
            proc = popen(*args, **kwargs)
            if proc not in self.processes:
                self.processes.append(proc)
            return proc
        with mock.patch.dict(os.environ, {"HOME": str(self.home)}), mock.patch.object(core.subprocess, "Popen", side_effect=record_child), mock.patch.object(core, "STATE", self.state), mock.patch.object(core, "terminal_owner", return_value=(tty or self.tty, os.getpid(), core.owner_identity(os.getpid()))):
            core.hook(action, {"session_id": SID, "transcript_path": str(self.transcript), **(data or {})})

    def test_hook_start_does_not_lock_out_its_child(self):
        core = load_core()
        popen = subprocess.Popen
        def start_and_schedule(*args, **kwargs):
            proc = popen(*args, **kwargs)
            self.processes.append(proc)
            self.collect(0.4)  # child runs before parent finishes its spawn path
            return proc
        with mock.patch.object(core.subprocess, "Popen", side_effect=start_and_schedule):
            self.run_hook(core, "refresh")
        self.collect(0.3)
        self.assertEqual(self.titles(), ["🟢 בדיקת נקודות"])

    def test_parent_stop_between_reads_does_not_flash_green(self):
        core = load_core()
        (self.state / (SID + ".state")).write_text("red\n")
        read = core.Transcript.read
        calls = []
        def interleave(tracker, path):
            available = read(tracker, path)
            if not calls:
                self.append(launch())
                (self.state / (SID + ".state")).write_text("green\n")
            calls.append(1)
            if len(calls) >= 3:
                (self.state / (SID + ".state")).unlink()
            return available
        with mock.patch.object(core, "STATE", self.state), mock.patch.object(core.Transcript, "read", interleave), mock.patch.object(core.signal, "signal"), mock.patch.object(core.time, "sleep"):
            core.watch(SID, self.tty, os.getpid())
        self.collect(0.1)
        self.assertEqual(self.titles(), ["🟡 בדיקת נקודות"])

    def test_same_session_moves_to_new_terminal_and_old_hooks_cannot_end_it(self):
        core = load_core()
        self.run_hook(core, "refresh")
        old_pid = int((self.state / (SID + ".watcher_pid")).read_text())
        self.collect()
        master2, slave2 = pty.openpty()
        tty2 = os.ttyname(slave2).removeprefix("/dev/")
        try:
            self.run_hook(core, "white", tty=tty2)
            ready, _, _ = select.select([master2], [], [], 2)
            received = os.read(master2, 4096) if ready else b""
            self.assertIn("⚪ בדיקת נקודות".encode(), received)
            self.run_hook(core, "session-end", tty=self.tty)
            self.assertTrue((self.state / (SID + ".state")).exists())
            self.run_hook(core, "session-end", tty=tty2)
        finally:
            # Only PIDs created in this private fixture, never live app watchers.
            for pid in {old_pid, int((self.state / (SID + ".watcher_pid")).read_text())}:
                try: os.kill(pid, 15)
                except ProcessLookupError: pass
            os.close(master2)
            os.close(slave2)

    def test_launch_hook_covers_delayed_transcript_after_parent_stop(self):
        core = load_core()
        self.run_hook(core, "working", {"tool_name": "Agent", "tool_use_id": "lagged", "tool_input": {}})
        self.run_hook(core, "green")
        self.collect()
        self.assertEqual(self.titles(), ["🟡 בדיקת נקודות"])
        self.run_hook(core, "tool-result", {"tool_name": "Agent", "tool_use_id": "lagged", "tool_response": {"isAsync": True, "agentId": "agent-lagged", "status": "async_launched"}})
        self.collect()
        self.assertEqual(self.titles(), ["🟡 בדיקת נקודות"])
        self.append(done("agent-lagged", stamp="2099-09-05T10:00:00Z"))
        self.collect()
        self.assertEqual(self.titles(), ["🟡 בדיקת נקודות", "🟢 בדיקת נקודות"])
        self.run_hook(core, "session-end")

    def stale_holder(self, name, pid):
        """A mapping pointing at a session whose process is long gone."""
        (self.state / f"tty.{self.tty}.session").write_text(name)
        (self.state / (name + ".state")).write_text("green\n")
        (self.state / (name + ".owner")).write_text(json.dumps([pid, "Mon Jan  1 00:00:00 2001 zsh", self.tty]))

    def test_dead_holder_does_not_keep_the_terminal_hostage(self):
        core = load_core()
        gone = subprocess.Popen(["true"])
        gone.wait()
        self.stale_holder("ghost-session", gone.pid)
        self.run_hook(core, "refresh")
        self.collect()
        self.assertEqual((self.state / f"tty.{self.tty}.session").read_text(), SID)
        self.assertEqual(self.titles(), ["🟢 בדיקת נקודות"])
        self.run_hook(core, "session-end")

    def test_live_holder_still_blocks_a_late_hook(self):
        core = load_core()
        self.stale_holder("other-session", os.getpid())
        (self.state / "other-session.owner").write_text(
            json.dumps([os.getpid(), core.owner_identity(os.getpid()), self.tty]))
        self.run_hook(core, "refresh")
        self.assertEqual((self.state / f"tty.{self.tty}.session").read_text(), "other-session")

    def test_unknown_state_is_not_green(self):
        (self.state / (SID + ".state")).write_text("")
        self.start()
        self.collect()
        self.assertEqual(self.titles(), ["⚪ בדיקת נקודות"])


class LifecycleChecks(unittest.TestCase):
    def setUp(self):
        self.core = load_core()
        self.tracker = self.core.Transcript()

    def feed(self, *rows):
        for row in rows:
            self.tracker.apply(row)

    def test_duplicate_completion_cannot_remove_other_agent(self):
        self.feed(launch(), launch("agent-two"), done(), done())
        self.assertEqual(self.tracker.agents, {"agent-two"})

    def test_old_snapshot_never_overrides_task_lifecycle(self):
        self.feed(launch(), {"type": "system", "subtype": "turn_duration", "pendingBackgroundAgentCount": 0})
        self.assertEqual(self.tracker.agents, {"agent-one"})
        self.feed(done(), {"type": "system", "subtype": "turn_duration", "pendingBackgroundAgentCount": 10})
        self.assertEqual(self.tracker.agents, set())

    def test_stop_hook_is_not_terminal_completion(self):
        self.feed(launch(), {"type": "system", "subtype": "hook", "hookEvent": "SubagentStop", "agentId": "agent-one"})
        self.assertEqual(self.tracker.agents, {"agent-one"})

    def test_user_text_cannot_forge_completion(self):
        self.feed(launch(), {"type": "user", "message": {"content": done()["content"]}})
        self.assertEqual(self.tracker.agents, {"agent-one"})

    def test_completion_before_delayed_launch_result_stays_complete(self):
        self.feed(done(), launch())
        self.assertEqual(self.tracker.agents, set())

    def test_delayed_launch_identity_can_still_be_resumed(self):
        self.feed(done(), launch())
        self.feed({"type": "assistant", "timestamp": "2026-09-05T10:02:00Z", "message": {"content": [
            {"type": "tool_use", "id": "resume", "name": "SendMessage", "input": {"to": "agent-one", "message": "Continue"}}]}})
        self.feed({"type": "user", "timestamp": "2026-09-05T10:02:01Z", "message": {"content": [
            {"type": "tool_result", "tool_use_id": "resume"}]}, "toolUseResult": {"success": True, "pin": {"id": "agent-one"}}})
        self.assertEqual(self.tracker.agents, {"agent-one"})

    def test_resumed_agent_ignores_old_completion(self):
        self.feed(launch(), done())
        self.feed({"type": "assistant", "timestamp": "2026-09-05T10:02:00Z", "message": {"content": [
            {"type": "tool_use", "id": "resume", "name": "SendMessage", "input": {"to": "agent-one", "message": "Continue"}}]}})
        self.feed({"type": "user", "timestamp": "2026-09-05T10:02:01Z", "message": {"content": [
            {"type": "tool_result", "tool_use_id": "resume"}]}, "toolUseResult": {"success": True, "pin": {"id": "agent-one"}}})
        self.feed(done())
        self.assertEqual(self.tracker.agents, {"agent-one"})
        self.feed(done(stamp="2026-09-05T10:03:00Z"))
        self.assertEqual(self.tracker.agents, set())

    def test_failed_agent_launch_clears_launch_indicator(self):
        self.feed({"type": "assistant", "message": {"content": [{"type": "tool_use", "id": "call", "name": "Agent", "input": {}}]}})
        self.assertTrue(self.tracker.busy)
        self.feed({"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": "call", "is_error": True}]}})
        self.assertFalse(self.tracker.busy)

    def test_yellow_wins_in_every_foreground_state(self):
        for state in ("white", "red", "blue", "green", "", "invalid"):
            self.assertEqual(self.core.badge(state, True, True, True, True), "🟡")

    def test_partial_transcript_line_is_retried_and_old_history_retained(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp) / "session.jsonl"
            p.write_text(json.dumps(launch()) + "\n" + json.dumps({"type": "irrelevant", "padding": "x" * 300000}) + "\n")
            self.tracker.read(p)
            self.assertEqual(self.tracker.agents, {"agent-one"})
            row = json.dumps(done())
            with p.open("a") as f: f.write(row[:20])
            self.tracker.read(p)
            self.assertEqual(self.tracker.agents, {"agent-one"})
            with p.open("a") as f: f.write(row[20:] + "\n")
            self.tracker.read(p)
            self.assertEqual(self.tracker.agents, set())


@unittest.skipUnless((ROOT.parent / "install.sh").exists(), "installer is repository-only")
class MigrationChecks(unittest.TestCase):
    def test_legacy_shell_command_delegates_without_writing_a_title(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            (home / ".zshrc").write_text("# keep before\n" + LEGACY_TN + "\n# keep after\n")
            env = dict(os.environ, HOME=tmp)
            installed = subprocess.run(["bash", str(ROOT.parent / "install.sh")], env=env,
                                       input="y\ny\n" + "n\n" * 20, text=True, capture_output=True, timeout=20)
            self.assertEqual(installed.returncode, 0, installed.stderr)
            # Observe the wrapper's boundary: it must forward intact arguments
            # to the naming command, not paint its own green title.
            command = home / ".claude/scripts/tn"
            command.write_text('#!/bin/sh\nprintf "forwarded:%s" "$1"\n')
            result = subprocess.run(["zsh", "-f", "-c", 'source "$HOME/.zshrc"; tn "test name"'],
                                    env=env, text=True, capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout, "forwarded:test name")
            self.assertIn("# keep before", (home / ".zshrc").read_text())
            self.assertIn("# keep after", (home / ".zshrc").read_text())

    def test_reinstall_replaces_only_owned_hooks_in_both_profiles(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            original = {"model": "keep-my-model", "env": {"KEEP_ME": "yes"}, "hooks": {
                "PreToolUse": [{"matcher": "Agent", "hooks": [
                    {"type": "command", "command": "$HOME/.claude/scripts/tab.sh bg-inc"},
                    {"type": "command", "command": "keep-unrelated-hook"}]}],
                "SubagentStop": [{"hooks": [{"type": "command", "command": "$HOME/.claude/scripts/tab.sh bg-dec"}]}]}}
            profiles = [home / folder / "settings.json" for folder in (".claude", ".claude-ccx")]
            for p in profiles:
                p.parent.mkdir(parents=True)
                p.write_text(json.dumps(original))
            env = dict(os.environ, HOME=tmp, CLAUDE_CONFIG_DIR=str(home / ".claude-ccx"))
            for _ in range(2):
                result = subprocess.run(["bash", str(ROOT.parent / "install.sh")], env=env,
                                        input="y\n" + "n\n" * 20, text=True, capture_output=True, timeout=20)
                self.assertEqual(result.returncode, 0, result.stderr)
            for p in profiles:
                data = json.loads(p.read_text())
                commands = [h["command"] for entries in data["hooks"].values() for entry in entries for h in entry["hooks"]]
                self.assertNotIn("$HOME/.claude/scripts/tab.sh bg-inc", commands)
                self.assertNotIn("$HOME/.claude/scripts/tab.sh bg-dec", commands)
                self.assertEqual(commands.count("keep-unrelated-hook"), 1)
                self.assertEqual(commands.count("$HOME/.claude/scripts/tab.sh working"), 1)
                self.assertEqual(data["model"], "keep-my-model")
                self.assertEqual(data["env"]["KEEP_ME"], "yes")
                self.assertEqual(data["env"]["CLAUDE_CODE_DISABLE_TERMINAL_TITLE"], "1")
                self.assertFalse(data["terminalProgressBarEnabled"])
            result = subprocess.run(["bash", str(home / ".claude/scripts/tab.sh"), "remind-name"],
                                    env=env, input=json.dumps({"session_id": SID}), capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == "__main__":
    unittest.main()
