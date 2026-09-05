# Provider-Aware Statusline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show live effort, actual context size, and only the active model provider's trustworthy usage limits in Claude Code's status line.

**Architecture:** Keep rendering synchronous and local. A single dependency-free Node collector normalizes provider data into secret-free cache files; the existing status line reads only those files and launches detached refreshes when stale. Claude keeps its current path, Codex uses the official app server, Google uses the official Antigravity status-line payload, and Grok fails closed unless its installed client explicitly exposes a local usage command.

**Tech Stack:** Node.js standard library, Bash installer, Claude Code status-line JSON, Codex app-server JSONL, Google Antigravity CLI status-line JSON, macOS `script` for isolated PTY probes.

**Spec:** `docs/superpowers/specs/2026-08-28-provider-aware-statusline-design.md`

## Global Constraints

- No runtime dependency beyond Node.js, Bash, installed official provider clients, and macOS system tools.
- No network request, PTY process, or credential read in the status-line render path.
- Cache files contain only provider, fetch time, normalized windows, reset-credit summary, status, and short error reason.
- No token, email, account ID, project ID, authorization header, or raw provider response may be cached or logged.
- All auth and cache files must use mode `0600`.
- Google must not call a `v1internal` endpoint directly.
- No collector may send a model prompt merely to obtain rate-limit headers.
- A malformed or unsupported provider response produces `usage unavailable`, never partial or guessed data.
- Do not commit or push unless the user explicitly requests it.

---

### Task 1: Model Provider, Effort, and Context Label

**Files:**
- Modify: `statusline-gsd/gsd-statusline.js`
- Create: `statusline-gsd/provider-usage.test.js`

**Interfaces:**
- Produces: `providerForModel(displayName: string): 'claude' | 'codex' | 'google' | 'grok' | 'other'`
- Produces: `formatContextSize(tokens: number | undefined): string`
- Produces: `formatModelLabel(data: object): string`
- Existing callers continue using `runStatusline()` and `renderStatusline(data)`.

- [ ] **Step 1: Write failing provider and model-label tests**

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  providerForModel,
  formatContextSize,
  formatModelLabel,
} = require('./gsd-statusline');

test('detects provider from readable model name', () => {
  assert.equal(providerForModel('Claude Fable 5'), 'claude');
  assert.equal(providerForModel('GPT 5.6 Sol'), 'codex');
  assert.equal(providerForModel('Gemini 3.1 Pro (High)'), 'google');
  assert.equal(providerForModel('Grok 4.6'), 'grok');
});

test('formats effort and actual context size beside model', () => {
  assert.equal(formatContextSize(200_000), '200K');
  assert.equal(formatContextSize(372_000), '372K');
  assert.equal(formatContextSize(500_000), '500K');
  assert.equal(formatContextSize(1_000_000), '1M');
  assert.equal(formatContextSize(1_048_576), '1.05M');
  assert.equal(formatModelLabel({
    model: { display_name: 'GPT 5.6 Sol' },
    effort: { level: 'high' },
    context_window: { context_window_size: 372_000 },
  }), 'GPT 5.6 Sol · high · 372K ctx');
});

test('omits unavailable effort and context without duplicate separators', () => {
  assert.equal(formatModelLabel({ model: { display_name: 'Grok 4.6' } }), 'Grok 4.6');
});
```

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
node --test statusline-gsd/provider-usage.test.js
```

Expected: FAIL because exported helpers do not exist.

- [ ] **Step 3: Add minimal provider and label helpers**

```js
function providerForModel(displayName = '') {
  const name = displayName.toLowerCase();
  if (/claude|fable|opus|sonnet|haiku/.test(name)) return 'claude';
  if (/gpt|codex/.test(name)) return 'codex';
  if (/gemini/.test(name)) return 'google';
  if (/grok/.test(name)) return 'grok';
  return 'other';
}

function formatContextSize(tokens) {
  if (!Number.isFinite(tokens) || tokens <= 0) return '';
  if (tokens >= 1_000_000) {
    return `${Number((tokens / 1_000_000).toFixed(2))}M`;
  }
  return `${Math.round(tokens / 1000)}K`;
}

function formatModelLabel(data) {
  const parts = [data.model?.display_name || 'Claude'];
  if (data.effort?.level) parts.push(data.effort.level);
  const size = formatContextSize(data.context_window?.context_window_size);
  if (size) parts.push(`${size} ctx`);
  return parts.join(' · ');
}
```

