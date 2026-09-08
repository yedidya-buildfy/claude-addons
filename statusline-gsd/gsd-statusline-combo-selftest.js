#!/usr/bin/env node
// Self-check for the plan/execute combo label in gsd-statusline.js.
// Run: node ~/.claude/gsd-statusline-combo-selftest.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'combo-selftest-'));
const settings = {
  model: 'opusplan[1m]',
  modelPicker: {
    options: [
      { model: 'opusplan[1m]', label: 'Fable 5.1 Plan → Opus 5' },
      { model: 'claude-fable-5-1[1m]', label: 'Claude Fable 5.1' },
      { model: 'claude-opus-5[1m]', label: 'Claude Opus 5' },
      { model: 'claude-sonnet-5[1m]', label: 'Claude Sonnet 5' },
    ],
  },
};
fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(settings));
process.env.CLAUDE_CONFIG_DIR = dir;
process.env.ANTHROPIC_DEFAULT_OPUS_MODEL = 'claude-fable-5-1[1m]';
process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = 'claude-opus-5[1m]';

const s = require('./gsd-statusline.js');

function transcript(lines) {
  const p = path.join(dir, `t${Math.random().toString(36).slice(2)}.jsonl`);
  fs.writeFileSync(p, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  return p;
}

const planning = transcript([
  { type: 'user', permissionMode: 'bypassPermissions' },
  { type: 'permission-mode', permissionMode: 'plan' },
]);
const executing = transcript([
  { type: 'permission-mode', permissionMode: 'plan' },
  { type: 'user', permissionMode: 'acceptEdits' },
]);

// Native opusplan is left to Claude Code, which already reports the swapped model.
assert.strictEqual(s.activeComboModelName({ transcript_path: planning }), '');

// The proxy-driven combo: planning half and executing half read differently.
settings.model = 'claude-fplan-sonnet[1m]';
fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(settings));
assert.strictEqual(s.activeComboModelName({ transcript_path: planning }), 'Claude Fable 5.1');
assert.strictEqual(s.activeComboModelName({ transcript_path: executing }), 'Claude Sonnet 5');

// A plain single-model session is left completely alone, plan mode included.
settings.model = 'claude-opus-5[1m]';
fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(settings));
assert.strictEqual(s.activeComboModelName({ transcript_path: planning }), '');
assert.strictEqual(
  s.formatModelLabel({ model: { display_name: 'Claude Opus 5' }, transcript_path: planning }),
  'Claude Opus 5'
);

// Missing or unreadable transcript must not crash, and must not claim plan mode.
settings.model = 'claude-fplan-sonnet[1m]';
fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(settings));
assert.strictEqual(s.readPermissionMode(path.join(dir, 'nope.jsonl')), null);
assert.strictEqual(s.activeComboModelName({}), 'Claude Sonnet 5');

// Full label keeps effort, but never repeats the context window size.
assert.strictEqual(
  s.formatModelLabel({
    model: { display_name: 'Claude Opus 5' },
    effort: { level: 'high' },
    context_window: { context_window_size: 1000000 },
    transcript_path: planning,
  }),
  'Claude Fable 5.1 · high'
);

// A parenthetical window note in the model's own name is stripped too.
settings.model = 'claude-opus-5[1m]';
fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(settings));
assert.strictEqual(
  s.formatModelLabel({ model: { display_name: 'Opus 5 (1M context)' }, effort: { level: 'high' } }),
  'Opus 5 · high'
);
// ...but a name that is only a parenthetical is never blanked out.
assert.strictEqual(s.formatModelLabel({ model: { display_name: '(1M context)' } }), '(1M context)');

// Reset countdown shows time-until only, never the wall-clock time it lands on.
assert.strictEqual(s.formatReset(Date.now() / 1000 + 22 * 60), '22m');
assert.strictEqual(s.formatReset(Date.now() / 1000 + 3 * 24 * 3600), '3d');
assert.strictEqual(s.formatReset(Date.now() / 1000 - 60), '');

