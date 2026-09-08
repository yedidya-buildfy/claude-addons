#!/usr/bin/env node
// Provider usage collector: fetches non-Claude model usage out-of-band and
// writes a normalized, secret-free cache file that the statusline renderer
// reads synchronously. Never invoked inline by the renderer — always spawned
// detached so the statusline never blocks on network work.
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const readline = require('node:readline');

// How old a cache entry may be before the renderer marks it `stale` and
// triggers a background refetch (numbers keep displaying while stale).
const PROVIDER_REFRESH_MS = { codex: 60_000, google: 120_000, grok: 120_000 };
// Past this age the renderer stops trusting the cached numbers at all and
// falls back to "<Provider> usage unavailable" instead of showing stale data.
const PROVIDER_HARD_EXPIRY_MS = 10 * 60_000;

function resolveClaudeDir() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

function providerCachePath(claudeDir, provider) {
  return path.join(claudeDir, 'cache', `provider-usage-${provider}.json`);
}

/**
 * Read a provider's cache file and annotate it with freshness flags.
 * Returns null when the file is missing, unreadable, malformed, or tagged
 * for a different provider (defends against a stale/wrong cache leaking
 * into another provider's render — see providerCachePath namespacing).
 */
function readProviderSnapshot(claudeDir, provider, now = Date.now()) {
  try {
    const snapshot = JSON.parse(fs.readFileSync(providerCachePath(claudeDir, provider), 'utf8'));
    if (snapshot.provider !== provider || !Number.isFinite(snapshot.fetchedAt)) return null;
    const age = now - snapshot.fetchedAt;
    const refreshMs = PROVIDER_REFRESH_MS[provider] ?? PROVIDER_HARD_EXPIRY_MS;
    return { ...snapshot, stale: age > refreshMs, expired: age > PROVIDER_HARD_EXPIRY_MS };
  } catch (_) {
    return null;
  }
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function clampPercent(n) {
  return Math.max(0, Math.min(100, n));
}

/**
 * Deep-whitelist + validate a single usage window down to exactly
 * {id?, label, usedPercent, resetsAt?}. Any key not in that list (a raw API
 * payload, an auth header, anything) is silently dropped — never copied
 * through. Returns null when the window's *required* shape is invalid
 * (missing/wrong-typed label or usedPercent, wrong-typed optional fields);
 * callers must treat null as "reject the whole snapshot", never as "skip
 * this window and keep the rest" — a partially-valid window must not render
 * or persist as if it were fully valid. `usedPercent` itself is clamped to
 * [0, 100] rather than rejected, since a provider reporting 100.4% due to
 * rounding is still meaningfully "basically full", not corrupt data.
 */
function sanitizeWindow(w) {
  if (!isPlainObject(w)) return null;
  if (typeof w.label !== 'string' || !w.label.trim()) return null;
  if (typeof w.usedPercent !== 'number' || !Number.isFinite(w.usedPercent)) return null;
  const out = { label: w.label, usedPercent: clampPercent(w.usedPercent) };
  if (w.id !== undefined) {
    if (typeof w.id !== 'string' || !w.id) return null;
    out.id = w.id;
  }
  if (w.resetsAt !== undefined) {
    if (typeof w.resetsAt !== 'number' || !Number.isFinite(w.resetsAt)) return null;
    out.resetsAt = w.resetsAt;
  }
  return out;
}

/**
 * Validate + sanitize an entire windows array. Returns null (reject) when
 * the array itself is malformed or ANY entry fails sanitizeWindow — never
 * returns a partial list, so a corrupt or wrong-shaped window can't fail
 * silently through display or on to disk. Returns [] for a missing array
 * (nothing to show, not an error).
 */
function sanitizeWindows(windows) {
  if (windows == null) return [];
  if (!Array.isArray(windows)) return null;
  const out = [];
  for (const w of windows) {
    const sanitized = sanitizeWindow(w);
    if (!sanitized) return null;
    out.push(sanitized);
  }
  return out;
}

/**
 * Deep-whitelist + validate resetCredits down to exactly
 * {availableCount, nextExpiresAt?}. Same secret-stripping and fail-closed
 * rules as sanitizeWindow. A negative availableCount is not a rounding
 * artifact — it signals corrupt/untrusted data, so it is rejected rather
 * than clamped.
 */
function sanitizeResetCredits(rc) {
  if (!isPlainObject(rc)) return null;
  if (typeof rc.availableCount !== 'number' || !Number.isFinite(rc.availableCount) || rc.availableCount < 0) return null;
  const out = { availableCount: rc.availableCount };
  if (rc.nextExpiresAt !== undefined) {
    if (typeof rc.nextExpiresAt !== 'number' || !Number.isFinite(rc.nextExpiresAt)) return null;
    out.nextExpiresAt = rc.nextExpiresAt;
  }
  return out;
}

/**
 * Build the exact on-disk shape for `provider`, deep-whitelisting every
 * field so nothing beyond the cache schema — least of all a raw API
 * response or a secret nested inside one — can reach disk. Any structural
 * violation (wrong types, out-of-range required fields, one bad window
 * among several good ones) rejects the WHOLE snapshot in favor of a
 * fail-closed 'unavailable' entry, rather than persisting a partially valid
 * result that could render as if it were fully trustworthy.
 */
function buildSafeSnapshot(provider, snapshot) {
  const reject = (reason) => ({ provider, fetchedAt: Date.now(), status: 'unavailable', windows: [], reason });

  if (!snapshot || typeof snapshot !== 'object') return reject('invalid-snapshot');
  if (typeof snapshot.status !== 'string' || !snapshot.status) return reject('invalid-snapshot');

  const windows = sanitizeWindows(snapshot.windows);
  if (windows === null) return reject('invalid-window-shape');

  const safe = { provider, fetchedAt: Date.now(), status: snapshot.status, windows };

  if (snapshot.resetCredits != null) {
    const resetCredits = sanitizeResetCredits(snapshot.resetCredits);
    if (!resetCredits) return reject('invalid-reset-credits');
    safe.resetCredits = resetCredits;
  }
  if (snapshot.reason != null) {
    if (typeof snapshot.reason !== 'string') return reject('invalid-reason');
    safe.reason = snapshot.reason;
  }
  return safe;
}

/**
 * Atomically write a normalized, secret-free snapshot for `provider`.
 * Mode 0600 throughout (temp file included) so nothing world/group-readable
 * ever lands on disk, even momentarily.
 */
function writeSnapshot(provider, snapshot, claudeDir = resolveClaudeDir()) {
  const target = providerCachePath(claudeDir, provider);
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const temp = `${target}.${process.pid}.tmp`;
  const safe = buildSafeSnapshot(provider, snapshot);
  fs.writeFileSync(temp, `${JSON.stringify(safe)}\n`, { mode: 0o600 });
  fs.chmodSync(temp, 0o600);
  fs.renameSync(temp, target);
  fs.chmodSync(target, 0o600);
  return safe;
}

// --- Codex: official account/rateLimits/read collector ---------------------

/**
 * Map a Codex window's `windowDurationMins` to the short label the
 * statusline renders. Exact values per the task brief; anything else falls
 * back to a generic "<n>m" (or "limit" when the duration itself is missing
 * or non-numeric) rather than guessing.
 */
function durationLabel(minutes) {
  if (minutes === 300) return '5h';
  if (minutes === 1_440) return 'day';
  if (minutes === 10_080) return 'wk';
  if (Number.isFinite(minutes)) return `${minutes}m`;
  return 'limit';
}

/**
 * Normalize one `{ usedPercent, windowDurationMins, resetsAt }` window into
 * the shared `{id, label, usedPercent, resetsAt?}` cache shape. Returns null
 * for a structurally unusable window (no numeric usedPercent) so the caller
 * can skip it rather than emit garbage; usedPercent is clamped, not
 * rejected, matching sanitizeWindow's rounding tolerance.
 */
function normalizeCodexWindow(id, w) {
  if (!isPlainObject(w) || typeof w.usedPercent !== 'number' || !Number.isFinite(w.usedPercent)) return null;
  const out = { id, label: durationLabel(w.windowDurationMins), usedPercent: clampPercent(w.usedPercent) };
  if (typeof w.resetsAt === 'number' && Number.isFinite(w.resetsAt)) out.resetsAt = w.resetsAt;
  return out;
}

/**
 * Normalize the raw `account/rateLimits/read` result into a NormalizedSnapshot.
 *
 * Reads the single `rateLimits` group (source id "default") plus every group
 * in `rateLimitsByLimitId` (source id = that limit id). The same underlying
 * quota window is routinely reported through BOTH shapes at once (Codex's
 * "default" plan limit duplicated verbatim under its own limit id) — live
 * verification confirmed `rateLimits.primary` and
 * `rateLimitsByLimitId.codex.primary` reporting identical values. Collapsing
 * that requires *semantic* identity, not just "same source key": two
 * candidates in the same role (`primary`/`secondary`) that report the same
 * `windowDurationMins` + `resetsAt` are the same window surfaced twice, and
 * only the higher-priority one is kept (named `rateLimitsByLimitId` entries
 * outrank the synthetic `default` aggregate). Windows that merely happen to
 * share a `usedPercent` are NOT merged — only duration+resetsAt identifies a
 * window, so two genuinely different windows that coincidentally show the
 * same percentage both survive.
 *
 * Reset credits are reduced to `{availableCount, nextExpiresAt?}` —
 * `availableCount` is the provider's own summary count (not a recount of the
 * credit list), while `nextExpiresAt` is the smallest numeric `expiresAt`
 * among `status === 'available'` credits that is strictly in the future
 * relative to `nowSeconds` (already-expired or `null`/non-numeric expiries
 * are never candidates). Never the raw credit list itself, which may carry
 * identifiers we don't want to cache.
 */
function normalizeCodexRateLimits(result, nowSeconds = Math.floor(Date.now() / 1000)) {
  // priority: named rateLimitsByLimitId entries (1) beat the synthetic
  // "default" aggregate (0) when both describe the same window.
  const candidates = [];
  const collectGroup = (sourceId, group, priority) => {
    if (!isPlainObject(group)) return;
    for (const role of ['primary', 'secondary']) {
      const raw = group[role];
      if (!isPlainObject(raw)) continue;
      if (typeof raw.usedPercent !== 'number' || !Number.isFinite(raw.usedPercent)) continue;
      candidates.push({ id: `${sourceId}:${role}`, role, raw, priority });
    }
  };
  collectGroup('default', result && result.rateLimits, 0);
  if (result && isPlainObject(result.rateLimitsByLimitId)) {
    for (const [limitId, group] of Object.entries(result.rateLimitsByLimitId)) {
      collectGroup(limitId, group, 1);
    }
  }

  // Dedup by semantic identity (role + windowDurationMins + resetsAt), kept
  // in first-seen order but replaced in place by a higher-priority match.
  const order = [];
  const winnerByKey = new Map();
  for (const candidate of candidates) {
    const key = `${candidate.role}:${candidate.raw.windowDurationMins}:${candidate.raw.resetsAt}`;
    const existing = winnerByKey.get(key);
    if (!existing) {
      winnerByKey.set(key, candidate);
      order.push(key);
    } else if (candidate.priority > existing.priority) {
      winnerByKey.set(key, candidate);
    }
  }
  const windows = order
    .map((key) => normalizeCodexWindow(winnerByKey.get(key).id, winnerByKey.get(key).raw))
    .filter(Boolean);

  const out = { windows };
  const rc = result && result.rateLimitResetCredits;
  if (isPlainObject(rc)) {
    let nextExpiresAt;
    if (Array.isArray(rc.credits)) {
      for (const credit of rc.credits) {
        if (!isPlainObject(credit) || credit.status !== 'available') continue;
        if (typeof credit.expiresAt !== 'number' || !Number.isFinite(credit.expiresAt)) continue;
        if (credit.expiresAt <= nowSeconds) continue;
        if (nextExpiresAt === undefined || credit.expiresAt < nextExpiresAt) nextExpiresAt = credit.expiresAt;
      }
    }
    const resetCredits = { availableCount: typeof rc.availableCount === 'number' ? rc.availableCount : 0 };
    if (nextExpiresAt !== undefined) resetCredits.nextExpiresAt = nextExpiresAt;
    out.resetCredits = resetCredits;
  }
  return out;
}

// Reasons `fetchCodex` may return under `status: 'unavailable'`. Kept to
// this exact set per the task brief — never a raw error message, which
// could carry account/path/environment details.
const CODEX_UNAVAILABLE_REASONS = new Set(['codex-missing', 'codex-timeout', 'codex-auth', 'codex-protocol', 'codex-exit']);

/**
 * Speak the minimal JSONL app-server protocol over `codex app-server --stdio`
 * to fetch the logged-in account's rate limits, without ever prompting a
 * model. Sequence: send `initialize` (id 0), wait for its response, then
 * send `initialized` followed by `account/rateLimits/read` (id 1); resolve
 * on the id-1 response's `result`.
 *
 * Never logs stderr (ignored entirely) or any stdout line — those may carry
 * account identifiers or tokens — and always kills the child (success,
 * failure, or timeout) so nothing outlives this call.
 */
function fetchCodexRateLimitsViaAppServer({ timeoutMs = 10_000 } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    let child;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { rl && rl.close(); } catch (_) {}
      try { child && child.kill('SIGKILL'); } catch (_) {}
      resolve(result);
    };

    const timer = setTimeout(() => finish({ ok: false, reason: 'codex-timeout' }), timeoutMs);

    try {
      child = spawn('codex', ['app-server', '--stdio'], { stdio: ['pipe', 'pipe', 'ignore'] });
    } catch (_) {
      finish({ ok: false, reason: 'codex-missing' });
      return;
    }

    child.on('error', () => finish({ ok: false, reason: 'codex-missing' }));
    child.on('exit', (code) => finish({ ok: false, reason: code === 0 ? 'codex-protocol' : 'codex-exit' }));

    const send = (obj) => {
      try { child.stdin.write(`${JSON.stringify(obj)}\n`); } catch (_) {}
    };

    const rl = readline.createInterface({ input: child.stdout });
    rl.on('line', (line) => {
      let msg;
      try { msg = JSON.parse(line); } catch (_) { return; }
      if (!isPlainObject(msg)) return;

      if (msg.id === 0) {
        if (msg.error) { finish({ ok: false, reason: 'codex-auth' }); return; }
        send({ method: 'initialized', params: {} });
        send({ method: 'account/rateLimits/read', id: 1, params: {} });
        return;
      }
      if (msg.id === 1) {
        if (msg.error || !isPlainObject(msg.result)) {
          finish({ ok: false, reason: msg.error ? 'codex-auth' : 'codex-protocol' });
          return;
        }
        finish({ ok: true, result: msg.result });
      }
    });

    send({
      method: 'initialize',
      id: 0,
      params: { clientInfo: { name: 'claude-addons-statusline', title: 'Claude Addons Statusline', version: '1.0.0' } },
    });
  });
}

