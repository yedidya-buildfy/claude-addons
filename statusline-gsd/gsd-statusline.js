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
  const d = new Date(t);
  if (mins >= RESET_DAYS_BAND_MINUTES) {
    // Whole days only — a trailing "and a bit" is noise at this distance.
    const days = Math.floor(mins / (24 * 60));
    return `${days}d → ${d.getDate()}/${d.getMonth() + 1}`;
  }
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  const dur = h > 0 ? `${h}h${String(m).padStart(2, '0')}m` : `${m}m`;
  const clock = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return `${dur} → ${clock}`;
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

    // Output
    const dirname = path.basename(dir);
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

    if (middle) {
      process.stdout.write(`${gsdUpdate}\x1b[2m${modelLabel}\x1b[0m │ ${middle} │ \x1b[2m${dirname}\x1b[0m${ctx}${usage}${lastCmdSuffix}`);
    } else {
      process.stdout.write(`${gsdUpdate}\x1b[2m${modelLabel}\x1b[0m │ \x1b[2m${dirname}\x1b[0m${ctx}${usage}${lastCmdSuffix}`);
    }
  } catch (e) {
    // Silent fail - don't break statusline on parse errors
  }
});
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
  const parts = [activeComboModelName(data) || data.model?.display_name || 'Claude'];
  if (data.effort?.level) parts.push(data.effort.level);
  const size = formatContextSize(data.context_window?.context_window_size);
  if (size) parts.push(`${size} ctx`);
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
};

/**
 * Render the statusline from an already-parsed hook input object. Exported for
 * testing without feeding stdin. Returns the rendered string.
 */
function renderStatusline(data) {
  const modelLabel = formatModelLabel(data || {});
  const dir = data?.workspace?.current_dir || process.cwd();
  const dirname = path.basename(dir);

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
    return `\x1b[2m${modelLabel}\x1b[0m │ ${middle} │ \x1b[2m${dirname}\x1b[0m${lastCmdSuffix}`;
  }
  return `\x1b[2m${modelLabel}\x1b[0m │ \x1b[2m${dirname}\x1b[0m${lastCmdSuffix}`;
}

module.exports.renderStatusline = renderStatusline;

if (require.main === module) runStatusline();