Use `formatModelLabel(data)` in both render paths. Use `context_window_size` before legacy fallbacks when calculating the existing context meter.

- [ ] **Step 4: Export helpers and verify GREEN**

Run:

```bash
node --test statusline-gsd/provider-usage.test.js
```

Expected: 3 tests PASS.

- [ ] **Step 5: Verify source remains syntactically valid**

Run:

```bash
node --check statusline-gsd/gsd-statusline.js
git diff --check
```

Expected: both commands exit 0.

---

### Task 2: Provider Cache Contract and Provider-Aware Rendering

**Files:**
- Modify: `statusline-gsd/gsd-statusline.js`
- Modify: `statusline-gsd/provider-usage.test.js`
- Create: `statusline-gsd/provider-usage.js`

**Interfaces:**
- Produces: `providerCachePath(claudeDir: string, provider: string): string`
- Produces: `readProviderSnapshot(claudeDir: string, provider: string, now?: number): object`
- Produces: `formatProviderUsage(data: object, claudeDir: string, now?: number): string`
- Collector CLI: `node provider-usage.js fetch <provider>`
- Cache schema: `{ provider, fetchedAt, status, windows, resetCredits?, reason? }`

- [ ] **Step 1: Add failing tests for provider isolation, freshness, and unavailable state**

```js
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { formatProviderUsage } = require('./gsd-statusline');

function tmpClaudeDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'statusline-test-'));
  fs.mkdirSync(path.join(dir, 'cache'));
  return dir;
}

function stripAnsi(text) {
  return text.replace(/\x1b\[[0-?]*[ -\/]*[@-~]/g, '');
}

test('GPT renders Codex cache and never Claude limits', () => {
  const dir = tmpClaudeDir();
  fs.writeFileSync(path.join(dir, 'cache', 'provider-usage-codex.json'), JSON.stringify({
    provider: 'codex',
    fetchedAt: 1_000_000,
    status: 'ok',
    windows: [{ label: '5h', usedPercent: 51, resetsAt: 5_000 }],
  }));
  const rendered = stripAnsi(formatProviderUsage({
    model: { display_name: 'GPT 5.6 Sol' },
    rate_limits: {
      five_hour: { used_percentage: 99 },
      seven_day: { used_percentage: 98 },
    },
  }, dir, 1_030_000));
  assert.match(rendered, /5h .*51%/);
  assert.doesNotMatch(rendered, /99%|98%|Fable/);
});

test('hard-expired cache does not show old percentages', () => {
  const dir = tmpClaudeDir();
  fs.writeFileSync(path.join(dir, 'cache', 'provider-usage-google.json'), JSON.stringify({
    provider: 'google', fetchedAt: 0, status: 'ok',
    windows: [{ label: 'wk', usedPercent: 22 }],
  }));
  const rendered = stripAnsi(formatProviderUsage({
    model: { display_name: 'Gemini 3.1 Pro' },
  }, dir, 601_000));
  assert.equal(rendered, ' │ Google usage unavailable');
});
```

- [ ] **Step 2: Run targeted tests and verify RED**

Run:

```bash
node --test --test-name-pattern='GPT renders|hard-expired' statusline-gsd/provider-usage.test.js
```

Expected: FAIL because `formatProviderUsage` does not exist.

- [ ] **Step 3: Implement cache reading and normalized formatting**

Use constants:

```js
const PROVIDER_REFRESH_MS = { codex: 60_000, google: 120_000, grok: 120_000 };
const PROVIDER_HARD_EXPIRY_MS = 10 * 60_000;
```

Rules:

```js
function providerCachePath(claudeDir, provider) {
  return path.join(claudeDir, 'cache', `provider-usage-${provider}.json`);
}

function readProviderSnapshot(claudeDir, provider, now = Date.now()) {
  try {
    const snapshot = JSON.parse(fs.readFileSync(providerCachePath(claudeDir, provider), 'utf8'));
    if (snapshot.provider !== provider || !Number.isFinite(snapshot.fetchedAt)) return null;
    const age = now - snapshot.fetchedAt;
    return { ...snapshot, stale: age > PROVIDER_REFRESH_MS[provider], expired: age > PROVIDER_HARD_EXPIRY_MS };
  } catch (_) {
    return null;
  }
}
```

`formatProviderUsage` must:

1. Delegate Claude to existing `formatUsage` behavior.
2. Read only active provider's cache.
3. Show `stale` only between refresh age and hard expiry.
4. Show `<Provider> usage unavailable` when missing, malformed, non-`ok`, or expired.
5. Spawn the collector detached only when cache is stale or missing.
6. Use one lock file per provider in `os.tmpdir()`.