/**
 * Fetch the current Codex account's rate limits via the official app-server
 * protocol and return a NormalizedSnapshot ready for writeSnapshot. Never
 * throws: any failure resolves to `{ status: 'unavailable', windows: [],
 * reason }` with `reason` restricted to CODEX_UNAVAILABLE_REASONS.
 */
async function fetchCodex() {
  const outcome = await fetchCodexRateLimitsViaAppServer();
  if (!outcome.ok) {
    const reason = CODEX_UNAVAILABLE_REASONS.has(outcome.reason) ? outcome.reason : 'codex-protocol';
    return { status: 'unavailable', windows: [], reason };
  }
  const normalized = normalizeCodexRateLimits(outcome.result);
  return { status: 'ok', ...normalized };
}

// --- Google: official Antigravity statusline collector ----------------------

/**
 * Derive a human-readable label for a quota bucket ID. Exact values per the
 * task brief for known names; anything else is kept compact unchanged.
 */
function antigravityLabel(bucketId) {
  const id = String(bucketId || '').toLowerCase();
  if (id.includes('five-hour') || id.includes('5-hour') || /(^|[-_])5h$/.test(id)) return '5h';
  if (id.includes('day')) return 'day';
  if (id.includes('week') || id.includes('weekly') || /(^|[-_])wk$/.test(id)) return 'wk';
  // Fallback: keep the bucket ID as-is but compact
  return bucketId;
}

