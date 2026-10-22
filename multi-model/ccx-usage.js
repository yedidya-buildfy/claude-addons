#!/usr/bin/env node
// `ccx usage`: every provider's plan limits in one view, read from the same
// caches the statusline uses. Refreshes anything older than a few minutes
// first (at most WAIT_MS), then prints what it has, marking old data.
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const HOME = os.homedir();
const CLAUDE_DIR = path.join(HOME, '.claude');
const pu = require(process.env.CCX_PROVIDER_USAGE || path.join(CLAUDE_DIR, 'provider-usage.js'));

const FRESH_MS = 3 * 60_000;
const WAIT_MS = 20_000;

const tty = process.stdout.isTTY;
const paint = (code) => (s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const dim = paint(2), bold = paint(1), red = paint(31), yellow = paint(33), green = paint(32);

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
}
function mtime(file) {
  try { return fs.statSync(file).mtimeMs; } catch (_) { return 0; }
}
function jwtClaims(token) {
  try {
    const p = token.split('.')[1];
    return JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
  } catch (_) { return null; }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const titleCase = (s) => String(s).replace(/(^|[\s_-])([a-z])/g, (_, a, b) => (a ? ' ' : '') + b.toUpperCase()).trim();

// --- refresh -----------------------------------------------------------------

const CLAUDE_CACHE = path.join(CLAUDE_DIR, 'cache', 'claude-usage.json');

function refreshClaude() {
  if (Date.now() - mtime(CLAUDE_CACHE) < FRESH_MS) return Promise.resolve();
  const script = path.join(CLAUDE_DIR, 'scripts', 'usage-fetch.sh');
  return new Promise((resolve) => {
    const child = spawn('bash', [script], { stdio: 'ignore', env: { ...process.env, CLAUDE_CONFIG_DIR: CLAUDE_DIR } });
    child.on('error', resolve);
    child.on('exit', resolve);
  });
}

function snapshotAge(provider) {
  const s = pu.readProviderSnapshot(CLAUDE_DIR, provider);
  return s ? Date.now() - s.fetchedAt : Infinity;
}

async function refreshProvider(provider) {
  if (snapshotAge(provider) < FRESH_MS) return;
  if (provider !== 'google') { await pu.fetchProvider(provider, CLAUDE_DIR); return; }
  // Google's numbers arrive through agy's own callback; start it and wait.
  const before = pu.readProviderSnapshot(CLAUDE_DIR, 'google')?.fetchedAt || 0;
  pu.probeAntigravity({ force: true });
  const end = Date.now() + WAIT_MS;
  while (Date.now() < end) {
    await sleep(500);
    if ((pu.readProviderSnapshot(CLAUDE_DIR, 'google')?.fetchedAt || 0) > before) return;
  }
}

function withTimeout(p) {
  return Promise.race([p.catch(() => {}), sleep(WAIT_MS + 2000)]);
}

// --- formatting --------------------------------------------------------------

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const hhmm = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

function resetText(atMs, now = Date.now()) {
  if (!Number.isFinite(atMs)) return '';
  const left = atMs - now;
  if (left <= 0) return dim('reset passed');
  const mins = Math.round(left / 60_000);
  const d = Math.floor(mins / 1440), h = Math.floor((mins % 1440) / 60), m = mins % 60;
  const rel = d ? `${d}d${h ? ` ${h}h` : ''}` : h ? `${h}h${m ? ` ${m}m` : ''}` : `${m}m`;
  const at = new Date(atMs);
  const when = d ? `${DAYS[at.getDay()]} ${hhmm(at)}` : hhmm(at);
  return `resets in ${rel.padEnd(7)} (${when})`;
}

function bar(pct) {
  const n = Math.max(0, Math.min(10, Math.round(pct / 10)));
  const s = '█'.repeat(n) + '░'.repeat(10 - n);
  return pct >= 90 ? red(s) : pct >= 70 ? yellow(s) : green(s);
}

function row(label, pct, resetMs) {
  const p = Math.round(pct);
  return `  ${label.padEnd(10)}${bar(p)} ${String(p).padStart(3)}%   ${resetText(resetMs)}`;
}

function asOf(ms) {
  const d = new Date(ms);
  return `${d.getDate()}.${d.getMonth() + 1} ${hhmm(d)}`;
}

function header(name, account, note) {
  return `${bold(name.padEnd(12))}${account || dim('account unknown')}${note ? `  ${dim(note)}` : ''}`;
}

// --- providers -----------------------------------------------------------------

function claudeSection() {
  const acct = readJson(path.join(HOME, '.claude.json'))?.oauthAccount || {};
  const tier = String(acct.organizationRateLimitTier || acct.organizationType || '')
    .replace(/^default_/, '').replace(/^claude_/, 'Claude ').replace(/_(\d+x)$/, ' $1');
  const account = [tier && titleCase(tier), acct.emailAddress].filter(Boolean).join(' · ');
  const data = readJson(CLAUDE_CACHE);
  const out = [];
  const limits = Array.isArray(data?.limits) ? data.limits : [];
  for (const l of limits) {
    if (typeof l?.percent !== 'number') continue;
    const label = l.kind === 'session' ? '5h'
      : l.kind === 'weekly_all' ? 'week'
      : l.scope?.model?.display_name || titleCase(l.kind || 'limit');
    out.push(row(label, l.percent, Date.parse(l.resets_at)));
  }
  const age = Date.now() - mtime(CLAUDE_CACHE);
  const note = !out.length ? null : age > FRESH_MS ? `(as of ${asOf(mtime(CLAUDE_CACHE))})` : null;
  if (!out.length) out.push(`  ${dim('no data - run `claude` once to sign in, then try again')}`);
  return [header('Anthropic', account, note), ...out];
}

function codexAccount() {
  const claims = jwtClaims(readJson(path.join(HOME, '.codex', 'auth.json'))?.tokens?.id_token || '');
  if (!claims) return null;
  const plan = claims['https://api.openai.com/auth']?.chatgpt_plan_type;
  return [plan && `ChatGPT ${titleCase(plan)}`, claims.email].filter(Boolean).join(' · ');
}

function grokAccount() {
  const auth = readJson(path.join(HOME, '.grok', 'auth.json'));
  const entry = auth && Object.values(auth).find((v) => v && typeof v === 'object' && v.email);
  return entry ? `Grok · ${entry.email}` : null;
}

const WINDOW_NAMES = { '5h': '5h', wk: 'week', day: 'day' };
const HINTS = {
  codex: 'run `codex` once and sign in, then try again',
  google: 'run `agy` once and sign in, then try again',
  grok: 'open `grok` once, then try again',
};

function providerSection(provider, name, account) {
  const snap = pu.readProviderSnapshot(CLAUDE_DIR, provider);
  const windows = snap?.status === 'ok' ? pu.sanitizeWindows(snap.windows) || [] : [];
  const now = Date.now();
  const live = windows.some((w) => Number.isFinite(w.resetsAt) && w.resetsAt * 1000 > now);
  if (!windows.length || !live) {
    const since = snap?.status === 'ok' ? ` since ${asOf(snap.fetchedAt)}` : '';
    return [header(name, account || snap?.account), `  ${dim(`no current data${since} - ${HINTS[provider]}`)}`];
  }
  const out = [];
  let shown = windows;
  if (provider === 'google') {
    // Gemini pool only (3p = other vendors' models, not used here); model-specific
    // buckets such as 'gemini-argon-wtu-weekly' get their own row.
    const gem = windows.filter((w) => String(w.id || '').startsWith('gemini'));
    if (gem.length) shown = gem;
    const specific = (w) => String(w.id || '').split('-').length > 2;
    shown = [...shown.filter((w) => !specific(w)), ...shown.filter(specific)];
  }
  for (const w of shown) {
    const parts = String(w.id || '').split(/[-:]/);
    const base = WINDOW_NAMES[w.label] || w.label;
    const label = provider === 'google' && parts.length > 2 ? `${titleCase(parts[1])} ${w.label}` : base;
    out.push(row(label, w.usedPercent, w.resetsAt * 1000));
  }
  const rc = snap.resetCredits;
  if (rc && rc.availableCount > 0) {
    const exp = Number.isFinite(rc.nextExpiresAt) ? `, next expires ${resetText(rc.nextExpiresAt * 1000).replace(/^resets in\s*/, 'in ').replace(/\s+\(/, ' (')}` : '';
    out.push(`  ${dim(`saved resets: ${rc.availableCount}${exp}`)}`);
  }
  const note = now - snap.fetchedAt > FRESH_MS ? `(as of ${asOf(snap.fetchedAt)})` : null;
  return [header(name, account || snap.account, note), ...out];
}

async function main() {
  if (tty) process.stderr.write(dim('refreshing…') + '\r');
  await Promise.all([refreshClaude(), ...['codex', 'google', 'grok'].map(refreshProvider)].map(withTimeout));
  if (tty) process.stderr.write('            \r');

  const now = new Date();
  const lines = [
    dim(`${now.getDate()}.${now.getMonth() + 1} ${hhmm(now)}`),
    '',
    ...claudeSection(), '',
    ...providerSection('codex', 'OpenAI', codexAccount()), '',
    ...providerSection('google', 'Google'), '',
    ...providerSection('grok', 'Grok', grokAccount()),
  ];
  process.stdout.write(lines.join('\n') + '\n');
  // agy probes and codex app-server children are detached; don't wait on them.
  process.exit(0);
}

if (require.main === module) main();
module.exports = { resetText, claudeSection, providerSection };