- [ ] **Step 4: Create collector CLI skeleton with atomic secret-free writes**

```js
#!/usr/bin/env node
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function cachePath(provider) {
  const claudeDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  return path.join(claudeDir, 'cache', `provider-usage-${provider}.json`);
}

function writeSnapshot(provider, snapshot) {
  const target = cachePath(provider);
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const temp = `${target}.${process.pid}.tmp`;
  const safe = {
    provider,
    fetchedAt: Date.now(),
    status: snapshot.status,
    windows: snapshot.windows || [],
    ...(snapshot.resetCredits ? { resetCredits: snapshot.resetCredits } : {}),
    ...(snapshot.reason ? { reason: snapshot.reason } : {}),
  };
  fs.writeFileSync(temp, `${JSON.stringify(safe)}\n`, { mode: 0o600 });
  fs.chmodSync(temp, 0o600);
  fs.renameSync(temp, target);
  fs.chmodSync(target, 0o600);
}
```

Unknown providers write `{status:'unavailable', windows:[], reason:'unsupported-provider'}`.

- [ ] **Step 5: Run full tests and syntax checks**

Run:

```bash
node --test statusline-gsd/provider-usage.test.js
node --check statusline-gsd/provider-usage.js
node --check statusline-gsd/gsd-statusline.js
```

Expected: all PASS.

---

### Task 3: Official Codex Quota Collector

**Files:**
- Modify: `statusline-gsd/provider-usage.js`
- Modify: `statusline-gsd/provider-usage.test.js`

**Interfaces:**
- Produces: `normalizeCodexRateLimits(result: object, nowSeconds?: number): NormalizedSnapshot`
- Produces: `fetchCodex(): Promise<NormalizedSnapshot>`
- Consumes existing Codex login through `codex app-server --stdio`.

- [ ] **Step 1: Add failing normalization test**

```js
const { normalizeCodexRateLimits } = require('./provider-usage');

test('normalizes Codex windows and nearest available reset credit', () => {
  const result = normalizeCodexRateLimits({
    rateLimits: {
      primary: { usedPercent: 51, windowDurationMins: 300, resetsAt: 2_000 },
      secondary: { usedPercent: 34, windowDurationMins: 10_080, resetsAt: 9_000 },
    },
    rateLimitResetCredits: {
      availableCount: 3,
      credits: [
        { status: 'available', expiresAt: 8_000 },
        { status: 'redeemed', expiresAt: 3_000 },
        { status: 'available', expiresAt: 7_000 },
        { status: 'available', expiresAt: null },
      ],
    },
  }, 1_000);
  assert.deepEqual(result.windows, [
    { id: 'default:primary', label: '5h', usedPercent: 51, resetsAt: 2_000 },
    { id: 'default:secondary', label: 'wk', usedPercent: 34, resetsAt: 9_000 },
  ]);
  assert.deepEqual(result.resetCredits, { availableCount: 3, nextExpiresAt: 7_000 });
});
```

- [ ] **Step 2: Run test and verify RED**

Run:

```bash
node --test --test-name-pattern='normalizes Codex' statusline-gsd/provider-usage.test.js
```

Expected: FAIL because normalizer is missing.

- [ ] **Step 3: Implement Codex normalization**

Implement labels exactly:

```js
function durationLabel(minutes) {
  if (minutes === 300) return '5h';
  if (minutes === 1_440) return 'day';
  if (minutes === 10_080) return 'wk';
  if (Number.isFinite(minutes)) return `${minutes}m`;
  return 'limit';
}
```

Normalize both `rateLimits` and every entry in `rateLimitsByLimitId`. Deduplicate by `${limitId}:${primary|secondary}`. Clamp percentages to `0..100`. Count only credits with `status === 'available'`; choose the smallest future numeric `expiresAt`.

- [ ] **Step 4: Implement the JSONL app-server exchange**

Required sequence:

```jsonl
{"method":"initialize","id":0,"params":{"clientInfo":{"name":"claude-addons-statusline","title":"Claude Addons Statusline","version":"1.0.0"}}}
{"method":"initialized","params":{}}
{"method":"account/rateLimits/read","id":1,"params":{}}
```

Implementation requirements:

- Spawn `codex app-server --stdio` with piped stdin/stdout and ignored stderr.
- Parse stdout one JSON line at a time.
- Send `initialized` and rate-limit request only after response `id: 0`.
- Resolve only response `id: 1` with a `result`.
- Kill the child after success, parse failure, exit, or 10-second timeout.
- Return unavailable reasons limited to `codex-missing`, `codex-timeout`, `codex-auth`, `codex-protocol`, or `codex-exit`.

- [ ] **Step 5: Verify collector against existing Codex login without printing raw response**

Run:

```bash
node statusline-gsd/provider-usage.js fetch codex
python3 - <<'PY'
import json, os
p=os.path.expanduser('~/.claude/cache/provider-usage-codex.json')
d=json.load(open(p))
assert set(d) <= {'provider','fetchedAt','status','windows','resetCredits','reason'}
assert d['provider']=='codex'
assert 'email' not in repr(d).lower()
assert 'token' not in repr(d).lower()
print(d['status'], len(d.get('windows', [])), d.get('resetCredits', {}).get('availableCount'))
PY
```

Expected: `ok`, at least one window for a logged-in Plus account, and no sensitive fields.

- [ ] **Step 6: Run tests**

```bash
node --test statusline-gsd/provider-usage.test.js
```

Expected: all PASS.

---

### Task 4: Google Antigravity Snapshot Capture

**Files:**
- Modify: `statusline-gsd/provider-usage.js`
- Modify: `statusline-gsd/provider-usage.test.js`
- Modify: `install.sh`

**Interfaces:**
- Collector CLI: `node provider-usage.js capture-antigravity` reads one status-line JSON object from stdin.
- Produces: `normalizeAntigravityQuota(quota: object): NormalizedSnapshot`
- Fetch CLI: `node provider-usage.js fetch google` launches a prompt-free official client probe and waits for cache refresh.

- [ ] **Step 1: Add failing quota-normalization test**

```js
const { normalizeAntigravityQuota } = require('./provider-usage');

test('converts Antigravity remaining fractions to used percentages', () => {
  assert.deepEqual(normalizeAntigravityQuota({
    'gemini-five-hour': { remaining_fraction: 0.57, reset_time: '2026-08-28T16:46:00Z' },
    'gemini-weekly': { remaining_fraction: 0.78, reset_in_seconds: 345_600 },
  }, Date.parse('2026-08-28T12:00:00Z')), {
    status: 'ok',
    windows: [
      { id: 'gemini-five-hour', label: '5h', usedPercent: 43, resetsAt: 1787935560 },
      { id: 'gemini-weekly', label: 'wk', usedPercent: 22, resetsAt: 1788264000 },
    ],
  });
});
```

- [ ] **Step 2: Run test and verify RED**

```bash
node --test --test-name-pattern='Antigravity' statusline-gsd/provider-usage.test.js
```

Expected: FAIL because normalizer is missing.

- [ ] **Step 3: Implement capture mode**

- Read stdin with a 3-second timeout.
- Parse `data.quota`; reject missing or non-object quota.
- Convert `remaining_fraction` to `Math.round((1 - remaining) * 100)`.
- Accept reset time from ISO `reset_time`, otherwise `Date.now() + reset_in_seconds * 1000`.
- Derive `5h`, `day`, and `wk` only from bucket ID words; otherwise keep a compact bucket ID.
- Write only normalized Google cache.

- [ ] **Step 4: Add installer support for official Antigravity CLI and status-line helper**

Inside the existing interactive installer:

1. Detect `agy` with `command -v agy`.
2. If absent, ask before running the official macOS installer:

```bash
curl -fsSL https://antigravity.google/cli/install.sh | bash
```

3. Merge this into `~/.gemini/antigravity-cli/settings.json`:

```json
{
  "statusLine": {
    "type": "command",
    "command": "node ~/.claude/scripts/provider-usage.js capture-antigravity",
    "stack_with_default": true
  }
}
```

4. Do not copy or reuse the proxy's Google OAuth token.

- [ ] **Step 5: Implement prompt-free Google refresh probe**

`fetch google` must:

- Return `antigravity-missing` when `agy` is absent.
- Record cache mtime before launch.
- Spawn `/usr/bin/script -q /dev/null agy` with piped stdin and ignored output.
- Wait up to 8 seconds for capture mode to replace the cache.
- Send Ctrl-C and kill the process group whether capture succeeds or times out.
- Never send text that could become a model prompt.
- Preserve a prior valid cache on probe failure; only write unavailable when no cache exists.

- [ ] **Step 6: Run automated tests**