/**
 * Normalize a raw Antigravity quota object into a NormalizedSnapshot.
 *
 * Reads quota buckets (e.g., 'gemini-five-hour', 'gemini-weekly') and
 * converts remaining_fraction to used percentage. Reset time is read from
 * ISO reset_time string when present, otherwise calculated from
 * reset_in_seconds relative to the provided nowMs timestamp.
 *
 * Returns { status: 'ok', windows: [...] } ready for writeSnapshot.
 */
function normalizeAntigravityQuota(quota, nowMs = Date.now()) {
  if (!isPlainObject(quota)) return { status: 'unavailable', windows: [], reason: 'invalid-quota' };

  const windows = [];
  for (const [bucketId, data] of Object.entries(quota)) {
    if (!isPlainObject(data)) continue;

    // Extract remaining_fraction and convert to usedPercent
    const remaining = data.remaining_fraction;
    if (typeof remaining !== 'number' || !Number.isFinite(remaining)) continue;
    const usedPercent = Math.round((1 - remaining) * 100);

    // Compute resetsAt in Unix seconds
    let resetsAt;
    if (typeof data.reset_time === 'string') {
      const isoTime = Date.parse(data.reset_time);
      if (Number.isFinite(isoTime)) resetsAt = Math.floor(isoTime / 1000);
    } else if (typeof data.reset_in_seconds === 'number' && Number.isFinite(data.reset_in_seconds)) {
      resetsAt = Math.floor((nowMs + data.reset_in_seconds * 1000) / 1000);
    }

    const window = {
      id: bucketId,
      label: antigravityLabel(bucketId),
      usedPercent: clampPercent(usedPercent),
    };
    if (resetsAt !== undefined) window.resetsAt = resetsAt;
    windows.push(window);
  }

  return { status: 'ok', windows };
}

