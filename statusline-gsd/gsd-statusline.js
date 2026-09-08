#!/usr/bin/env node
// gsd-hook-version: {{GSD_VERSION}}
// Claude Code Statusline - GSD Edition
// Shows: model | current task (or GSD state) | directory | context usage

const fs = require('fs');
const path = require('path');
const os = require('os');
const { providerCachePath, readProviderSnapshot, sanitizeWindows } = require('./provider-usage');

// isPlainObject/sanitizeResetCredits below mirror the same-named validation
// in provider-usage.js (sanitizeResetCredits deep-whitelists a snapshot's
// resetCredits down to exactly {availableCount, nextExpiresAt?}). Kept as a
// local copy rather than importing/exporting it, so the renderer never
// trusts an on-disk cache file blindly — same fail-closed rule already
// applied to windows via sanitizeWindows. Keep in sync with provider-usage.js
// if that function's rules ever change.
function isPlainObject(v) {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

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

// --- Config + last-command readers ------------------------------------------

/**
 * Walk up from dir looking for .planning/config.json and return its parsed contents.
 * Returns {} if not found or unreadable.
 */
function readGsdConfig(dir) {
  const home = os.homedir();
  let current = dir;
  for (let i = 0; i < 10; i++) {
    const candidate = path.join(current, '.planning', 'config.json');
    if (fs.existsSync(candidate)) {
      try {
        return JSON.parse(fs.readFileSync(candidate, 'utf8')) || {};
      } catch (e) {
        return {};
      }
    }
    const parent = path.dirname(current);
    if (parent === current || current === home) break;
    current = parent;
  }
  return {};
}

/**
 * Lookup a dotted key path (e.g. 'statusline.show_last_command') in a config
 * object that may use either nested or flat keys.
 */
function getConfigValue(cfg, keyPath) {
  if (!cfg || typeof cfg !== 'object') return undefined;
  if (keyPath in cfg) return cfg[keyPath];
  const parts = keyPath.split('.');
  let cur = cfg;
  for (const p of parts) {
    if (cur == null || typeof cur !== 'object' || !(p in cur)) return undefined;
    cur = cur[p];
  }
  return cur;
}

/**
 * Extract the most recently invoked slash command from a Claude Code JSONL
 * transcript file. Returns the command name (no leading slash) or null.
 *
 * Claude Code embeds slash invocations in user messages as
 *   <command-name>/foo</command-name>
 * We scan lines from the end of the file, stopping at the first match.
 */
function readLastSlashCommand(transcriptPath) {
  if (!transcriptPath || typeof transcriptPath !== 'string') return null;
  let content;
  try {
    if (!fs.existsSync(transcriptPath)) return null;
    // Read only the tail — typical transcripts grow large. 256 KiB comfortably
    // covers dozens of recent turns while staying cheap per render.
    const stat = fs.statSync(transcriptPath);
    const MAX = 256 * 1024;
    const start = Math.max(0, stat.size - MAX);
    const fd = fs.openSync(transcriptPath, 'r');
    try {
      const buf = Buffer.alloc(stat.size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      content = buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch (e) {
    return null;
  }
  // Find the LAST occurrence — scan right-to-left via lastIndexOf on the tag.
  const tagClose = '</command-name>';
  const idx = content.lastIndexOf(tagClose);
  if (idx < 0) return null;
  const openTag = '<command-name>';
  const openIdx = content.lastIndexOf(openTag, idx);
  if (openIdx < 0) return null;
  let name = content.slice(openIdx + openTag.length, idx).trim();
  // Strip a leading slash if present, and any trailing arguments-on-same-line noise.
  if (name.startsWith('/')) name = name.slice(1);
  // Command names in Claude Code transcripts are plain identifiers like "gsd-plan-phase"
  // or namespaced like "plugin:skill". Reject anything with whitespace/newlines/control chars.
  if (!name || /[\s\\"<>]/.test(name) || name.length > 80) return null;
  return name;
}

// --- GSD state reader -------------------------------------------------------

/**
 * Walk up from dir looking for .planning/STATE.md.
 * Returns parsed state object or null.
 */
function readGsdState(dir) {
  const home = os.homedir();
  let current = dir;
  for (let i = 0; i < 10; i++) {
    const candidate = path.join(current, '.planning', 'STATE.md');
    if (fs.existsSync(candidate)) {
      try {
        return parseStateMd(fs.readFileSync(candidate, 'utf8'));
      } catch (e) {
        return null;
      }
    }
    const parent = path.dirname(current);
    if (parent === current || current === home) break;
    current = parent;
  }
  return null;
}

/**
 * Parse STATE.md frontmatter + Phase line from body.
 * Returns { status, milestone, milestoneName, phaseNum, phaseTotal, phaseName }
 */
function parseStateMd(content) {
  const state = {};

  // YAML frontmatter between --- markers
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (fmMatch) {
    for (const line of fmMatch[1].split('\n')) {
      const m = line.match(/^(\w+):\s*(.+)/);
      if (!m) continue;
      const [, key, val] = m;
      const v = val.trim().replace(/^["']|["']$/g, '');
      if (key === 'status') state.status = v === 'null' ? null : v;
      if (key === 'milestone') state.milestone = v === 'null' ? null : v;
      if (key === 'milestone_name') state.milestoneName = v === 'null' ? null : v;
    }
  }

  // Phase: N of M (name)  or  Phase: none active (...)
  const phaseMatch = content.match(/^Phase:\s*(\d+)\s+of\s+(\d+)(?:\s+\(([^)]+)\))?/m);
  if (phaseMatch) {
    state.phaseNum = phaseMatch[1];
    state.phaseTotal = phaseMatch[2];
    state.phaseName = phaseMatch[3] || null;
  }

  // Fallback: parse Status: from body when frontmatter is absent
  if (!state.status) {
    const bodyStatus = content.match(/^Status:\s*(.+)/m);
    if (bodyStatus) {
      const raw = bodyStatus[1].trim().toLowerCase();
      if (raw.includes('ready to plan') || raw.includes('planning')) state.status = 'planning';
      else if (raw.includes('execut')) state.status = 'executing';
      else if (raw.includes('complet') || raw.includes('archived')) state.status = 'complete';
    }
  }

  return state;
}

/**
 * Format GSD state into display string.
 * Format: "v1.9 Code Quality · executing · fix-graphiti-deployment (1/5)"
 * Gracefully degrades when parts are missing.
 */
function formatGsdState(s) {
  const parts = [];

  // Milestone: version + name (skip placeholder "milestone")
  if (s.milestone || s.milestoneName) {
    const ver = s.milestone || '';
    const name = (s.milestoneName && s.milestoneName !== 'milestone') ? s.milestoneName : '';
    const ms = [ver, name].filter(Boolean).join(' ');
    if (ms) parts.push(ms);
  }

  // Status
  if (s.status) parts.push(s.status);

  // Phase
  if (s.phaseNum && s.phaseTotal) {
    const phase = s.phaseName
      ? `${s.phaseName} (${s.phaseNum}/${s.phaseTotal})`
      : `ph ${s.phaseNum}/${s.phaseTotal}`;
    parts.push(phase);
  }

  return parts.join(' · ');
}

// --- Plan usage (5h session / weekly / per-model weekly) ---------------------

const USAGE_CACHE_TTL_MS = 60_000;

function usageColor(pct) {
  if (pct < 50) return '32';
  if (pct < 65) return '33';
  if (pct < 80) return '38;5;208';
  return '31';
}

// 10-segment block bar, same style as the context-window meter.
function buildBar(pct) {
  const filled = Math.floor(pct / 10);
  return '█'.repeat(filled) + '░'.repeat(10 - filled);
}

// Fixed per-category colors (category identity, not severity like usageColor).
const SESSION_COLOR = '36';   // cyan
const WEEKLY_COLOR = '35';    // magenta
const MODEL_COLORS = ['33', '34', '32', '31']; // rotate for scoped-model entries

// A reset two days out or further is a date question, not a stopwatch
// question: "517h55m → 03:17" is unreadable, and the wall clock alone is
// actively misleading because it hides which day the reset lands on.
const RESET_DAYS_BAND_MINUTES = 48 * 60;

// Accepts epoch seconds (statusline stdin) or ISO string (oauth/usage cache).
// Returns "45m → 14:09" under an hour, "2h07m → 16:49" from one hour up to
// (but not including) 48 hours, and "3d → 31/8" from 48 hours out — time left
// until reset plus either the local wall clock or the local date it lands on.
function formatReset(resetsAt) {
  if (resetsAt == null) return '';
  const t = typeof resetsAt === 'number' ? resetsAt * 1000 : Date.parse(resetsAt);
  if (!t || isNaN(t)) return '';
  const mins = Math.round((t - Date.now()) / 60000);
  if (mins <= 0) return '';
  if (mins >= RESET_DAYS_BAND_MINUTES) {
    // Whole days only — a trailing "and a bit" is noise at this distance.
    const days = Math.floor(mins / (24 * 60));
    return `${days}d`;
  }
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  // Time-until only. The absolute clock time it lands on was pure duplication.
  return h > 0 ? `${h}h${String(m).padStart(2, '0')}m` : `${m}m`;
}

/**
 * Read the cached api/oauth/usage response and kick off a detached background
 * refresh when the cache is older than USAGE_CACHE_TTL_MS. Never blocks and
 * never throws — the render path only ever touches the local cache file.
 */
function readUsageCache(claudeDir) {
  const cachePath = path.join(claudeDir, 'cache', 'claude-usage.json');
  let cached = null;
  let stale = true;
  try {
    stale = Date.now() - fs.statSync(cachePath).mtimeMs > USAGE_CACHE_TTL_MS;
    cached = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
  } catch (e) {}
  if (stale) {
    // Lock file throttles spawns so overlapping renders don't stack fetches.
    const lockPath = path.join(os.tmpdir(), 'claude-usage-fetch.lock');
    let locked = false;
    try { locked = Date.now() - fs.statSync(lockPath).mtimeMs < 30_000; } catch (e) {}
    if (!locked) {
      try {
        fs.writeFileSync(lockPath, String(process.pid));
        const fetcher = path.join(claudeDir, 'scripts', 'usage-fetch.sh');
        if (fs.existsSync(fetcher)) {
          const child = require('child_process').spawn(fetcher, [], { detached: true, stdio: 'ignore' });
          child.unref();
        }
      } catch (e) {}
    }
  }
  return cached;
}

/**
 * Build the usage segment: " │ 5h 60% ↻2h07m │ wk 31% · Fable 53%".
 * Session + weekly come from statusline stdin (data.rate_limits) when present
 * (subscription plans only, populated after the first API response), falling
 * back to the cached endpoint data. The per-model weekly slice exists only in
 * the endpoint response (limits[] entries with kind === "weekly_scoped").
 */
function formatUsage(data, claudeDir) {
  const cached = readUsageCache(claudeDir);
  const rl = data.rate_limits;

  let fiveHour = rl?.five_hour?.used_percentage;
  let fiveHourReset = rl?.five_hour?.resets_at;
  let weekly = rl?.seven_day?.used_percentage;
  if (fiveHour == null && cached?.five_hour) {
    fiveHour = cached.five_hour.utilization;
    fiveHourReset = cached.five_hour.resets_at;
  }
  if (weekly == null && cached?.seven_day) weekly = cached.seven_day.utilization;

  const scopedLimits = (cached?.limits || []).filter(
    l => l && l.kind === 'weekly_scoped' && l.percent != null && l.scope?.model?.display_name
  );

  const parts = [];
  if (fiveHour != null) {
    const pct = Math.round(fiveHour);
    const reset = formatReset(fiveHourReset);
    parts.push(`\x1b[${SESSION_COLOR}m5h ${buildBar(pct)} ${pct}%\x1b[0m${reset ? ` \x1b[36m↻${reset}\x1b[0m` : ''}`);
  }
  if (weekly != null) {
    const pct = Math.round(weekly);
    parts.push(`\x1b[${WEEKLY_COLOR}mwk ${buildBar(pct)} ${pct}%\x1b[0m`);
  }
  scopedLimits.forEach((l, i) => {
    const pct = Math.round(l.percent);
    const color = MODEL_COLORS[i % MODEL_COLORS.length];
    parts.push(`\x1b[${color}m${l.scope.model.display_name} ${buildBar(pct)} ${pct}%\x1b[0m`);
  });
  return parts.length ? ` │ ${parts.join(' │ ')}` : '';
}

// --- Provider-aware usage (non-Claude models) --------------------------------

const PROVIDER_LABELS = { codex: 'Codex', google: 'Google', grok: 'Grok' };

// Throttle window matches the Claude fetch lock below — keeps overlapping
// renders from stacking spawns while a background collector is in flight.
const PROVIDER_LOCK_TTL_MS = 30_000;

/**
 * Spawn the detached collector for `provider` unless a recent spawn is still
 * in flight (one lock file per provider in os.tmpdir()). Never blocks and
 * never throws — the render path only ever touches the local cache file.
 */
function spawnProviderCollector(claudeDir, provider) {
  try {
    const lockPath = path.join(os.tmpdir(), `provider-usage-fetch-${provider}.lock`);
    let locked = false;
    try { locked = Date.now() - fs.statSync(lockPath).mtimeMs < PROVIDER_LOCK_TTL_MS; } catch (e) {}
    if (locked) return;
    fs.writeFileSync(lockPath, String(process.pid));
    const collector = path.join(__dirname, 'provider-usage.js');
    if (!fs.existsSync(collector)) return;
    const child = require('child_process').spawn(
      process.execPath,
      [collector, 'fetch', provider],
      { detached: true, stdio: 'ignore', env: { ...process.env, CLAUDE_CONFIG_DIR: claudeDir } }
    );
    child.unref();
  } catch (e) {}
}

/**
 * Provider-aware replacement for the usage segment. Claude models delegate
 * unchanged to formatUsage (and its own cache/spawn path) — no non-Claude
 * code below this branch ever runs, so a non-Claude model can never trigger
 * or read the Claude usage cache, and Claude never touches provider caches.
 * Non-Claude models read only their own namespaced cache file
 * (provider-usage-<provider>.json) and render normalized windows; missing,
 * malformed and non-'ok' caches render "<Provider> usage unavailable"
 * instead of stale/garbage numbers, as do caches past the age-based hard
 * expiry for every provider that can refresh itself. Google is the one
 * exception — see the usability rule inside formatProviderUsage.
 */
function shortUsageLabel(w) {
  const s = `${w.id || ''} ${w.label || ''}`.toLowerCase();
  if (/(five-hour|5-hour|(?:^|[^a-z])5h(?:$|[^a-z]))/.test(s)) return '5h';
  if (/(week|\bwk\b)/.test(s)) return 'wk';
  if (/\bday\b/.test(s)) return 'day';
  return (w.label || '').trim() || 'limit';
}

function windowPool(w) {
  const s = `${w.id || ''} ${w.label || ''}`.toLowerCase();
  if (s.includes('gemini')) return 'gemini';
  if (/(?:^|[^a-z])3p(?:$|[^a-z])/.test(s)) return '3p';
  return 'other';
}

/**
 * Whether any window still has a reset ahead of `now` — i.e. the snapshot
 * describes a quota period that has not yet turned over, so its percentages
 * are still the current ones no matter how old the file itself is. A window
 * without a resetsAt cannot vouch for itself and never counts.
 */
function hasUnspentWindow(windows, now) {
  if (!Array.isArray(windows)) return false;
  return windows.some((w) => typeof w.resetsAt === 'number' && Number.isFinite(w.resetsAt) && w.resetsAt * 1000 > now);
}

/** At most 5h + wk (same shape as Claude). Gemini sessions hide the 3p buckets. */
function selectProviderWindows(provider, modelName, windows) {
  if (!Array.isArray(windows) || windows.length === 0) return windows;
  let source = windows;
  if (provider === 'google') {
    const want = /gemini/i.test(modelName || '') ? 'gemini' : '3p';
    const pooled = windows.filter((w) => windowPool(w) === want);
    if (pooled.length) source = pooled;
  }
  const byLabel = new Map();
  for (const w of source) {
    const label = shortUsageLabel(w);
    if (!byLabel.has(label)) byLabel.set(label, { ...w, label });
  }
  return ['5h', 'wk', 'day'].map((l) => byLabel.get(l)).filter(Boolean);
}

/**
 * Build the "resets N [· next expires ...]" segment from a snapshot's
 * resetCredits, re-validating at render time (mirrors sanitizeResetCredits
 * in provider-usage.js) so a malformed/hand-edited cache file can never
 * render a partial or guessed value. Renders nothing when availableCount is
 * 0/absent/invalid, or when resetCredits itself is malformed. When
 * nextExpiresAt is present but formatReset resolves it to a past time (or a
 * bad value), the segment still renders with the count alone.
 */
function formatResetCredits(resetCredits) {
  const rc = sanitizeResetCredits(resetCredits);
  if (!rc || rc.availableCount < 1) return '';
  let seg = `resets ${rc.availableCount}`;
  if (rc.nextExpiresAt != null) {
    const reset = formatReset(rc.nextExpiresAt);
    if (reset) seg += ` · next expires ${reset}`;
  }
  return `\x1b[2m${seg}\x1b[0m`;
}

function formatProviderUsage(data, claudeDir, now = Date.now()) {
  const provider = providerForModel(data?.model?.display_name);
  if (provider === 'claude') return formatUsage(data, claudeDir);
  if (provider === 'other') return '';

  const label = PROVIDER_LABELS[provider] || provider;
  const snapshot = readProviderSnapshot(claudeDir, provider, now);

  // Spawn the collector only when the cache is stale or missing/malformed.
  if (!snapshot || snapshot.stale) {
    spawnProviderCollector(claudeDir, provider);
  }

  // Re-validate the full normalized shape at render time too, not just at
  // write time — an on-disk cache file may predate this validation, be
  // hand-edited, or be corrupt, and the renderer must never trust it blindly
  // (a malformed window must fail closed to "unavailable", not render as
  // "undefined%"/"NaN%"). Any single invalid window rejects the whole
  // render, matching writeSnapshot's fail-closed-not-partial rule.
  const windows = snapshot ? sanitizeWindows(snapshot.windows) : null;

  // Google's numbers only ever arrive when the user has the Antigravity
  // client open — nothing here can go and fetch them, so an age-based
  // expiry would blank the meter for everyone who isn't running that client
  // right now, even though the quota it last reported is still the live one.
  // The windows carry their own truth: a window that has not reset yet still
  // describes today's quota however old the file is, and once every window's
  // reset has passed the numbers are genuinely spent and must not be shown.
  // Every other provider can refresh itself, so they keep the age-based
  // hard expiry.
  const usable = provider === 'google' ? hasUnspentWindow(windows, now) : !snapshot?.expired;

  if (!snapshot || snapshot.status !== 'ok' || !usable || !windows || windows.length === 0) {
    return ` │ ${label} usage unavailable`;
  }

  const shown = selectProviderWindows(provider, data?.model?.display_name, windows);
  const parts = shown.map((w, i) => {
    const pct = Math.round(w.usedPercent);
    const color = MODEL_COLORS[i % MODEL_COLORS.length];
    // Match Claude: reset clock only on the session (5h) meter, not weekly.
    const reset = w.label === '5h' && w.resetsAt != null ? formatReset(w.resetsAt) : '';
    return `\x1b[${color}m${w.label} ${buildBar(pct)} ${pct}%\x1b[0m${reset ? ` \x1b[36m↻${reset}\x1b[0m` : ''}`;
  });

  // Reset-credits segment (e.g. Codex's limited-time rate-limit resets),
  // appended after the window segments. Absent/invalid/0-count renders
  // nothing extra — see formatResetCredits.
  const resetsSeg = formatResetCredits(snapshot.resetCredits);
  if (resetsSeg) parts.push(resetsSeg);

  // Stale-but-not-expired data still renders (cheaper than flashing
  // "unavailable" every refresh interval) but is visibly marked as such.
  const staleSuffix = snapshot.stale ? ' \x1b[2m(stale)\x1b[0m' : '';
  return ` │ ${parts.join(' │ ')}${staleSuffix}`;
}

// --- stdin ------------------------------------------------------------------

function runStatusline() {
  let input = '';
  // Timeout guard: if stdin doesn't close within 3s (e.g. pipe issues on
  // Windows/Git Bash), exit silently instead of hanging. See #775.
  const stdinTimeout = setTimeout(() => process.exit(0), 3000);
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => input += chunk);
  process.stdin.on('end', () => {
  clearTimeout(stdinTimeout);
  try {
    const data = JSON.parse(input);
    const modelLabel = formatModelLabel(data);
    const dir = data.workspace?.current_dir || process.cwd();
    const session = data.session_id || '';
    const remaining = data.context_window?.remaining_percentage;

    // Context window display (shows USED percentage scaled to usable context)
    // Claude Code reserves a buffer for autocompact. By default this is ~16.5%
    // of the total window, but users can override it via CLAUDE_CODE_AUTO_COMPACT_WINDOW
    // (a token count). When the env var is set, compute the buffer % dynamically so
    // the meter correctly reflects early-compaction configurations (#2219).
    const totalCtx = data.context_window?.context_window_size || data.context_window?.total_tokens || 1_000_000;
    const acw = parseInt(process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW || '0', 10);
    const AUTO_COMPACT_BUFFER_PCT = acw > 0
      ? Math.min(100, (acw / totalCtx) * 100)
      : 16.5;
    let ctx = '';
    if (remaining != null) {
      // Normalize: subtract buffer from remaining, scale to usable range
      const usableRemaining = Math.max(0, ((remaining - AUTO_COMPACT_BUFFER_PCT) / (100 - AUTO_COMPACT_BUFFER_PCT)) * 100);
      const used = Math.max(0, Math.min(100, Math.round(100 - usableRemaining)));

      // Write context metrics to bridge file for the context-monitor PostToolUse hook.
      // The monitor reads this file to inject agent-facing warnings when context is low.
      // Reject session IDs with path separators or traversal sequences to prevent
      // a malicious session_id from writing files outside the temp directory.
      const sessionSafe = session && !/[/\\]|\.\./.test(session);
      if (sessionSafe) {
        try {
          const bridgePath = path.join(os.tmpdir(), `claude-ctx-${session}.json`);
          // used_pct written to the bridge must match CC's native /context reporting:
          // raw used = 100 - remaining_percentage (no buffer normalization applied).
          // The normalized `used` value is correct for the statusline progress bar but
          // inflates the context monitor warning messages by ~13 points (#2451).
          const rawUsedPct = Math.round(100 - remaining);
          const bridgeData = JSON.stringify({
            session_id: session,
            remaining_percentage: remaining,
            used_pct: rawUsedPct,
            timestamp: Math.floor(Date.now() / 1000)
          });
          fs.writeFileSync(bridgePath, bridgeData);
        } catch (e) {
          // Silent fail -- bridge is best-effort, don't break statusline
        }
      }

      // Build progress bar (10 segments)
      const filled = Math.floor(used / 10);
      const bar = '█'.repeat(filled) + '░'.repeat(10 - filled);

      // Color based on usable context thresholds
      if (used < 50) {
        ctx = ` \x1b[32m${bar} ${used}%\x1b[0m`;
      } else if (used < 65) {
        ctx = ` \x1b[33m${bar} ${used}%\x1b[0m`;
      } else if (used < 80) {
        ctx = ` \x1b[38;5;208m${bar} ${used}%\x1b[0m`;
      } else {
        ctx = ` \x1b[5;31m💀 ${bar} ${used}%\x1b[0m`;
      }
    }

    // Current task from todos
    let task = '';
    const homeDir = os.homedir();
    // Respect CLAUDE_CONFIG_DIR for custom config directory setups (#870)
    const claudeDir = process.env.CLAUDE_CONFIG_DIR || path.join(homeDir, '.claude');
    const todosDir = path.join(claudeDir, 'todos');
    if (session && fs.existsSync(todosDir)) {
      try {
        const files = fs.readdirSync(todosDir)
          .filter(f => f.startsWith(session) && f.includes('-agent-') && f.endsWith('.json'))
          .map(f => ({ name: f, mtime: fs.statSync(path.join(todosDir, f)).mtime }))
          .sort((a, b) => b.mtime - a.mtime);

        if (files.length > 0) {
          try {
            const todos = JSON.parse(fs.readFileSync(path.join(todosDir, files[0].name), 'utf8'));
            const inProgress = todos.find(t => t.status === 'in_progress');
            if (inProgress) task = inProgress.activeForm || '';
          } catch (e) {}
        }
      } catch (e) {
        // Silently fail on file system errors - don't break statusline
      }
    }

    // GSD state (milestone · status · phase) — shown when no todo task
    const gsdStateStr = task ? '' : formatGsdState(readGsdState(dir) || {});

    // GSD update available?
    // Check shared cache first (#1421), fall back to runtime-specific cache for
    // backward compatibility with older gsd-check-update.js versions.
    let gsdUpdate = '';
    const sharedCacheFile = path.join(homeDir, '.cache', 'gsd', 'gsd-update-check.json');
    const legacyCacheFile = path.join(claudeDir, 'cache', 'gsd-update-check.json');
    const cacheFile = fs.existsSync(sharedCacheFile) ? sharedCacheFile : legacyCacheFile;
    if (fs.existsSync(cacheFile)) {
      try {
        const cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
        if (cache.update_available) {
          gsdUpdate = '\x1b[33m⬆ /gsd-update\x1b[0m │ ';
        }
        if (cache.stale_hooks && cache.stale_hooks.length > 0) {
          // If installed version is ahead of npm latest, this is a dev install.
          // Running /gsd-update would downgrade — show a contextual warning instead.
          const isDevInstall = (() => {
            if (!cache.installed || !cache.latest || cache.latest === 'unknown') return false;
            const parseV = v => v.replace(/^v/, '').split('.').map(Number);
            const [ai, bi, ci] = parseV(cache.installed);
            const [an, bn, cn] = parseV(cache.latest);
            return ai > an || (ai === an && bi > bn) || (ai === an && bi === bn && ci > cn);
          })();
          if (isDevInstall) {
            gsdUpdate += '\x1b[33m⚠ dev install — re-run installer to sync hooks\x1b[0m │ ';
          } else {
            gsdUpdate += '\x1b[31m⚠ stale hooks — run /gsd-update\x1b[0m │ ';
          }
        }
      } catch (e) {}
    }

    // Last-slash-command suffix (opt-in via statusline.show_last_command, #2538).
    // Reads the active session transcript for the most recent <command-name> tag.
    // Failure here must never break the statusline — wrap the entire lookup.
    let lastCmdSuffix = '';
    try {
      const cfg = readGsdConfig(dir);
      if (getConfigValue(cfg, 'statusline.show_last_command') === true) {
        const transcriptPath = data.transcript_path;
        const lastCmd = readLastSlashCommand(transcriptPath);
        if (lastCmd) {
          lastCmdSuffix = ` │ \x1b[2mlast: /${lastCmd}\x1b[0m`;
        }
      }
    } catch (e) {
      // Never break the statusline on config/transcript errors
    }

    // Output. The working directory is deliberately absent — the terminal tab
    // and prompt already say where you are.
    const middle = task
      ? `\x1b[1m${task}\x1b[0m`
      : gsdStateStr
        ? `\x1b[2m${gsdStateStr}\x1b[0m`
        : null;

    // Plan usage segment (5h session / weekly / per-model weekly). Never let
    // it break the rest of the line.
    let usage = '';
    try {
      usage = formatProviderUsage(data, claudeDir);
    } catch (e) {}

    let speed = '';
    try {
      speed = formatSpeedSegment(data, claudeDir);
    } catch (e) {}

    const head = middle
      ? `\x1b[2m${modelLabel}\x1b[0m │ ${middle}`
      : `\x1b[2m${modelLabel}\x1b[0m`;
    process.stdout.write(`${gsdUpdate}${head}${ctx ? ` │${ctx}` : ''}${speed}${usage}${lastCmdSuffix}`);
  } catch (e) {
    // Silent fail - don't break statusline on parse errors
  }
});
}

// --- Connection + model-speed indicator -------------------------------------
// Answers "is the model slow, or is my connection slow?". Two independent
// signals side by side: a latency history sparkline (the network) and the
// current output rate (the model). The render path NEVER touches the network —
// a detached probe refreshes a small cache file and the statusline reads it.

// Sampler cadence, independent of redraws. Settable per-session via
// GSD_NET_SAMPLE_MS (milliseconds, clamped to 2s..5m); the sampler inherits it
// from whichever render started it.
const NET_SAMPLE_EVERY_MS = (() => {
  const raw = parseInt(process.env.GSD_NET_SAMPLE_MS || '', 10);
  return Number.isFinite(raw) && raw > 0 ? Math.max(1_000, Math.min(300_000, raw)) : 1_000;
})();
// A reading older than this many cadences is shown greyed out rather than
// coloured, so a frozen line reads as "not measured lately", not as "fast".
const NET_STALE_AFTER = 3;
// No heartbeat for this long means no sampler is alive, so start one. Derived
// from the cadence: a fixed window shorter than the interval would call a
// living sampler dead and spawn a second one alongside it.
const NET_LOCK_STALE_MS = NET_SAMPLE_EVERY_MS * 2 + 15_000;
const NET_IDLE_EXIT_MS = 5 * 60_000; // sampler quits once nothing has drawn the line
const NET_CACHE_DEAD_MS = 120_000;  // older than this renders nothing, not stale numbers
const NET_SAMPLES = 8;
const NET_PROBE_HOST = 'api.anthropic.com';
const NET_PROBE_PORT = 443;
const NET_PROBE_TIMEOUT_MS = 5000;
const NET_BARS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇'];

const TPS_TAIL_BYTES = 256 * 1024;
const TPS_MAX_AGE_MS = 5 * 60 * 1000;

// Live output rate, fed by the MessageDisplay hook. That hook is handed the
// text as it streams but no token counts, so the characters it reports are
// converted using a ratio measured from this session's own finished replies —
// never a fixed divisor. The ratio is language-dependent and the difference is
// not subtle: Hebrew answers here run ~1.45 characters per token where English
// runs ~3.1, so assuming a constant would be wrong by more than double.
const STREAM_LOG_MAX = 64 * 1024;   // trim the hook's log past this
const STREAM_LOG_KEEP = 16 * 1024;  // ...down to this
// How far back the live rate averages. Settable via GSD_RATE_WINDOW_MS
// (clamped to 1s..30s). The hook fires per batch of finished lines, so the
// arriving text is bursty; a window several times the refresh tick overlaps
// successive readings and keeps the number from jumping between bursts.
const LIVE_WINDOW_MS = (() => {
  const raw = parseInt(process.env.GSD_RATE_WINDOW_MS || '', 10);
  return Number.isFinite(raw) && raw > 0 ? Math.max(1_000, Math.min(30_000, raw)) : 5_000;
})();
const RATIO_SAMPLES = 5;            // finished replies to calibrate from
const RATIO_MIN_CHARS = 200;        // ignore replies too short to calibrate on

function netCachePath(claudeDir) {
  return path.join(claudeDir, 'cache', 'net-latency.json');
}

// Touched on every render. The sampler watches it to know the line is still on
// screen, and exits on its own once it is not — nothing is left running after
// the last Claude Code window closes.
function netRenderMarkPath(claudeDir) {
  return path.join(claudeDir, 'cache', 'net-render.mark');
}

function netLockPath() {
  return path.join(os.tmpdir(), 'gsd-net-sampler.lock');
}

function latencyColor(ms) {
  if (ms == null) return 31;
  if (ms < 150) return 32;
  if (ms < 400) return 33;
  return 31;
}

// Log scale: 60ms sits at the shortest bar, 900ms+ pins to the tallest, so the
// range people actually live in gets most of the resolution.
function latencyBar(ms) {
  if (ms == null) return NET_BARS[NET_BARS.length - 1];
  const clamped = Math.max(60, Math.min(900, ms));
  const idx = Math.round((Math.log(clamped / 60) / Math.log(15)) * (NET_BARS.length - 1));
  return NET_BARS[Math.max(0, Math.min(NET_BARS.length - 1, idx))];
}

function formatLatency(ms) {
  if (ms == null) return 'off';
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

function formatNetSegment(samples, stale = false) {
  if (!Array.isArray(samples) || samples.length === 0) return '';
  const recent = samples.slice(-NET_SAMPLES);
  const paint = ms => (stale ? '\x1b[2m' : `\x1b[${latencyColor(ms)}m`);
  const spark = recent.map(ms => `${paint(ms)}${latencyBar(ms)}\x1b[0m`).join('');
  const last = recent[recent.length - 1];
  return `${spark} ${paint(last)}${formatLatency(last)}\x1b[0m`;
}

function tpsColor(tps) {
  if (tps >= 40) return 32;
  if (tps >= 15) return 33;
  return 31;
}

/**
 * Read the latency cache, kicking off a detached probe when it is stale.
 * Returns a sanitized sample array (numbers = ms, null = probe failed), or
 * null when there is nothing trustworthy to draw.
 */
function readNetCache(claudeDir, now = Date.now()) {
  let parsed = null;
  try {
    parsed = JSON.parse(fs.readFileSync(netCachePath(claudeDir), 'utf8'));
  } catch (e) {}
  // Announce this render, then make sure a sampler is alive. The cache's own
  // age is NOT the trigger — the sampler keeps it fresh between redraws, which
  // is the whole point of it not living on the render path.
  try {
    fs.mkdirSync(path.join(claudeDir, 'cache'), { recursive: true });
    fs.writeFileSync(netRenderMarkPath(claudeDir), String(now));
  } catch (e) {}
  spawnNetSampler(claudeDir, now);
  const updated = isPlainObject(parsed) && typeof parsed.updated === 'number' ? parsed.updated : 0;
  if (!isPlainObject(parsed) || !Array.isArray(parsed.samples)) return null;
  if (now - updated > NET_CACHE_DEAD_MS) return null;
  const samples = parsed.samples
    .filter(v => v === null || (typeof v === 'number' && Number.isFinite(v) && v >= 0))
    .slice(-NET_SAMPLES);
  if (!samples.length) return null;
  return { samples, stale: now - updated > NET_SAMPLE_EVERY_MS * NET_STALE_AFTER };
}

function spawnNetSampler(claudeDir, now = Date.now()) {
  try {
    const lockPath = netLockPath();
    // Both tests must pass: a recent heartbeat AND a process still answering to
    // the pid inside. The timestamp alone would keep a killed sampler's lock
    // looking valid for a full window, leaving the line unmeasured; the pid
    // alone could match an unrelated process that reused the number.
    let alive = false;
    try {
      if (now - fs.statSync(lockPath).mtimeMs < NET_LOCK_STALE_MS) {
        const pid = parseInt(fs.readFileSync(lockPath, 'utf8'), 10);
        if (Number.isFinite(pid) && pid > 0) {
          try { process.kill(pid, 0); alive = true; } catch (e) { alive = false; }
        }
      }
    } catch (e) {}
    if (alive) return;
    fs.writeFileSync(lockPath, String(process.pid));
    const child = require('child_process').spawn(
      process.execPath,
      [__filename, '--net-sampler'],
      { detached: true, stdio: 'ignore', env: { ...process.env, CLAUDE_CONFIG_DIR: claudeDir } }
    );
    child.unref();
  } catch (e) {}
}

/**
 * Time one TCP connection to the API host. No request is sent and no bytes of
 * ours ever leave — this measures the network path alone, which is why it
 * reads ~90ms where a full TLS handshake would read ~400ms and drown the
 * signal in crypto setup the real client pays only once per connection.
 */
function probeOnce(cb) {
  const started = Date.now();
  let done = false;
  const finish = ms => { if (!done) { done = true; cb(ms); } };
  try {
    const sock = require('net').connect(NET_PROBE_PORT, NET_PROBE_HOST, () => {
      const ms = Date.now() - started;
      sock.destroy();
      finish(ms);
    });
    sock.setTimeout(NET_PROBE_TIMEOUT_MS, () => { sock.destroy(); finish(null); });
    sock.on('error', () => finish(null));
  } catch (e) {
    finish(null);
  }
}

function appendSample(claudeDir, ms) {
  try {
    const p = netCachePath(claudeDir);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    let prev = [];
    try {
      const old = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (Array.isArray(old.samples)) prev = old.samples;
    } catch (e) {}
    const samples = prev.concat([ms]).slice(-NET_SAMPLES);
    fs.writeFileSync(p, JSON.stringify({ updated: Date.now(), samples }));
  } catch (e) {}
}

/**
 * The background sampler: measures on its own clock so the reading stays true
 * while the model is mid-turn and the line is not redrawing. Heartbeats a lock
 * so only one ever runs, and exits once no render has claimed the line for a
 * while, leaving nothing behind when Claude Code closes.
 */
function runNetSampler() {
  const claudeDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  const tick = () => {
    let lastRender = 0;
    try { lastRender = fs.statSync(netRenderMarkPath(claudeDir)).mtimeMs; } catch (e) {}
    if (Date.now() - lastRender > NET_IDLE_EXIT_MS) process.exit(0);
    try { fs.writeFileSync(netLockPath(), String(process.pid)); } catch (e) {}
    probeOnce(ms => appendSample(claudeDir, ms));
  };
  tick();
  setInterval(tick, NET_SAMPLE_EVERY_MS);
}

/**
 * Parse the tail of a transcript into one record per request. The tail can open
 * mid-line, so anything unparsable is skipped. Entries of a single request each
 * carry that request's cumulative usage, hence the max() rather than a sum.
 */
function readTranscriptRequests(transcriptPath) {
  if (!transcriptPath || typeof transcriptPath !== 'string') return null;
  let content;
  try {
    if (!fs.existsSync(transcriptPath)) return null;
    const stat = fs.statSync(transcriptPath);
    const start = Math.max(0, stat.size - TPS_TAIL_BYTES);
    const fd = fs.openSync(transcriptPath, 'r');
    try {
      const buf = Buffer.alloc(stat.size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      content = buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch (e) {
    return null;
  }

  const entries = [];
  const byRequest = new Map();
  for (const line of content.split('\n')) {
    if (!line.startsWith('{')) continue;
    let e;
    try { e = JSON.parse(line); } catch (err) { continue; }
    const ts = Date.parse(e && e.timestamp);
    if (!Number.isFinite(ts)) continue;
    const usage = e?.message?.usage;
    const out = usage?.output_tokens;
    entries.push({ ts, requestId: e.requestId, out });
    if (e.type !== 'assistant' || !e.requestId) continue;
    let r = byRequest.get(e.requestId);
    if (!r) { r = { chars: 0, latin: 0, out: 0, thinking: 0, hasToolUse: false }; byRequest.set(e.requestId, r); }
    for (const block of (e?.message?.content || [])) {
      if (block?.type === 'text') {
        const text = block.text || '';
        r.chars += text.length;
        r.latin += countLatin(text);
      }
      if (block?.type === 'tool_use') r.hasToolUse = true;
    }
    if (typeof out === 'number') r.out = Math.max(r.out, out);
    const think = usage?.output_tokens_details?.thinking_tokens;
    if (typeof think === 'number') r.thinking = Math.max(r.thinking, think);
  }
  return { entries, requests: [...byRequest.values()] };
}

/**
 * Characters per output token, measured from this session's finished replies.
 *
 * Only replies with no tool call qualify: for those, output tokens minus
 * thinking tokens is exactly the visible text, so the ratio is real rather than
 * assumed. A reply containing a tool call mixes its arguments into the same
 * token count with no text to match them against, and would skew the result.
 * The median of the last few guards against one odd reply. Returns null until
 * the session has produced something to calibrate on.
 */
function charsPerToken(parsed) {
  if (!parsed) return null;
  const ratios = [];
  for (const r of parsed.requests) {
    if (r.hasToolUse) continue;
    const visible = r.out - r.thinking;
    if (r.chars < RATIO_MIN_CHARS || visible <= 50) continue;
    ratios.push(r.chars / visible);
  }
  if (!ratios.length) return null;
  const recent = ratios.slice(-RATIO_SAMPLES).sort((a, b) => a - b);
  return recent[Math.floor(recent.length / 2)];
}

/**
 * Output tokens per second for the most recent finished request. The span runs
 * from the entry preceding the request to its last entry.
 *
 * Returns {tps, stale} — an old reading is reported as stale rather than
 * withheld, so the slot can say "measured a while ago" instead of vanishing.
 * null means no finished reply at all, the normal state of a fresh window.
 */
function finishedRate(parsed, now = Date.now()) {
  if (!parsed) return null;
  const entries = parsed.entries;
  let last = -1;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].requestId && typeof entries[i].out === 'number' && entries[i].out > 0) { last = i; break; }
  }
  if (last < 0) return null;
  const stale = now - entries[last].ts > TPS_MAX_AGE_MS;

  const reqId = entries[last].requestId;
  let first = last;
  let tokens = entries[last].out;
  while (first > 0 && entries[first - 1].requestId === reqId) {
    first--;
    tokens = Math.max(tokens, entries[first].out || 0);
  }
  if (first === 0) return null; // no preceding entry to date the request from
  const seconds = (entries[last].ts - entries[first - 1].ts) / 1000;
  if (!(seconds > 0.2)) return null;
  const tps = Math.round(tokens / seconds);
  return tps > 0 && tps < 10000 ? { tps, stale } : null;
}

function readTokensPerSecond(transcriptPath, now = Date.now()) {
  return finishedRate(readTranscriptRequests(transcriptPath), now);
}

/**
 * Characters a Latin-alphabet tokenizer handles densely (roughly one token per
 * 2-4 of them) versus everything else (closer to one token per character).
 * Splitting on this is what lets the estimate survive a language switch.
 */
function countLatin(text) {
  let n = 0;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) < 128) n++;
  return n;
}

/**
 * Tokens per Latin character and per other character, fitted by least squares
 * over the session's recent replies. Catches a language switch immediately,
 * where a single blended ratio needs several replies to catch up.
 *
 * Returns null when the replies do not pin the two coefficients down — all one
 * script, too few replies, or a fit that comes out negative. The caller then
 * falls back to the plain ratio rather than trusting an unstable fit.
 */
function tokenModel(parsed) {
  if (!parsed) return null;
  const rows = [];
  for (const r of parsed.requests) {
    if (r.hasToolUse) continue;
    const visible = r.out - r.thinking;
    if (r.chars < RATIO_MIN_CHARS || visible <= 50) continue;
    rows.push({ latin: r.latin, other: r.chars - r.latin, tokens: visible });
  }
  const h = rows.slice(-RATIO_SAMPLES);
  if (h.length < 2) return null;
  let sxx = 0, syy = 0, sxy = 0, sxt = 0, syt = 0;
  for (const { latin, other, tokens } of h) {
    sxx += latin * latin; syy += other * other; sxy += latin * other;
    sxt += latin * tokens; syt += other * tokens;
  }
  const det = sxx * syy - sxy * sxy;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-9) return null;
  const perLatin = (sxt * syy - syt * sxy) / det;
  const perOther = (syt * sxx - sxt * sxy) / det;
  if (!(perLatin > 0) || !(perOther > 0)) return null;
  return { perLatin, perOther };
}

/**
 * Tokens for a stretch of streamed text. The fitted model leads; the plain
 * ratio both backs it up and bounds it, because a fit from too few replies can
 * be wildly off while the ratio degrades gently.
 */
function estimateTokens(chars, latin, ratio, model) {
  if (!(chars > 0)) return null;
  const byRatio = ratio ? chars / ratio : null;
  if (!model) return byRatio == null ? null : Math.round(byRatio);
  const byModel = latin * model.perLatin + (chars - latin) * model.perOther;
  if (byRatio == null) return Math.round(byModel);
  // The bound is wide on purpose. A genuine language switch moves the answer by
  // nearly 3x, so a tight bound would veto the very correction the model exists
  // for; measured over 1079 held-out replies, widening it to 4x cut the worst
  // case from 114% to 74% while a 2x bound left it untouched.
  const trusted = byModel >= 0.25 * byRatio && byModel <= 4 * byRatio;
  return Math.round(trusted ? byModel : byRatio);
}

function streamLogPath(claudeDir) {
  return path.join(claudeDir, 'cache', 'stream-rate.log');
}

/**
 * Characters per second written to the screen over the last few seconds, from
 * the MessageDisplay hook's log. Averaged across a fixed window rather than
 * divided by the gap between two samples, so the number does not spike on a
 * single large batch. Returns null when nothing streamed recently.
 */
function readLiveCharRate(claudeDir, sessionId, now = Date.now(), windowMs = LIVE_WINDOW_MS) {
  if (!sessionId) return null;
  const p = streamLogPath(claudeDir);
  let content;
  try {
    const stat = fs.statSync(p);
    const start = Math.max(0, stat.size - STREAM_LOG_KEEP);
    const fd = fs.openSync(p, 'r');
    try {
      const buf = Buffer.alloc(stat.size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      content = buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
    // The hook only ever appends, so the log is trimmed from the reading side.
    if (stat.size > STREAM_LOG_MAX) {
      const cut = content.indexOf('\n');
      fs.writeFileSync(p, cut >= 0 ? content.slice(cut + 1) : content);
    }
  } catch (e) {
    return null;
  }

  let chars = 0;
  let latin = 0;
  for (const line of content.split('\n')) {
    const parts = line.split(' ');
    // Four fields since the script split was added. Shorter lines are from an
    // older hook and are simply skipped — they age out of the window in seconds.
    if (parts.length !== 4 || parts[0] !== sessionId) continue;
    const ts = Number(parts[1]);
    const n = Number(parts[2]);
    const l = Number(parts[3]);
    if (!Number.isFinite(ts) || !Number.isFinite(n) || n < 0) continue;
    if (!Number.isFinite(l) || l < 0 || l > n) continue;
    if (now - ts > windowMs || ts > now + 5000) continue;
    chars += n;
    latin += l;
  }
  const seconds = windowMs / 1000;
  return chars > 0 ? { chars: chars / seconds, latin: latin / seconds } : null;
}

function formatSpeedSegment(data, claudeDir, now = Date.now()) {
  let net = '';
  try {
    const cached = readNetCache(claudeDir, now);
    if (cached) net = formatNetSegment(cached.samples, cached.stale);
  } catch (e) {}
  // One parse of the transcript tail serves both the finished-reply rate and
  // the characters-per-token calibration.
  let rate = null;
  let ratio = null;
  let model = null;
  try {
    const parsed = readTranscriptRequests(data?.transcript_path);
    rate = finishedRate(parsed, now);
    ratio = charsPerToken(parsed);
    model = tokenModel(parsed);
  } catch (e) {}

  // While text is actually streaming, prefer the live reading. It needs the
  // measured ratio: without it we would be guessing at the conversion, so the
  // finished-reply number stands in until the session has calibrated itself.
  let live = null;
  try {
    const cps = readLiveCharRate(claudeDir, data?.session_id, now);
    if (cps) live = estimateTokens(cps.chars, cps.latin, ratio, model);
  } catch (e) {}

  // The rate slot is always drawn. A window that has not had a reply yet shows
  // a dash rather than nothing, so an empty slot never reads as a broken one.
  let rateSeg;
  if (live != null && live > 0) {
    rateSeg = `\x1b[${tpsColor(live)}m${live} t/s\x1b[0m`;
  } else if (rate === null) {
    rateSeg = '\x1b[2m— t/s\x1b[0m';
  } else {
    rateSeg = `${rate.stale ? '\x1b[2m' : `\x1b[${tpsColor(rate.tps)}m`}${rate.tps} t/s\x1b[0m`;
  }
  const parts = [];
  if (net) parts.push(net);
  parts.push(rateSeg);
  return ` │ ${parts.join(' \x1b[2m·\x1b[0m ')}`;
}

// --- Provider detection and model label formatting --------------------------

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


// --- Plan/execute model combos (ccx) ----------------------------------------
// Claude Code's own `opusplan` swaps the model per permission mode and reports
// the swapped name here, so it needs nothing. The ccx-only combo below is
// swapped by the local proxy instead; Claude Code never learns, so its name is
// resolved here from the selected combo (settings) x the last permission mode
// the session recorded (transcript). That record is written with each prompt,
// so the label follows a shift+tab one message late.

const PLAN_COMBOS = {
  'claude-fplan-sonnet': {
    plan: () => process.env.ANTHROPIC_DEFAULT_OPUS_MODEL || 'claude-fable-5-1',
    exec: () => 'claude-sonnet-5',
  },
};

function bareModelId(id) {
  return String(id || '').replace(/\[\d+m\]$/i, '').trim();
}

function claudeSettingsPath() {
  const dir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  return path.join(dir, 'settings.json');
}

function readClaudeSettings() {
  try {
    return JSON.parse(fs.readFileSync(claudeSettingsPath(), 'utf8')) || {};
  } catch (e) {
    return {};
  }
}

/** Human name for a model id: the picker's own label if it lists one. */
function prettyModelName(id, settings) {
  const bare = bareModelId(id);
  if (!bare) return '';
  const options = settings?.modelPicker?.options;
  if (Array.isArray(options)) {
    const hit = options.find(o => o && bareModelId(o.model) === bare && typeof o.label === 'string');
    // The combo rows label themselves "Fable Plan -> Opus"; that is the thing
    // we are replacing, so never let one come back as its own half's name.
    if (hit && !PLAN_COMBOS[bare]) return hit.label;
  }
  const rest = bare.replace(/^claude-/, '');
  const parts = rest.split('-');
  const nums = parts.slice(1).filter(p => /^\d+$/.test(p)).join('.');
  const name = parts[0].charAt(0).toUpperCase() + parts[0].slice(1);
  return nums ? `${name} ${nums}` : name;
}

/**
 * Last permission mode recorded in the session transcript. Both the standalone
 * mode-change record and every user message carry it, so the last one wins.
 * Only the tail is read — transcripts grow to tens of megabytes.
 */
function readPermissionMode(transcriptPath) {
  if (!transcriptPath) return null;
  let fd;
  try {
    const size = fs.statSync(transcriptPath).size;
    const span = Math.min(size, 256 * 1024);
    const buf = Buffer.alloc(span);
    fd = fs.openSync(transcriptPath, 'r');
    fs.readSync(fd, buf, 0, span, size - span);
    const matches = buf.toString('utf8').match(/"permissionMode":"([a-zA-Z]+)"/g);
    if (!matches || !matches.length) return null;
    return matches[matches.length - 1].split('"')[3];
  } catch (e) {
    return null;
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch (e) {} }
  }
}

/**
 * Name of the model actually serving this turn, when a plan/execute combo is
 * selected. Returns '' for every ordinary single-model session.
 */
function activeComboModelName(data = {}, settings = readClaudeSettings()) {
  const combo = PLAN_COMBOS[bareModelId(settings.model)];
  if (!combo) return '';
  const planning = readPermissionMode(data.transcript_path) === 'plan';
  return prettyModelName(planning ? combo.plan() : combo.exec(), settings);
}

function formatModelLabel(data = {}) {
  const name = activeComboModelName(data) || data.model?.display_name || 'Claude';
  // Strip a parenthetical window note ("Opus 5 (1M context)") and never append
  // the size — the context meter further along the line already reports it.
  const parts = [name.replace(/\s*\([^)]*context[^)]*\)/i, '').trim() || name];
  if (data.effort?.level) parts.push(data.effort.level);
  return parts.join(' · ');
}

// Export helpers for unit tests. Harmless when run as a script.
module.exports = {
  readGsdState, parseStateMd, formatGsdState,
  readGsdConfig, getConfigValue, readLastSlashCommand,
  usageColor, formatReset, readUsageCache, formatUsage,
  providerForModel, formatContextSize, formatModelLabel,
  bareModelId, prettyModelName, readPermissionMode, activeComboModelName,
  formatProviderUsage, selectProviderWindows, shortUsageLabel,
  providerCachePath, readProviderSnapshot,
  latencyBar, latencyColor, formatLatency, formatNetSegment, readTokensPerSecond, readNetCache,
  readTranscriptRequests, charsPerToken, finishedRate, readLiveCharRate, streamLogPath,
  countLatin, tokenModel, estimateTokens,
};

/**
 * Render the statusline from an already-parsed hook input object. Exported for
 * testing without feeding stdin. Returns the rendered string.
 */
function renderStatusline(data) {
  const modelLabel = formatModelLabel(data || {});
  const dir = data?.workspace?.current_dir || process.cwd();

  let lastCmdSuffix = '';
  try {
    const cfg = readGsdConfig(dir);
    if (getConfigValue(cfg, 'statusline.show_last_command') === true) {
      const lastCmd = readLastSlashCommand(data?.transcript_path);
      if (lastCmd) {
        lastCmdSuffix = ` │ \x1b[2mlast: /${lastCmd}\x1b[0m`;
      }
    }
  } catch (e) { /* swallow */ }

  const gsdStateStr = formatGsdState(readGsdState(dir) || {});
  const middle = gsdStateStr ? `\x1b[2m${gsdStateStr}\x1b[0m` : null;
  if (middle) {
    return `\x1b[2m${modelLabel}\x1b[0m │ ${middle}${lastCmdSuffix}`;
  }
  return `\x1b[2m${modelLabel}\x1b[0m${lastCmdSuffix}`;
}

module.exports.renderStatusline = renderStatusline;

if (require.main === module) {
  if (process.argv.includes('--net-sampler')) runNetSampler();
  else runStatusline();
}