```bash
node --test statusline-gsd/provider-usage.test.js
bash -n install.sh
```

Expected: all PASS.

- [ ] **Step 7: Install and authenticate only if needed**

Run the official installer only after its existing confirmation prompt. Launch `agy`; if browser authentication is requested, complete it, then exit without sending a model prompt. Confirm capture:

```bash
python3 - <<'PY'
import json, os
p=os.path.expanduser('~/.claude/cache/provider-usage-google.json')
d=json.load(open(p))
assert d['provider']=='google'
assert set(d) <= {'provider','fetchedAt','status','windows','reason'}
print(d['status'], len(d.get('windows', [])))
PY
```

Expected: `ok` and at least one quota window. If the official client emits no quota before model work, record `unavailable` and keep the renderer fallback; do not add a private endpoint.

---

### Task 5: Grok Fail-Closed Usage Probe

**Files:**
- Modify: `statusline-gsd/provider-usage.js`
- Modify: `statusline-gsd/provider-usage.test.js`

**Interfaces:**
- Produces: `parseGrokUsageText(text: string, now?: number): NormalizedSnapshot`
- Fetch CLI: `node provider-usage.js fetch grok`

- [ ] **Step 1: Probe installed client's local command list without a model request**

Run:

```bash
tmp=$(mktemp)
(printf '/help\n'; sleep 2; printf '\003') | /usr/bin/script -q "$tmp" grok --no-alt-screen --minimal >/dev/null 2>&1 || true
python3 - "$tmp" <<'PY'
import re,sys
s=open(sys.argv[1], errors='ignore').read()
s=re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]', '', s)
print('supported' if re.search(r'(^|\s)/usage(\s|$)', s, re.M) else 'unsupported')
PY
rm -f "$tmp"
```

Expected on unsupported versions: `unsupported`. This is not failure; it selects the safe fallback path.

- [ ] **Step 2A: If `/usage` is unsupported, write failing fallback test**

```js
test('Grok without a local usage command fails closed', async () => {
  const result = await fetchGrok({ helpText: 'no usage command' });
  assert.deepEqual(result, { status: 'unavailable', windows: [], reason: 'unsupported-client' });
});
```

Run the test and confirm RED, then implement only the unavailable result. Do not parse settings UI, web cookies, billing history, or API rate-limit headers.

- [ ] **Step 2B: If `/usage` is supported, capture and sanitize one real fixture before writing parser code**

Run `/help`, then `/usage`, then Ctrl-C through `/usr/bin/script`. Remove ANSI control sequences, account identifiers, and unrelated UI lines. Store only the usage percentage and reset line as an inline test fixture. Write a failing parser test asserting exact `usedPercent` and `resetsAt`, then implement a strict anchored parser for that fixture shape only.

- [ ] **Step 3: Implement isolated PTY lifecycle**

- Allocate PTY with `/usr/bin/script`.
- Send `/help` first.
- Send `/usage` only when help output lists it.
- Never send a model prompt.
- Terminate within 8 seconds.
- Delete temporary transcript in a `finally` block.
- Cache only normalized data.
- Return reasons limited to `grok-missing`, `unsupported-client`, `grok-timeout`, or `grok-parse`.

- [ ] **Step 4: Run all tests**

```bash
node --test statusline-gsd/provider-usage.test.js
```

Expected: all PASS, including unsupported-client behavior on the installed version if applicable.

---

### Task 6: Installer, Permissions, Documentation, and Regression Checks

**Files:**
- Modify: `install.sh`
- Modify: `statusline-gsd/README.md`
- Modify: `multi-model/README.md`
- Modify: `statusline-gsd/gsd-statusline.js`
- Modify: `statusline-gsd/provider-usage.js`
- Modify: `statusline-gsd/provider-usage.test.js`

**Interfaces:**
- Installer copies both runtime files and applies secure permissions.
- Self-test command remains `node --test statusline-gsd/provider-usage.test.js`.

- [ ] **Step 1: Add installer copies and permission hardening**

The status-line install section must copy:

```bash
cp "$ROOT/statusline-gsd/provider-usage.js" "$CLAUDE_DIR/scripts/provider-usage.js"
chmod +x "$CLAUDE_DIR/scripts/provider-usage.js"
```

The multi-model section must harden only provider auth JSON files:

```bash
for auth in "$PROXY_AUTH_DIR"/claude-*.json \
            "$PROXY_AUTH_DIR"/codex-*.json \
            "$PROXY_AUTH_DIR"/antigravity-*.json \
            "$PROXY_AUTH_DIR"/xai-*.json; do
  [ -e "$auth" ] || continue
  chmod 600 "$auth"
done
```