const PRESERVE_PROVIDER_CACHE = Symbol('preserve-provider-cache');

function isValidOkSnapshot(snapshot) {
  if (!snapshot || snapshot.status !== 'ok') return false;
  if (sanitizeWindows(snapshot.windows) === null) return false;
  if (snapshot.resetCredits != null && !sanitizeResetCredits(snapshot.resetCredits)) return false;
  return true;
}

/**
 * Fetch Google Gemini quota. There is nothing to fetch: the official
 * Antigravity CLI (`agy`) is the only thing that knows these numbers, and it
 * hands them over through its own status-line callback, which invokes
 * `capture-antigravity` (the sole writer of this cache) whenever the user has
 * the client open. Launching the client from here was tried and removed —
 * outside the user's own terminal it stalls on sign-in and never reaches the
 * callback, so the spawn bought nothing and risked leaving stray sign-in
 * processes behind. This collector therefore starts no process at all.
 *
 * A prior valid snapshot is preserved untouched (the renderer decides whether
 * it is still meaningful, from the windows' own reset times); with no such
 * snapshot the result is an explicit 'unavailable' so the meter says so
 * plainly rather than showing nothing.
 */
async function fetchGoogle({ claudeDir = resolveClaudeDir() } = {}) {
  const prior = readProviderSnapshot(claudeDir, 'google');
  if (isValidOkSnapshot(prior)) return PRESERVE_PROVIDER_CACHE;
  return { status: 'unavailable', windows: [], reason: 'antigravity-no-callback' };
}