// Latency bars rise with round-trip time and colour by band.
assert.strictEqual(s.latencyBar(60), '\u2581');
assert.strictEqual(s.latencyBar(900), '\u2587');
assert.strictEqual(s.latencyBar(5000), '\u2587');
assert.ok(s.latencyBar(300) > s.latencyBar(100));
assert.strictEqual(s.latencyColor(80), 32);
assert.strictEqual(s.latencyColor(300), 33);
assert.strictEqual(s.latencyColor(900), 31);
assert.strictEqual(s.latencyColor(null), 31);
assert.strictEqual(s.formatLatency(84), '84ms');
assert.strictEqual(s.formatLatency(1240), '1.2s');
assert.strictEqual(s.formatLatency(null), 'off');
assert.strictEqual(s.formatNetSegment([]), '');
assert.strictEqual(s.formatNetSegment(null), '');
assert.ok(s.formatNetSegment([90, 120, 400]).includes('400ms'));
// A fresh reading is coloured by band; a stale one is greyed out instead, so a
// frozen line never reads as a fast connection.
assert.ok(s.formatNetSegment([90], false).includes('\u001b[32m'));
assert.ok(!s.formatNetSegment([90], true).includes('\u001b[32m'));
assert.ok(s.formatNetSegment([90], true).includes('\u001b[2m'));

// Output rate: one request spanning 10s at 500 cumulative tokens reads 50/s.
const t0 = Date.now() - 20000;
const iso = ms => new Date(ms).toISOString();
const timed = transcript([
  { type: 'user', timestamp: iso(t0) },
  { type: 'assistant', requestId: 'req_a', timestamp: iso(t0 + 4000), message: { usage: { output_tokens: 200 } } },
  { type: 'assistant', requestId: 'req_a', timestamp: iso(t0 + 10000), message: { usage: { output_tokens: 500 } } },
]);
assert.deepStrictEqual(s.readTokensPerSecond(timed), { tps: 50, stale: false });

// An old reading is reported as stale, not withheld — the slot greys out
// instead of disappearing and shifting everything after it.
const old_ = transcript([
  { type: 'user', timestamp: iso(t0 - 3600000) },
  { type: 'assistant', requestId: 'req_b', timestamp: iso(t0 - 3599000), message: { usage: { output_tokens: 500 } } },
]);
assert.deepStrictEqual(s.readTokensPerSecond(old_), { tps: 500, stale: true });

// Missing and reply-less transcripts report nothing rather than a guess: this
// is the normal state of a window that has not been used yet.
assert.strictEqual(s.readTokensPerSecond(path.join(dir, 'nope.jsonl')), null);
assert.strictEqual(s.readTokensPerSecond(transcript([{ type: 'user', timestamp: iso(t0) }])), null);

// --- characters per token, measured rather than assumed ---------------------
const reply = (rid, text, out, thinking, toolUse) => ({
  type: 'assistant', requestId: rid, timestamp: iso(t0),
  message: {
    content: [{ type: 'text', text }].concat(toolUse ? [{ type: 'tool_use', name: 'x', input: {} }] : []),
    usage: { output_tokens: out, output_tokens_details: { thinking_tokens: thinking } },
  },
});

// 1450 Hebrew characters over 1000 visible tokens is 1.45 — the real ratio for
// this language. A fixed divisor of 3.5 would report less than half the rate.
const heb = transcript([
  { type: 'user', timestamp: iso(t0) },
  reply('r1', 'א'.repeat(1450), 1400, 400, false),
]);
const hebRatio = s.charsPerToken(s.readTranscriptRequests(heb));
assert.ok(Math.abs(hebRatio - 1.45) < 0.01, `expected ~1.45, got ${hebRatio}`);

// English text calibrates to its own, very different ratio from the same code.
const eng = transcript([
  { type: 'user', timestamp: iso(t0) },
  reply('r2', 'x'.repeat(3100), 1000, 0, false),
]);
assert.ok(Math.abs(s.charsPerToken(s.readTranscriptRequests(eng)) - 3.1) < 0.01);