Never chmod logs or unrelated files.

- [ ] **Step 2: Update documentation with exact trust levels**

Document:

- Claude: existing live plus cached usage.
- Codex: official app-server snapshot and reset credits.
- Google: official Antigravity status-line snapshot; unavailable if no prompt-free callback.
- Grok: official local `/usage` only when advertised; otherwise unavailable.
- Effort and context values come directly from Claude Code session input.
- Non-Claude models never show Claude bars.
- Stale and hard-expiry behavior.
- Cache contains no credentials.

- [ ] **Step 3: Run complete automated regression suite**

```bash
node --test statusline-gsd/provider-usage.test.js
./multi-model/test-picker.sh
bash -n install.sh
node --check statusline-gsd/gsd-statusline.js
node --check statusline-gsd/provider-usage.js
git diff --check
```

Expected: all commands exit 0 with no warnings.

- [ ] **Step 4: Verify permissions in a temporary install root where possible**

Use a temporary HOME for copy and cache tests. For real provider auth files, inspect modes without reading content:

```bash
find "$HOME/.cli-proxy-api" -maxdepth 1 -type f \
  \( -name 'claude-*.json' -o -name 'codex-*.json' -o -name 'antigravity-*.json' -o -name 'xai-*.json' \) \
  -exec stat -f '%Lp %N' {} \;
```

Expected: every listed file starts with `600`.

---

### Task 7: Install Locally and Verify Live Provider Switching

**Files:**
- Source: all modified files above
- Installed copies: `~/.claude/gsd-statusline.js`, `~/.claude/scripts/provider-usage.js`, `~/.claude/scripts/usage-fetch.sh`

**Interfaces:**
- User-visible status line updates in existing Claude Code sessions after next refresh; a new session guarantees all fields.

- [ ] **Step 1: Back up installed runtime files**

```bash
ts=$(date '+%Y-%m-%d-%H%M%S')
cp ~/.claude/gsd-statusline.js ~/.claude/gsd-statusline.js.bak.$ts
[ ! -f ~/.claude/scripts/provider-usage.js ] || cp ~/.claude/scripts/provider-usage.js ~/.claude/scripts/provider-usage.js.bak.$ts
```

- [ ] **Step 2: Install tested runtime files directly**

```bash
cp statusline-gsd/gsd-statusline.js ~/.claude/gsd-statusline.js
cp statusline-gsd/provider-usage.js ~/.claude/scripts/provider-usage.js
cp statusline-gsd/usage-fetch.sh ~/.claude/scripts/usage-fetch.sh
chmod +x ~/.claude/scripts/provider-usage.js ~/.claude/scripts/usage-fetch.sh
```

Harden provider auth files with the exact loop from Task 6.

- [ ] **Step 3: Pre-fetch provider snapshots**

```bash
node ~/.claude/scripts/provider-usage.js fetch codex
node ~/.claude/scripts/provider-usage.js fetch google || true
node ~/.claude/scripts/provider-usage.js fetch grok || true
```

Expected: Codex `ok`; Google `ok` only after official client installation/login and callback; Grok either `ok` or explicit unavailable.

- [ ] **Step 4: Render deterministic sample payloads**

Pipe sample status-line JSON for Claude, GPT, Gemini, and Grok into the installed renderer. Verify:

- Correct effort and context size.
- Correct active-provider cache only.
- No Claude percentages on GPT, Gemini, or Grok.
- Codex reset-credit count and nearest expiration when present.
- Unavailable state for unsupported Grok/Google paths.

- [ ] **Step 5: Verify in running app step by step**

1. Open a new `ccx` session.
2. Select Claude and compare bars with `/usage`.
3. Select GPT and compare with the Codex account snapshot.
4. Change `/effort`; confirm status line changes immediately.
5. Select Gemini; compare with Antigravity `/usage` when available.
6. Select Grok; compare with Grok Usage when the local command exists, otherwise confirm unavailable.
7. Switch back and forth; confirm previous provider bars disappear immediately.
8. Disconnect network; confirm render remains instant and transitions from `stale` to unavailable after hard expiry.

- [ ] **Step 6: Inspect final diff and status without committing**

```bash
git status --short
git diff --check
git diff --stat
```

Expected: only planned source, test, docs, installer, spec, and plan files changed. No commit or push.