// --- Grok: local usage-log reader --------------------------------------
//
// Grok has no `/usage`/`/help` command, and launching the live client to read
// its automatic startup banner (the original approach) hangs indefinitely on
// "Signing in… starting your session." whenever it runs outside the user's
// own interactive terminal — see the task 5B ruling. So this collector never
// launches the client, and never touches its credentials (`auth.json` is
// never opened) or sends it any input. Instead it reads Grok's own
// authoritative usage record, which the live client already writes to a
// local, append-only log on every session/config update:
// `~/.grok/logs/unified.jsonl`, one JSON object per line. The newest line
// carrying `ctx.config.creditUsagePercent` holds the exact numbers the live
// client's own screen shows (verified against a real session, per the task
// brief). Only the file's last GROK_LOG_TAIL_BYTES are ever read, and only
// four fields of one line (`ts`, `creditUsagePercent`, `currentPeriod.end`)
// are ever extracted from it — no other field of a log line (which may carry
// account/session detail) is copied through, and no raw log content is ever
// cached (only the whitelisted `{id, label, usedPercent, resetsAt}` window
// survives into the snapshot `writeSnapshot` persists).

// Only 'grok-missing' (no readable log file) and 'grok-parse' (unparseable,
// or the only usable entry's period has already elapsed) are reachable now
// that this collector never spawns a process — kept as its own set (rather
// than inlining the strings) so a future reason added here can't silently
// widen what `grokUnavailable` accepts.
const GROK_UNAVAILABLE_REASONS = new Set(['grok-missing', 'grok-parse']);

