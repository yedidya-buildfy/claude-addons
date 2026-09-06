#!/usr/bin/env python3
import json
import os
import subprocess
import tempfile
from pathlib import Path

SCRIPT = Path(__file__).with_name("ccx-models.py")


def model_window(model, cache_models):
    with tempfile.TemporaryDirectory() as home:
        cache = Path(home) / ".codex" / "models_cache.json"
        cache.parent.mkdir()
        cache.write_text(json.dumps({"models": cache_models}))
        result = subprocess.run(
            ["python3", str(SCRIPT), "window", model["id"]],
            input=json.dumps({"data": [model]}),
            text=True,
            capture_output=True,
            check=True,
            env={**os.environ, "HOME": home},
        )
        return int(result.stdout.strip())


astra = {
    "id": "gpt-6-astra",
    "display_name": "GPT 6.0 Astra",
    "owned_by": "openai",
    "max_input_tokens": 272_000,
}
reserve = {"slug": "gpt-reserve", "context_window": 272_000, "max_context_window": 872_000}
assert model_window(astra, [reserve]) == 1_050_000

claude = {
    "id": "claude-fable-5-1",
    "display_name": "Claude Fable 5.1",
    "owned_by": "anthropic",
    "max_input_tokens": 1_000_000,
}
assert model_window(claude, [reserve]) == 1_000_000
print("PASS: subscription maximum context is preferred")
