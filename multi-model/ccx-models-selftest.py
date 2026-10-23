#!/usr/bin/env python3
import json
import os
import subprocess
import tempfile
from pathlib import Path

SCRIPT = Path(__file__).with_name("ccx-models.py")


def run(mode, args, model, cache_models):
    with tempfile.TemporaryDirectory() as home:
        cache = Path(home) / ".codex" / "models_cache.json"
        cache.parent.mkdir()
        cache.write_text(json.dumps({"models": cache_models}))
        result = subprocess.run(
            ["python3", str(SCRIPT), mode, *args],
            input=json.dumps({"data": [model]}),
            text=True,
            capture_output=True,
            check=True,
            env={**os.environ, "HOME": home},
        )
        return result.stdout.strip()


def model_window(model, cache_models):
    return int(run("window", [model["id"]], model, cache_models))


astra = {
    "id": "gpt-6-astra",
    "display_name": "GPT 6.0 Astra",
    "owned_by": "openai",
    "max_input_tokens": 272_000,
}
reserve = {"slug": "gpt-reserve", "context_window": 272_000, "max_context_window": 872_000,
           "effective_context_window_percent": 95}
# Codex's own published ceiling, never a hard-coded bigger guess.
assert model_window(astra, [reserve]) == 872_000
exact = dict(reserve, slug="gpt-6-astra", max_context_window=600_000)
assert model_window(astra, [reserve, exact]) == 600_000
# Between 200k and 1M -> its own auto-compact window, at Codex's safe percent.
assert json.loads(run("compact", [], astra, [reserve])) == {"gpt-6-astra": 828_400}

claude = {
    "id": "claude-fable-5-1",
    "display_name": "Claude Fable 5.1",
    "owned_by": "anthropic",
    "max_input_tokens": 1_000_000,
}
assert model_window(claude, [reserve]) == 1_000_000
assert json.loads(run("compact", [], claude, [reserve])) == {}
print("PASS: Codex limits drive window and auto-compact")