function grokUnavailable(reason) {
  return { status: 'unavailable', windows: [], reason: GROK_UNAVAILABLE_REASONS.has(reason) ? reason : 'grok-parse' };
}

// Never read more of the log than this, however large the file has grown —
// the newest usage entry is always near the end of this append-only file, and
// capping here means a multi-GB log can never turn this into an unbounded
// read.
const GROK_LOG_TAIL_BYTES = 256 * 1024;

/**
 * Read up to the last `maxBytes` bytes of `target` without ever loading the
 * whole file into memory. Returns null (never throws) when the file is
 * missing, unreadable, or anything else goes wrong opening/reading it — every
 * such case is `fetchGrok`'s `grok-missing`.
 */
function readFileTail(target, maxBytes) {
  let fd;
  try {
    fd = fs.openSync(target, 'r');
    const size = fs.fstatSync(fd).size;
    const length = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, size - length);
    return buffer.toString('utf8');
  } catch (_) {
    return null;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch (_) {}
    }
  }
}

/**
 * Parse the raw tail of Grok's local usage log into a NormalizedSnapshot with
 * exactly one `{id: 'weekly', label: 'wk', usedPercent, resetsAt}` window.
 *
 * Lines are scanned newest-first (the log is append-only, one JSON object per
 * line). A line that isn't valid JSON, isn't an object, or lacks a finite
 * `ctx.config.creditUsagePercent` is unrelated noise and is skipped in favor
 * of an older line — it is never itself a fail-closed condition. The first
 * (i.e. newest) line that *does* carry a finite percent is treated as the
 * authoritative record and is not abandoned in favor of an older one even if
 * the rest of it turns out malformed: a real Grok log entry always writes the
 * percent and its period together, so requiring both fields to come from the
 * same physical record is safer than assembling one from two different
 * points in time.
 *
 * Fails closed (`grok-parse`) when: no line anywhere in the text carries a
 * finite `creditUsagePercent`, the selected line's
 * `ctx.config.currentPeriod.end` is missing or not a parseable timestamp, or
 * that period has already ended relative to `nowMs` — Grok always reports a
 * forthcoming reset, never one that already happened.
 */