// A reply that called a tool is excluded: its token count includes arguments
// that produced no text, so counting it would drag the ratio down.
const tooled = transcript([
  { type: 'user', timestamp: iso(t0) },
  reply('r3', 'א'.repeat(300), 2000, 0, true),
]);
assert.strictEqual(s.charsPerToken(s.readTranscriptRequests(tooled)), null);

// Too little text to calibrate on is ignored rather than trusted.
const tiny = transcript([
  { type: 'user', timestamp: iso(t0) },
  reply('r4', 'short', 10, 0, false),
]);
assert.strictEqual(s.charsPerToken(s.readTranscriptRequests(tiny)), null);
assert.strictEqual(s.charsPerToken(null), null);

// --- live rate, averaged over the window ------------------------------------
const liveCfg = fs.mkdtempSync(path.join(os.tmpdir(), 'live-selftest-'));
fs.mkdirSync(path.join(liveCfg, 'cache'), { recursive: true });
const logPath = s.streamLogPath(liveCfg);
const nowMs = Date.now();
fs.writeFileSync(logPath, [
  `sessA ${nowMs - 500} 300 100`,
  `sessA ${nowMs - 1500} 300 100`,
  `sessA ${nowMs - 2500} 300 100`,
  `sessA ${nowMs - 9000} 9999 9999`,  // outside the 3s window
  `sessB ${nowMs - 500} 9999 0`,      // another window's stream
  `sessA ${nowMs - 500} 10 99`,       // latin count above the total: impossible
  'garbage line',
  `sessA ${nowMs - 500} 50`,          // three fields: an older hook's line
].join('\n') + '\n');

// 900 characters inside a 3 second window averages to 300 per second — the
// window divides the total, so one big batch cannot spike the reading.
assert.deepStrictEqual(s.readLiveCharRate(liveCfg, 'sessA', nowMs, 3000), { chars: 300, latin: 100 });
// A wider window spreads the same characters over more seconds, which is what
// smooths the reading between bursts rather than changing what was measured.
assert.deepStrictEqual(s.readLiveCharRate(liveCfg, 'sessA', nowMs, 5000), { chars: 180, latin: 60 });
// Other sessions, stale lines, impossible counts and old-format lines are all
// excluded rather than silently corrupting the rate.
assert.deepStrictEqual(s.readLiveCharRate(liveCfg, 'sessB', nowMs, 3000), { chars: 3333, latin: 0 });
assert.strictEqual(s.readLiveCharRate(liveCfg, 'sessC', nowMs, 3000), null);
assert.strictEqual(s.readLiveCharRate(liveCfg, 'sessA', nowMs + 60000, 3000), null);
assert.strictEqual(s.readLiveCharRate(liveCfg, null, nowMs, 3000), null);
assert.strictEqual(s.readLiveCharRate(path.join(liveCfg, 'gone'), 'sessA', nowMs, 3000), null);
fs.rmSync(liveCfg, { recursive: true, force: true });

// --- script-aware model -----------------------------------------------------
assert.strictEqual(s.countLatin('abc'), 3);
assert.strictEqual(s.countLatin('שלום'), 0);
assert.strictEqual(s.countLatin('שלום hello'), 6);

// Two replies of known composition pin both coefficients: Latin text at 4
// characters per token, Hebrew at 1.25.
const mixed = transcript([
  { type: 'user', timestamp: iso(t0) },
  reply('m1', 'x'.repeat(400) + 'א'.repeat(400), 100 + 320, 0, false),
  reply('m2', 'x'.repeat(800) + 'א'.repeat(200), 200 + 160, 0, false),
]);
const model = s.tokenModel(s.readTranscriptRequests(mixed));
assert.ok(Math.abs(model.perLatin - 0.25) < 0.01, `perLatin ${model.perLatin}`);
assert.ok(Math.abs(model.perOther - 0.8) < 0.01, `perOther ${model.perOther}`);

