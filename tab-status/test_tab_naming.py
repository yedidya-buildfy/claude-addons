#!/usr/bin/env python3
"""Naming regressions: real state/entrypoints, isolated HOME, no naming API or fork."""
import contextlib
import fcntl
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent


class NamingTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name)
        self.env = patch.dict(os.environ, {"HOME": str(self.home)})
        self.env.start()
        self.addCleanup(self.env.stop)
        self.state = self.home / ".claude/terminal-state"
        self.state.mkdir(parents=True)
        self.project = self.home / "project"
        self.project.mkdir()
        self.name = self.state / "session-1.name"
        self.live = self.state / "session-1.state"
        self.pin = self.state / "session-1.pinned"
        self.marker = self.state / "session-1.namer"
        self.topic = self.state / "session-1.topic.json"
        self.transcript = self.home / "transcript.jsonl"
        self.transcript.touch()
        self.requests = []
        self.human_count = 0
        self.name.write_text("project\n")
        self.live.write_text("busy\n")
        (self.state / "tty.ttys-test.session").write_text("session-1\n")
        spec = importlib.util.spec_from_file_location("namer_under_test", ROOT / "tab-autoname.py")
        self.namer = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.namer)
        # Only external process lookup is faked: force the real PPID walk.
        bin_dir = self.home / "bin"
        bin_dir.mkdir()
        ps = bin_dir / "ps"
        ps.write_text(f"#!{sys.executable}\nimport sys\n"
                      "print('123456' if sys.argv[2] == 'ppid=' else "
                      "('ttys-test' if sys.argv[-1] == '123456' else '??'))\n")
        ps.chmod(0o755)
        os.environ["PATH"] = str(bin_dir) + os.pathsep + os.environ["PATH"]

    def row(self, value):
        with self.transcript.open("a") as stream:
            stream.write(json.dumps(value, ensure_ascii=False) + "\n")

    def human(self, text, **extra):
        self.human_count += 1
        value = {"type": "user", "origin": {"kind": "human"}, "promptSource": "typed",
                 "uuid": f"human-{self.human_count}", "timestamp": "2026-09-05T10:00:00Z",
                 "message": {"content": text}}
        value.update(extra)
        self.row(value)
        return value["uuid"]

    def auto(self, response="new topic", during=None, prompt="fix something", hook_extra=None):
        responses = iter(response) if isinstance(response, list) else None
        callback = during
        if prompt is not None:
            self.human(prompt)

        def reply(request, **kwargs):
            nonlocal callback
            self.requests.append(json.loads(request.data))
            self.assertEqual(request.get_header("Authorization"), "Bearer local")
            self.assertGreater(kwargs["timeout"], 0)
            self.assertLessEqual(kwargs["timeout"], 40)
            if callback:
                fn, callback = callback, None
                fn()
            text = next(responses) if responses is not None else response
            if isinstance(text, Exception):
                raise text
            if isinstance(text, dict) and "choices" in text:
                payload = text
            else:
                if isinstance(text, str):
                    text = {"decision": "same" if text == "KEEP" else
                            "uncertain" if text == "NONE" else "change",
                            "name": "" if text in ("KEEP", "NONE") else text,
                            "topic": "" if text == "NONE" else "Repair the current application problem"}
                payload = {"choices": [{"finish_reason": "stop", "message": {
                    "content": json.dumps(text, ensure_ascii=False)}}]}
            return io.BytesIO(json.dumps(payload).encode())

        hook = {"session_id": "session-1", "prompt": "untrusted hook payload",
                "cwd": str(self.project), "transcript_path": str(self.transcript)}
        hook.update(hook_extra or {})
        with contextlib.ExitStack() as stack:
            stack.enter_context(patch.object(sys, "stdin", io.StringIO(json.dumps(hook))))
            stack.enter_context(patch.object(self.namer.urllib.request, "urlopen", side_effect=reply))
            # Run the actual detached branch synchronously without altering this test process.
            stack.enter_context(patch.object(self.namer.os, "fork", return_value=0))
            stack.enter_context(patch.object(self.namer.os, "setsid"))
            stack.enter_context(patch.object(self.namer.os, "dup2"))
            stack.enter_context(patch.object(self.namer.os, "_exit", side_effect=SystemExit(0)))
            try:
                self.namer.main()
            except SystemExit as exc:
                self.assertEqual(exc.code, 0)

    def tn(self, *args):
        result = subprocess.run([str(ROOT / "tn"), *args], cwd=self.project,
                                capture_output=True, text=True, timeout=5)
        self.assertEqual(result.returncode, 0, result.stderr)
        return result

    def test_older_answer_cannot_override_newer_answer(self):
        self.auto(["old topic", "new topic"],
                  during=lambda: self.auto("new topic", prompt="new task"))
        self.assertEqual(self.name.read_text(), "new topic\n")

    def test_newer_keep_still_invalidates_older_answer(self):
        self.auto(["old topic", "NONE"],
                  during=lambda: self.auto("NONE", prompt="never mind"))
        self.assertEqual(self.name.read_text(), "project\n")

    def test_manual_pin_during_network_wins(self):
        self.auto(during=lambda: self.tn("בחירה שלי"))
        self.assertEqual(self.name.read_text(), "בחירה שלי\n")
        self.assertTrue(self.pin.exists())

    def test_reset_to_same_placeholder_invalidates_answer(self):
        self.auto(during=lambda: self.tn())
        self.assertEqual(self.name.read_text(), "project\n")
        self.assertFalse(self.pin.exists())

    def test_manual_name_then_reset_invalidates_answer(self):
        def reset():
            self.tn("manual name")
            self.tn()
        self.auto(during=reset)
        self.assertEqual(self.name.read_text(), "project\n")

    def test_changed_current_name_is_not_overwritten(self):
        self.auto(during=lambda: self.name.write_text("another name\n"))
        self.assertEqual(self.name.read_text(), "another name\n")

    def test_session_end_during_network_does_not_recreate_files(self):
        def end():
            self.live.unlink()
            self.name.unlink()
        self.auto(during=end)
        self.assertFalse(self.name.exists())
        self.assertFalse(self.marker.exists())

    def test_stale_failure_does_not_replace_newer_success_marker(self):
        self.auto([OSError("offline"), "latest topic"],
                  during=lambda: self.auto("latest topic"))
        self.assertEqual(self.marker.read_text(), "ok\n")
        self.assertEqual(self.name.read_text(), "latest topic\n")

    def test_missing_session_does_not_write_name(self):
        self.live.unlink()
        self.name.unlink()
        self.auto()
        self.assertFalse(self.name.exists())
        self.assertFalse(self.marker.exists())

    def test_auto_command_honors_pin(self):
        self.tn("manual name")
        self.tn("--auto", "automatic name")
        self.assertEqual(self.name.read_text(), "manual name\n")
        self.assertTrue(self.pin.exists())

    def test_auto_clear_honors_pin(self):
        self.tn("manual name")
        self.tn("--auto")
        self.assertEqual(self.name.read_text(), "manual name\n")
        self.assertTrue(self.pin.exists())

    def test_manual_write_is_atomic_for_existing_reader(self):
        with self.name.open() as old:
            self.tn("manual name")
            self.assertEqual(old.read(), "project\n")
        self.assertEqual(self.name.read_text(), "manual name\n")

    def test_automatic_write_is_atomic_for_existing_reader(self):
        with self.name.open() as old:
            self.auto()
            self.assertEqual(old.read(), "project\n")
        self.assertEqual(self.name.read_text(), "new topic\n")

    def test_manual_command_waits_for_shared_name_lock(self):
        with (self.state / "session-1.name.lock").open("a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            process = subprocess.Popen([str(ROOT / "tn"), "manual name"], cwd=self.project,
                                       stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            try:
                with self.assertRaises(subprocess.TimeoutExpired):
                    process.communicate(timeout=0.25)
                self.assertEqual(self.name.read_text(), "project\n")
            finally:
                fcntl.flock(lock, fcntl.LOCK_UN)
                stdout, stderr = process.communicate(timeout=5)
            self.assertEqual(process.returncode, 0, stderr)
        self.assertEqual(self.name.read_text(), "manual name\n")

    def test_generated_label_removes_badges_and_controls_preserving_hebrew(self):
        self.auto("🟢 🔴 \x1b[31mתיקון\x1b[0m\x07 באג‮")
        self.assertEqual(self.name.read_text(), "תיקון באג\n")

    def test_manual_label_removes_badges_and_terminal_escape_sequences(self):
        self.tn("🟢 🔴 \x1b]0;injected title\x07תיקון\nבאג‮")
        self.assertEqual(self.name.read_text(), "תיקון באג\n")

    def test_retry_and_hebrew_still_work(self):
        self.auto(["This answer has too many words", "תיקון הרשאות"])
        self.assertEqual(self.name.read_text(), "תיקון הרשאות\n")

    def test_new_prompt_invalidates_old_answer_before_its_child_runs(self):
        def register_only():
            self.human("newer task")
            hook = {"session_id": "session-1", "prompt": "untrusted", "cwd": str(self.project),
                    "transcript_path": str(self.transcript)}
            with patch.object(sys, "stdin", io.StringIO(json.dumps(hook))), \
                    patch.object(self.namer.os, "fork", return_value=1):
                self.namer.main()
        self.auto(["old topic", "new topic"], during=register_only)
        self.assertEqual(self.name.read_text(), "new topic\n")
        self.assertEqual(len(self.requests), 2)

    def test_final_commit_waits_for_lock_and_rechecks_session_end(self):
        ready, release_network, done = threading.Event(), threading.Event(), threading.Event()
        errors = []

        def during():
            ready.set()
            if not release_network.wait(3):
                raise TimeoutError("test did not release network response")

        def run():
            try:
                self.auto(during=during)
            except BaseException as exc:
                errors.append(exc)
            finally:
                done.set()

        worker = threading.Thread(target=run)
        worker.start()
        try:
            self.assertTrue(ready.wait(3), "namer never reached network boundary")
            with (self.state / "session-1.name.lock").open("a") as lock:
                # A network request must not hold the name lock.
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                release_network.set()
                self.assertFalse(done.wait(0.2), "commit ignored the shared lock")
                self.assertEqual(self.name.read_text(), "project\n")
                self.live.unlink()
                self.name.unlink()
                fcntl.flock(lock, fcntl.LOCK_UN)
        finally:
            release_network.set()
            worker.join(5)
        self.assertFalse(worker.is_alive())
        self.assertEqual(errors, [])
        self.assertFalse(self.name.exists())
        self.assertFalse(self.marker.exists())

    def test_escape_terminated_title_sequence_is_removed(self):
        self.auto("\x1b]0;injected\x1b\\🟢 שלום עולם")
        self.assertEqual(self.name.read_text(), "שלום עולם\n")

    def test_explicit_tty_targets_that_terminal_without_a_process_walk(self):
        # The editor calls tn from outside the terminal's process tree; without
        # --tty the PPID walk would land on the wrong terminal, or none.
        ps = self.home / "bin/ps"
        ps.write_text("#!/bin/sh\nexit 1\n")
        self.tn("--tty", "ttys-test", "renamed by hand")
        self.assertEqual(self.name.read_text(), "renamed by hand\n")
        self.assertTrue(self.pin.exists())
        self.tn("--tty", "ttys-test")
        self.assertFalse(self.pin.exists())

    def test_unknown_option_is_refused(self):
        result = subprocess.run([str(ROOT / "tn"), "--wat", "x"], cwd=self.project,
                                capture_output=True, text=True, timeout=5)
        self.assertEqual(result.returncode, 1)
        self.assertIn("unknown option", result.stderr)
        self.assertEqual(self.name.read_text(), "project\n")

    def test_unpinned_auto_command_stays_unpinned(self):
        self.tn("--auto", "new topic")
        self.assertEqual(self.name.read_text(), "new topic\n")
        self.assertFalse(self.pin.exists())

    def test_non_session_command_warns_then_clear_removes_legacy_override(self):
        self.live.unlink()
        result = self.tn("shell topic")
        legacy_name = self.state / "tty.ttys-test.name"
        self.assertEqual(legacy_name.read_text(), "shell topic\n")
        self.assertIn("no live Claude session", result.stderr)
        self.tn()
        self.assertFalse(legacy_name.exists())
        self.assertFalse((self.state / "tty.ttys-test.pinned").exists())

    def test_internal_events_never_call_model_or_mutate_topic_generation(self):
        rows = [
            {"type": "queue-operation", "operation": "enqueue", "content": "rename this"},
            {"type": "attachment", "attachment": {"type": "queued_command", "prompt": "rename",
             "origin": {"kind": "peer"}, "isMeta": True}},
            {"type": "user", "userType": "external", "uuid": "external",
             "message": {"content": "<origin kind='human'>rename me</origin>"}},
        ]
        for row in rows:
            self.row(row)
        self.human("peer", origin={"kind": "peer"})
        self.human("meta", isMeta=True)
        self.human("sidechain", isSidechain=True)
        self.human([{"type": "tool_result", "content": "rename tab"}])
        self.auto(prompt=None)
        self.assertEqual(self.requests, [])
        self.assertFalse(self.topic.exists())
        self.assertFalse((self.state / "session-1.name-generation").exists())
        self.assertEqual(self.name.read_text(), "project\n")

    def test_hook_payload_cannot_override_verified_human_text(self):
        self.auto(prompt="Repair invoices", hook_extra={"prompt": "Write a racing game"})
        content = self.requests[0]["messages"][-1]["content"]
        self.assertIn("Repair invoices", content)
        self.assertNotIn("racing game", content)
        self.assertGreaterEqual(self.requests[0]["max_tokens"], 256)

    def test_explicit_typed_fallback_and_text_blocks(self):
        self.human([{"type": "text", "text": "Build invoice export"}], origin=None)
        self.auto(prompt=None)
        self.assertEqual(self.name.read_text(), "new topic\n")
        self.assertIn("Build invoice export", self.requests[0]["messages"][-1]["content"])

    def test_processed_human_ignores_notification_flood(self):
        self.auto()
        before = {p.name: p.read_bytes() for p in
                  [self.topic, self.name, self.marker, self.state / "session-1.name-generation"]}
        for _ in range(5):
            self.row({"type": "queue-operation", "content": "internal agent activity"})
            self.auto(prompt=None)
        self.assertEqual(len(self.requests), 1)
        self.assertEqual(before, {self.state.joinpath(k).name: self.state.joinpath(k).read_bytes()
                                 for k in before})

    def test_same_topic_multi_file_correction_and_language_shift_never_rewrites_label(self):
        self.auto("invoice exports", prompt="Add invoice export to the billing app")
        original_topic = json.loads(self.topic.read_text())["topic"]
        for followup in ["Update the export route and its tests too", "No, use CSV not PDF",
                         "כן תתקן גם את המסך ותדחוף"]:
            with self.name.open() as original:
                self.auto({"decision": "same", "name": "better label",
                           "topic": "Alternative wording of the same work"}, prompt=followup)
                self.assertEqual(original.read(), "invoice exports\n")
            self.assertEqual(self.name.read_text(), "invoice exports\n")
            self.assertEqual(json.loads(self.topic.read_text())["topic"], original_topic)
        self.assertEqual(json.loads(self.topic.read_text())["last_processed_uuid"], "human-4")

    def test_true_change_stores_semantic_context_without_prompt_copy(self):
        self.auto("invoice exports", prompt="Add export with PRIVATE-ACCOUNT-12345")
        self.auto({"decision": "change", "name": "garden planner",
                   "topic": "Plan irrigation and planting for the home garden"},
                  prompt="Now help plan the garden")
        saved = json.loads(self.topic.read_text())
        self.assertEqual(saved["topic"], "Plan irrigation and planting for the home garden")
        self.assertEqual(saved["last_processed_uuid"], "human-2")
        self.assertEqual(self.name.read_text(), "garden planner\n")
        for path in self.state.iterdir():
            self.assertNotIn("PRIVATE-ACCOUNT-12345", path.read_text())
            self.assertNotIn("Now help plan the garden", path.read_text())

    def test_quick_acknowledgement_coalesces_initial_request_without_stale_write(self):
        def acknowledge():
            self.auto(prompt="yes")
            self.assertEqual(self.name.read_text(), "project\n")
        self.auto(["stale guess", "invoice exports"], during=acknowledge,
                  prompt="Build invoice exports for accountants")
        self.assertEqual(self.name.read_text(), "invoice exports\n")
        self.assertEqual(len(self.requests), 2)
        latest = self.requests[-1]["messages"][-1]["content"]
        self.assertIn("Build invoice exports for accountants", latest)
        self.assertIn("yes", latest)
        self.assertEqual(json.loads(self.topic.read_text())["last_processed_uuid"], "human-2")

    def test_new_human_persisted_without_second_hook_invalidates_response(self):
        self.auto(["stale guess", "garden planner"],
                  during=lambda: self.human("Switch to planning the garden"))
        self.assertEqual(self.name.read_text(), "garden planner\n")
        self.assertEqual(len(self.requests), 2)

    def test_missing_bootstrap_state_keeps_meaningful_existing_label(self):
        self.name.write_text("invoice exports\n")
        self.human("Build invoice exports")
        self.auto({"decision": "same", "name": "different name",
                   "topic": "Build invoice exports for the billing app"}, prompt="yes")
        self.assertEqual(self.name.read_text(), "invoice exports\n")
        self.assertEqual(json.loads(self.topic.read_text())["topic"],
                         "Build invoice exports for the billing app")
        self.assertIn("Build invoice exports", self.requests[0]["messages"][-1]["content"])

    def test_uncertain_never_renames_and_future_human_can_supply_initial_context(self):
        self.auto("NONE", prompt="hello")
        self.assertEqual(self.name.read_text(), "project\n")
        self.auto("invoice exports", prompt="Add invoice exports")
        self.assertEqual(self.name.read_text(), "invoice exports\n")

    def test_long_paste_keeps_end_task_and_explicit_truncation_notice(self):
        self.auto(prompt="START-ANCHOR " + "pasted log " * 10000 +
                  " END-TASK build an invoice export")
        content = self.requests[0]["messages"][-1]["content"]
        self.assertLess(len(content), 30000)
        self.assertIn("START-ANCHOR", content)
        self.assertIn("END-TASK build an invoice export", content)
        self.assertIn("truncat", content.lower())

    def test_malformed_truncated_refused_and_invalid_json_fail_closed(self):
        bad = [
            {"choices": [{"finish_reason": "length", "message": {"content":
                '{"decision":"change","name":"bad topic","topic":"A complete looking topic"}'}}]},
            {"choices": [{"finish_reason": "stop", "message": {"refusal": "refused", "content":
                '{"decision":"change","name":"bad topic","topic":"A complete looking topic"}'}}]},
            {"choices": [{"finish_reason": "stop", "message": {"content": "KEEP"}}]},
            {"decision": "change", "name": "bad topic", "topic": ""},
            {"decision": "change", "name": "bad topic", "topic": "x" * 1000},
            {"decision": "change", "name": "this is much too long", "topic": "A short topic"},
            {"decision": "surprise", "name": "bad topic", "topic": "A short topic"},
            {"decision": "change", "name": "bad topic", "topic": "A short topic", "extra": True},
        ]
        for answer in bad:
            with self.subTest(answer=answer):
                before = len(self.requests)
                self.auto(answer)
                self.assertEqual(len(self.requests) - before, 2)
                self.assertEqual(self.name.read_text(), "project\n")
                self.assertEqual(self.marker.read_text(), "fail\n")
                self.assertFalse(json.loads(self.topic.read_text())["last_processed_uuid"])

    def test_failure_retries_once_then_cools_down_per_pending_human_signature(self):
        self.auto(OSError("offline"), prompt="Repair invoices")
        self.assertEqual(len(self.requests), 2)
        self.assertEqual(self.marker.read_text(), "fail\n")
        generation = (self.state / "session-1.name-generation").read_text()
        for _ in range(4):
            self.auto(OSError("offline"), prompt=None)
        self.assertEqual(len(self.requests), 2)
        self.assertEqual((self.state / "session-1.name-generation").read_text(), generation)
        saved = json.loads(self.topic.read_text())
        saved["failure"]["retry_after"] = 0
        self.topic.write_text(json.dumps(saved))
        self.auto("invoice exports", prompt=None)
        self.assertEqual(self.name.read_text(), "invoice exports\n")
        self.assertEqual(len(self.requests), 3)
        self.assertIn("Repair invoices", self.requests[-1]["messages"][-1]["content"])
        self.assertIsNone(json.loads(self.topic.read_text())["failure"])

    def test_new_human_bypasses_old_failure_cooldown_without_losing_anchor(self):
        self.auto(OSError("offline"), prompt="Repair invoices")
        self.auto("invoice exports", prompt="yes")
        self.assertEqual(len(self.requests), 3)
        self.assertIn("Repair invoices", self.requests[-1]["messages"][-1]["content"])
        self.assertEqual(self.name.read_text(), "invoice exports\n")

    def test_transcript_may_arrive_shortly_after_hook(self):
        timer = threading.Timer(0.08, lambda: self.human("Build invoice exports"))
        timer.start()
        try:
            self.auto(prompt=None)
        finally:
            timer.join()
        self.assertEqual(self.name.read_text(), "new topic\n")
        self.assertEqual(len(self.requests), 1)


if __name__ == "__main__":
    unittest.main()