function parseGrokUsageLog(text, nowMs = Date.now()) {
  if (typeof text !== 'string') return grokUnavailable('grok-parse');

  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;

    let entry;
    try {
      entry = JSON.parse(line);
    } catch (_) {
      continue; // Not JSON — unrelated log noise, keep scanning backward.
    }
    if (!isPlainObject(entry) || !isPlainObject(entry.ctx) || !isPlainObject(entry.ctx.config)) continue;

    const usedPercent = entry.ctx.config.creditUsagePercent;
    if (typeof usedPercent !== 'number' || !Number.isFinite(usedPercent)) continue;

    // The newest line carrying a usable percent has been found; validate the
    // rest of *this* record as a unit rather than falling back further.
    const period = entry.ctx.config.currentPeriod;
    const end = isPlainObject(period) ? period.end : undefined;
    if (typeof end !== 'string') return grokUnavailable('grok-parse');
    const endMs = Date.parse(end);
    if (!Number.isFinite(endMs) || endMs <= nowMs) return grokUnavailable('grok-parse');

    return {
      status: 'ok',
      windows: [{ id: 'weekly', label: 'wk', usedPercent: clampPercent(usedPercent), resetsAt: Math.floor(endMs / 1000) }],
    };
  }
  return grokUnavailable('grok-parse');
}

/**
 * Fetch Grok's weekly usage window by reading its own local usage log —
 * never spawning the client, never touching its credentials, never sending
 * it input. `logPath`/`nowMs` are injectable only for tests; every real
 * caller uses the real log at the default path.
 */
async function fetchGrok({
  claudeDir = resolveClaudeDir(),
  logPath = path.join(os.homedir(), '.grok', 'logs', 'unified.jsonl'),
  nowMs = Date.now(),
} = {}) {
  const prior = readProviderSnapshot(claudeDir, 'grok');
  const preservePrior = isValidOkSnapshot(prior);
  const failure = (reason) => (preservePrior ? PRESERVE_PROVIDER_CACHE : grokUnavailable(reason));

  const tail = readFileTail(logPath, GROK_LOG_TAIL_BYTES);
  if (tail === null) return failure('grok-missing');

  const parsed = parseGrokUsageLog(tail, nowMs);
  if (parsed.status !== 'ok') return failure('grok-parse');

  return { status: 'ok', windows: parsed.windows };
}

// Provider fetchers. Task 2 shipped only the dispatch skeleton. Later tasks
// add real network collectors by registering a fetcher here (task 3: codex,
// task 4: google, task 5: grok) — each returns
// { status, windows, resetCredits?, reason? } which writeSnapshot then
// normalizes and persists.
const FETCHERS = { codex: fetchCodex, google: fetchGoogle, grok: fetchGrok };

/**
 * Run the fetcher for `provider` (if one is registered) and persist the
 * result via writeSnapshot. Unknown/unimplemented providers, and fetchers
 * that throw or reject, always produce a fail-closed 'unavailable' cache
 * entry rather than leaving a stale or partial file behind. Always returns a
 * Promise (even for the synchronous no-fetcher path) so every call site can
 * await it uniformly.
 */
async function fetchProvider(provider, claudeDir = resolveClaudeDir()) {
  const fetcher = FETCHERS[provider];
  if (!fetcher) {
    return writeSnapshot(provider, { status: 'unavailable', windows: [], reason: 'unsupported-provider' }, claudeDir);
  }
  try {
    const result = await fetcher({ claudeDir });
    if (result === PRESERVE_PROVIDER_CACHE) {
      return readProviderSnapshot(claudeDir, provider);
    }
    return writeSnapshot(provider, result, claudeDir);
  } catch (_) {
    return writeSnapshot(provider, { status: 'unavailable', windows: [], reason: 'fetch-error' }, claudeDir);
  }
}

/**
 * Read a single JSON object from stdin with a timeout, used by the
 * Antigravity CLI's statusline hook to feed quota data.
 */