// The whole point: 1000 Latin characters after a Hebrew-only calibration. The
// blended ratio alone would call this ~690 tokens; the model says 250, and the
// real answer is 250.
const hebOnly = s.readTranscriptRequests(heb);
const hebRatioOnly = s.charsPerToken(hebOnly);
assert.strictEqual(s.estimateTokens(1000, 1000, hebRatioOnly, null), 690);
assert.strictEqual(s.estimateTokens(1000, 1000, hebRatioOnly, model), 250);

// A model fitted from a single reply is not trusted at all.
assert.strictEqual(s.tokenModel(s.readTranscriptRequests(heb)), null);
// Nor is one whose answer is wildly far from the ratio's — the ratio bounds it.
assert.strictEqual(s.estimateTokens(1000, 1000, 1.45, { perLatin: 10, perOther: 10 }), 690);
// ...while a correction the size of a real language switch is let through.
assert.strictEqual(s.estimateTokens(1000, 1000, 1.45, { perLatin: 0.25, perOther: 0.25 }), 250);
// With no calibration at all there is nothing to report rather than a guess.
assert.strictEqual(s.estimateTokens(1000, 1000, null, null), null);
assert.strictEqual(s.estimateTokens(0, 0, 1.45, model), null);

// The background sampler must quit on its own when nothing has drawn the
// status line recently — otherwise it outlives every closed Claude Code window.
const sampDir = fs.mkdtempSync(path.join(os.tmpdir(), 'net-sampler-selftest-'));
fs.mkdirSync(path.join(sampDir, 'cache'), { recursive: true });
const mark = path.join(sampDir, 'cache', 'net-render.mark');
fs.writeFileSync(mark, '0');
fs.utimesSync(mark, new Date(Date.now() - 3600000), new Date(Date.now() - 3600000));
const run = require('child_process').spawnSync(
  process.execPath,
  [path.join(__dirname, 'gsd-statusline.js'), '--net-sampler'],
  { timeout: 10000, env: { ...process.env, CLAUDE_CONFIG_DIR: sampDir } }
);
assert.strictEqual(run.status, 0, 'sampler must exit on its own when the line is idle');
assert.strictEqual(run.signal, null, 'sampler must not have to be killed');
fs.rmSync(sampDir, { recursive: true, force: true });

// A killed sampler must not keep its lock looking alive: a fresh heartbeat
// whose pid answers to nobody has to let the next render start a replacement.
const liveDir = fs.mkdtempSync(path.join(os.tmpdir(), 'net-lock-selftest-'));
fs.mkdirSync(path.join(liveDir, 'cache'), { recursive: true });
const lock = path.join(os.tmpdir(), 'gsd-net-sampler.lock');
const savedLock = fs.existsSync(lock) ? fs.readFileSync(lock, 'utf8') : null;
fs.writeFileSync(lock, '9999999'); // fresh mtime, pid that cannot exist
const st = require('child_process').spawnSync(
  process.execPath,
  ['-e', `
    const s = require(${JSON.stringify(path.join(__dirname, 'gsd-statusline.js'))});
    process.stdout.write(String(s.readNetCache(process.env.CLAUDE_CONFIG_DIR) === null));
  `],
  { timeout: 10000, encoding: 'utf8', env: { ...process.env, CLAUDE_CONFIG_DIR: liveDir } }
);
assert.strictEqual(st.status, 0);
// The render replaced the dead pid's lock rather than trusting its timestamp.
const heldBy = parseInt(fs.readFileSync(lock, 'utf8'), 10);
assert.notStrictEqual(heldBy, 9999999, 'a dead sampler must not hold the lock');
if (savedLock !== null) fs.writeFileSync(lock, savedLock); else fs.rmSync(lock, { force: true });
fs.rmSync(liveDir, { recursive: true, force: true });

fs.rmSync(dir, { recursive: true, force: true });
console.log('ok — model label, reset countdown, latency + output-rate indicator');
