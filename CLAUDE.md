# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Purpose

This repository owns global Claude Code add-ons. `ccx` belongs here, never in an application repository. It installs as a machine-wide shell command and can then be used from any project directory.

## Bootstrap a fresh Mac

For a machine that needs `ccx`, use the standalone installer. Do not recreate files manually and do not copy credentials from another computer.

```bash
git clone https://github.com/yedidya-buildfy/claude-addons.git
cd claude-addons
./multi-model/install.sh
```

The installer handles Homebrew, native Claude Code, CLIProxyAPI, runtime files, a global `ccx` command, local-only configuration, backups, service startup, model refresh, generated provider subagents, and optional OAuth login.

Provider credentials must be created by the person using that Mac through the browser prompts. They are not repository content and must never be copied between machines.

If login was skipped:

```bash
ccx --login
ccx --refresh
```

Verify bootstrap before declaring it complete:

```bash
command -v ccx
ccx --status
```

Expected: `ccx` resolves from the Homebrew binary directory; proxy and request cleaner are up; Claude models appear; every logged-in provider appears; generated provider subagents exist.

Preview or update safely:

```bash
./multi-model/install.sh --dry-run

git pull
./multi-model/install.sh
```

## Repository structure

The root installer offers every add-on interactively. The standalone multi-model installer is the source of truth for installing `ccx`; the root installer delegates to it.

The multi-model runtime has four responsibilities:

1. Launcher: starts Claude Code against the local bridge, manages service lifecycle, model selection, login/logout, and isolated CCX settings.
2. Model catalogue: discovers live provider models, keeps current generations, assigns context windows, updates the picker, and generates one subagent per non-Claude provider.
3. Request cleaner: normalizes tool schemas before forwarding requests and returns a structured timeout instead of hanging forever.
4. Configuration merger: replaces only CCX-owned proxy sections, preserves unrelated settings, writes atomically, and keeps the local key private.

Provider auth and runtime state live only under the user's home directory. The remembered model catalogue must stay outside the provider auth directory because the proxy parses every JSON file in the auth directory as credentials.

## Reliability invariants

- Both local services bind only to `127.0.0.1`.
- Proxy-level retries stay at zero; Claude Code is the only retry layer.
- Upstream inactivity timeout stays at 600,000 ms, with five extra seconds for the client-facing timeout response.
- Refresh must preserve remembered providers while OAuth backends finish loading.
- Generated provider agents use the maximum supported context form of the latest model.
- Existing unrelated proxy configuration survives installer reruns.
- Existing local key and OAuth files are never overwritten.

## Verification commands

Run all multi-model checks:

```bash
cd multi-model
./test-picker.sh
./install-selftest.sh
node ./ccx-rewrite-selftest.js
python3 ./ccx-models-selftest.py
python3 ./install-config-selftest.py
```

Run one focused check by invoking its script directly, for example:

```bash
node multi-model/ccx-rewrite-selftest.js
```

Validate shell and language syntax:

```bash
bash -n install.sh uninstall.sh multi-model/install.sh multi-model/ccx
node --check multi-model/ccx-rewrite.js
python3 -m py_compile multi-model/ccx-models.py multi-model/install-config.py
```

A real-machine verification starts with dry-run. Do not trigger OAuth login or provider inference merely to test code unless the user explicitly asks, because those actions open external flows or consume quota.

## Distribution

Changes to global `ccx` are committed and pushed in this repository. Application repositories may be used to test the installed command, but must not receive copied CCX runtime files, installers, or setup documentation.
