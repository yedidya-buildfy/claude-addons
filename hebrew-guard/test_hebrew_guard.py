import json
import os
import subprocess
import sys
import tempfile
import unittest

GUARD = os.path.join(os.path.dirname(os.path.abspath(__file__)), "hebrew-guard.py")
VS = "Library/Application Support/Code/User/settings.json"


class HebrewGuard(unittest.TestCase):
    def setUp(self):
        self.home = tempfile.mkdtemp()

    def put(self, rel, data):
        path = os.path.join(self.home, rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w") as f:
            f.write(data if isinstance(data, str) else json.dumps(data))
        return path

    def run_guard(self):
        env = dict(os.environ, HOME=self.home)
        r = subprocess.run([sys.executable, GUARD], env=env, capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stderr)
        return r.stdout.strip()

    def read(self, path):
        with open(path) as f:
            return json.load(f)

    def test_gpu_off_is_turned_on_and_other_settings_kept(self):
        p = self.put(VS, {"terminal.integrated.gpuAcceleration": "off", "keep": 1})
        out = self.run_guard()
        self.assertEqual(self.read(p), {"terminal.integrated.gpuAcceleration": "on", "keep": 1})
        self.assertIn('was "off"', json.loads(out)["systemMessage"])

    def test_gpu_auto_and_unset_are_turned_on(self):
        for start in ({"terminal.integrated.gpuAcceleration": "auto"}, {}):
            p = self.put(VS, start)
            self.run_guard()
            self.assertEqual(self.read(p)["terminal.integrated.gpuAcceleration"], "on")

    def test_rtl_plugin_is_disabled_in_both_settings_files(self):
        a = self.put(".claude/settings.json", {"enabledPlugins": {"rtl-text@claude-code-rtl": True, "caveman@caveman": True}})
        b = self.put(".claude-ccx/settings.json", {"enabledPlugins": {"bidi-fix@x": True}})
        out = self.run_guard()
        self.assertEqual(self.read(a)["enabledPlugins"], {"rtl-text@claude-code-rtl": False, "caveman@caveman": True})
        self.assertEqual(self.read(b)["enabledPlugins"], {"bidi-fix@x": False})
        self.assertIn("Restart this Claude session", out)

    def test_healthy_setup_is_silent_and_untouched(self):
        p = self.put(VS, {"terminal.integrated.gpuAcceleration": "on"})
        c = self.put(".claude/settings.json", {"enabledPlugins": {"caveman@caveman": True, "rtl-text@x": False}})
        before = (os.path.getmtime(p), os.path.getmtime(c))
        self.assertEqual(self.run_guard(), "")
        self.assertEqual(before, (os.path.getmtime(p), os.path.getmtime(c)))

    def test_unreadable_or_missing_files_are_left_alone(self):
        p = self.put(VS, '{\n  // a comment VS Code allows\n  "terminal.integrated.gpuAcceleration": "off"\n}')
        self.assertEqual(self.run_guard(), "")
        with open(p) as f:
            self.assertIn("// a comment", f.read())


if __name__ == "__main__":
    unittest.main()
