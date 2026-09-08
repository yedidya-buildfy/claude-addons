#!/usr/bin/env python3
import subprocess
import tempfile
from pathlib import Path

root = Path(__file__).parent
script = root / "install-config.py"
template = root / "config.template.yaml"

with tempfile.TemporaryDirectory() as tmp:
    config = Path(tmp) / "cliproxyapi.conf"
    config.write_text(
        'logging-to-file: false\n'
        'custom-provider:\n'
        '  endpoint: "https://example.invalid"\n'
        'request-retry: 5\n'
        'routing:\n'
        '  strategy: "old"\n'
    )
    command = [
        "python3", str(script),
        "--config", str(config),
        "--template", str(template),
        "--local-key", "test-local-key",
    ]
    first = subprocess.run(command, text=True, capture_output=True)
    assert first.returncode == 0, first.stderr
    merged = config.read_text()
    assert 'custom-provider:\n  endpoint: "https://example.invalid"' in merged
    assert 'host: "127.0.0.1"' in merged
    assert 'auth-dir: "~/.cli-proxy-api"' in merged
    assert '  - "test-local-key"' in merged
    assert "request-retry: 0" in merged
    assert merged.count("request-retry:") == 1
    assert merged.count("routing:") == 1

    before = config.read_bytes()
    second = subprocess.run(command, text=True, capture_output=True)
    assert second.returncode == 0, second.stderr
    assert config.read_bytes() == before

print("PASS: proxy merge preserves unrelated settings and is idempotent")