async function readStdinJson(timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    let settled = false;

    // Release stdin's read handle once we're done, whether that's because a
    // complete JSON object parsed mid-stream, 'end' fired, an error
    // occurred, or we timed out. The official callback pipe is not
    // guaranteed to close its write end right after sending the payload
    // (unlike a one-shot `spawnSync` caller), so simply resolving without
    // this leaves an active 'data' listener on process.stdin — that keeps
    // the event loop open and the process alive indefinitely even though
    // the answer is already known.
    const cleanup = () => {
      clearTimeout(timer);
      process.stdin.removeListener('data', onData);
      process.stdin.removeListener('end', onEnd);
      process.stdin.removeListener('error', onError);
      try { process.stdin.pause(); } catch (_) {}
      try { process.stdin.unref(); } catch (_) {}
      try { process.stdin.destroy(); } catch (_) {}
    };
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn(value);
    };

    const timer = setTimeout(() => settle(reject, new Error('stdin timeout')), timeoutMs);

    let data = '';
    process.stdin.setEncoding('utf8');
    const onData = (chunk) => {
      data += chunk;
      // Try to parse after each chunk in case a complete JSON arrives
      try {
        const json = JSON.parse(data);
        settle(resolve, json);
      } catch (_) {
        // Not valid JSON yet, keep reading
      }
    };
    const onEnd = () => {
      try {
        settle(resolve, JSON.parse(data));
      } catch (_) {
        settle(reject, new Error('invalid JSON from stdin'));
      }
    };
    const onError = (err) => settle(reject, err);

    process.stdin.on('data', onData);
    process.stdin.on('end', onEnd);
    process.stdin.on('error', onError);
  });
}

async function main() {
  const [, , command, arg] = process.argv;

  if (command === 'capture-antigravity') {
    let data;
    try {
      data = await readStdinJson(3000);
    } catch (_) {
      // Genuinely unparsable input (invalid JSON) or a stdin timeout: we
      // can't tell what the client wanted, so this stays a real failure
      // (nonzero exit), though still silent (no stdout/stderr noise).
      process.exitCode = 1;
      return;
    }
    // A well-formed JSON payload with no usable `quota` is normal, expected
    // traffic, not malformed data: the official Antigravity CLI fires its
    // statusline callback before Google auth completes, and on other state
    // changes, with quota entirely absent. Treat it as "provider not ready
    // yet" — exit 0, write nothing, print nothing — rather than surfacing a
    // visible statusline error for a condition that resolves itself on the
    // next callback.
    if (!isPlainObject(data) || !isPlainObject(data.quota)) return;
    const normalized = normalizeAntigravityQuota(data.quota);
    writeSnapshot('google', normalized, resolveClaudeDir());
    return;
  }

  if (command !== 'fetch' || !arg) {
    process.stderr.write('Usage: provider-usage.js fetch <provider>\n');
    process.stderr.write('       provider-usage.js capture-antigravity < quota.json\n');
    process.exitCode = 1;
    return;
  }
  await fetchProvider(arg, resolveClaudeDir());
}

module.exports = {
  PROVIDER_REFRESH_MS,
  PROVIDER_HARD_EXPIRY_MS,
  providerCachePath,
  readProviderSnapshot,
  writeSnapshot,
  fetchProvider,
  // Shared validation, reused by the renderer so read-time trust in an
  // on-disk cache file (which may predate this validation, or be
  // hand-crafted/corrupt) matches write-time trust exactly.
  sanitizeWindows,
  normalizeCodexRateLimits,
  fetchCodex,
  normalizeAntigravityQuota,
  fetchGoogle,
  // Exposed only so tests can exercise the process/protocol layer against a
  // stub `codex` binary with a short timeout, without waiting out the real
  // 10s default or spawning the real CLI.
  fetchCodexRateLimitsViaAppServer,
  // Exposed so tests can exercise the log parser directly with hand-built
  // JSONL fixtures, without writing a temp file for every case.
  parseGrokUsageLog,
  fetchGrok,
};

if (require.main === module) {
  main().catch(() => { process.exitCode = 1; });
}
