#!/usr/bin/env node
// Self-check for the agent-panel rows and the whole-session totals in
// gsd-statusline.js. Run: node ~/.claude/gsd-statusline-subagents-selftest.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'subagents-selftest-'));
process.env.CLAUDE_CONFIG_DIR = dir;
fs.mkdirSync(path.join(dir, 'cache'));
fs.writeFileSync(path.join(dir, 'cache', 'model-prices.json'), JSON.stringify({
  updated: Date.now(),
  models: {
    'gpt-6.1-sol': { input_cost_per_token: 0.000002, cache_read_input_token_cost: 0.0000001, output_cost_per_token: 0.00001,
      input_cost_per_token_above_272k_tokens: 0.000004, cache_read_input_token_cost_above_272k_tokens: 0.0000002, output_cost_per_token_above_272k_tokens: 0.000015 },
    'gemini-3.1-pro-preview': { input_cost_per_token: 0.000002, cache_read_input_token_cost: 0.0000002, output_cost_per_token: 0.000012,
      input_cost_per_token_above_200k_tokens: 0.000004, cache_read_input_token_cost_above_200k_tokens: 0.0000004, output_cost_per_token_above_200k_tokens: 0.000018 },
    'gemini-4-argon': { input_cost_per_token: 0.000002, cache_read_input_token_cost: 0.0000001, output_cost_per_token: 0.00001 },
  },
}));
fs.writeFileSync(path.join(dir, 'ccx-catalogue.json'), JSON.stringify([
  { id: 'claude-gemini-pro', raw_id: 'claude-gemini-pro', name: 'Gemini 3.1 Pro' },
  { id: 'gemini-4-argon-high', raw_id: 'claude-fable-5-dd-hgih-nogra-4-inimeg', name: 'Gemini 4 Argon' },
]));
const s = require('./gsd-statusline.js');
const plain = t => t.replace(/\x1b\[[\d;]*m/g, '');
const write = (file, lines) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
};

// --- agent panel rows: fixed columns, running vs finished --------------------
const now = Date.now();
const transcript = path.join(dir, 'proj', 'sess.jsonl');
write(path.join(dir, 'proj', 'sess', 'subagents', 'agent-a1.jsonl'), [
  { type: 'assistant', effort: 'medium', timestamp: new Date(now - 60_000).toISOString(), message: { id: 'm', model: 'claude-opus-5-5', usage: { output_tokens: 1000 } } },
]);
const input = {
  transcript_path: transcript, columns: 130,
  tasks: [
    { id: 'a1', type: 'local_agent', status: 'running', description: 'Build the form', label: 'Reading files', startTime: now - 261_000, model: 'claude-opus-5-5[1m]', contextWindowSize: 1_000_000, tokenCount: 250_000 },
    { id: 'a2', type: 'local_agent', status: 'completed', description: 'A much longer description than the name column can ever hold', startTime: now - 50_000, model: 'claude-haiku-4-5-20251001', effort: 'low', contextWindowSize: 200_000, tokenCount: 50_000 },
  ],
};
const rows = s.formatAgentRows(input, now, {}).split('\n').map(l => JSON.parse(l));
assert.deepStrictEqual(rows.map(r => r.id), ['a1', 'a2']);
const [run, done] = rows.map(r => plain(r.content));
assert.ok(run.startsWith('● Build the form'), run);
assert.ok(run.includes('Opus 5.5 · medium'), 'effort read from the agent transcript: ' + run);
assert.ok(run.includes('██░░░░░░░░  25% 250K/1M'), run);
assert.ok(run.includes('4m 21s') && run.endsWith('Reading files'), run);
assert.ok(/4m 21s +\$0\.02 +1K tok +Reading files$/.test(run), 'the agent\'s own $ and tokens: ' + run);
assert.ok(done.startsWith('✓ A much longer'), done);
assert.ok(done.includes('…'), 'long names are cut: ' + done);
assert.ok(done.includes('Haiku 4.5 · low'), done);
assert.ok(done.trimEnd().endsWith('50s'), 'finished clock stops at its last line: ' + done);
assert.strictEqual(run.indexOf('Opus'), done.indexOf('Haiku'), 'model column lines up');
assert.strictEqual(run.indexOf('250K/1M'), done.indexOf('50K/200K'), 'size column lines up');
assert.ok(rows[1].content.startsWith('\x1b[2m'), 'finished row is all grey');
assert.strictEqual(s.formatAgentRows({ tasks: [] }), '');
assert.strictEqual(s.formatDuration(59_000), '59s');
assert.strictEqual(s.formatDuration(3_725_000), '1h 2m');
assert.strictEqual(s.formatDuration(3 * 86_400_000 + 4 * 3_600_000), '3d 4h');

// --- session totals: main + subagents + an earlier transcript it continues ---
const reply = (id, model, u, ts, extra = {}) => ({ type: 'assistant', timestamp: ts, ...extra, message: { id, model, usage: u } });
const u = { input_tokens: 10, cache_creation_input_tokens: 1000, cache_read_input_tokens: 100_000, output_tokens: 500, cache_creation: { ephemeral_1h_input_tokens: 1000 } };
const t0 = new Date(now - 2 * 3_600_000).toISOString();
const proj = path.join(dir, 'p');
write(path.join(proj, 'old.jsonl'), [reply('m1', 'claude-opus-5-5', u, t0)]);
write(path.join(proj, 'old', 'subagents', 'agent-x.jsonl'), [reply('m9', 'claude-haiku-4-5', u, t0)]);
const cur = path.join(proj, 'new.jsonl');
write(cur, [
  reply('m1', 'claude-opus-5-5', u, t0, { session_id: 'old' }), // copied from the old transcript
  reply('m2', 'claude-opus-5-5', u, new Date(now - 60_000).toISOString()),
  reply('m2', 'claude-opus-5-5', u, new Date(now - 60_000).toISOString()), // second content block, same reply
]);
write(path.join(proj, 'new', 'subagents', 'agent-y.jsonl'), [reply('m3', 'claude-sonnet-5', u, new Date(now - 30_000).toISOString())]);
const cc = path.join(dir, 'cc');
s.readSessionTotals(cur, cc);                  // first pass finds the earlier transcript
const tot = s.readSessionTotals(cur, cc);      // second pass adds it
assert.strictEqual(tot.output, 4 * 500, 'm1 m2 m3 m9, each once');
assert.strictEqual(tot.read, 4 * 100_000);
assert.strictEqual(tot.start, Date.parse(t0));
const opusCost = (10 * 4 + 500 * 20 + 100_000 * 0.2 + 1000 * 8) / 1e6;
assert.ok(Math.abs(s.usageCost('claude-opus-5-5', u) - opusCost) < 1e-12);
assert.ok(Math.abs(s.usageCost('gpt-6.1-sol[1m]', u) - 0.01702) < 1e-12, 'CCX GPT: fresh input, cached input and output use their own rates');
assert.ok(Math.abs(s.usageCost('gpt-6.1-sol', { ...u, cache_read_input_tokens: 300_000 }) - 0.07154) < 1e-12, 'GPT long-context tier includes cached input');
assert.ok(Math.abs(s.usageCost('claude-gemini-pro', u) - 0.02802) < 1e-12, 'Gemini alias resolves through the live model catalogue');
assert.ok(Math.abs(s.usageCost('gemini-3.1-pro-preview', { ...u, cache_read_input_tokens: 200_000 }) - 0.09304) < 1e-12, 'Gemini long-context tier');
assert.ok(Math.abs(s.usageCost('gemini-4-argon-high', u) - 0.01702) < 1e-12, 'Gemini effort suffix is not a different price');
assert.ok(Math.abs(s.usageCost('claude-fable-5-dd-hgih-nogra-4-inimeg', u) - 0.01702) < 1e-12, 'disguised Gemini must not be charged as Fable');
assert.strictEqual(s.usageCost('unknown-future-model', u), null, 'unpriced is unknown, not free');
assert.strictEqual(s.usageCost('claude-opus-5-5', { ...u, speed: 'fast' }), 2 * opusCost);
// incremental: a new reply is picked up, nothing is counted twice
fs.appendFileSync(cur, JSON.stringify(reply('m4', 'claude-opus-5-5', u, new Date().toISOString())) + '\n');
assert.strictEqual(s.readSessionTotals(cur, cc).output, 5 * 500);
assert.strictEqual(s.readSessionTotals(cur, cc).output, 5 * 500);
const line = plain(s.formatSessionTotals(tot, now));
assert.ok(/^\$0\.\d\d · 2h 0m · 406K tokens \(reread 400K · new 4K · written 2K\)$/.test(line), line);
assert.strictEqual(s.formatSessionTotals(null), '');
assert.strictEqual(s.readSessionTotals(path.join(dir, 'none.jsonl'), cc).start, 0);

// Old zero-dollar caches are rebuilt, including subagents, without new replies.
const ccx = path.join(proj, 'ccx.jsonl');
write(ccx, [reply('gpt1', 'gpt-6.1-sol', u, t0), reply('gpt1', 'gpt-6.1-sol', u, t0)]);
write(path.join(proj, 'ccx', 'subagents', 'agent-gem.jsonl'), [reply('gem1', 'claude-gemini-pro', u, t0)]);
const oldCache = path.join(cc, 'cache', 'session-totals-ccx.json');
fs.writeFileSync(oldCache, JSON.stringify({ v: 2, offsets: { [ccx]: fs.statSync(ccx).size }, totals: { cost: 0 } }));
const ccxTotals = s.readSessionTotals(ccx, cc);
assert.ok(Math.abs(ccxTotals.cost - 0.04504) < 1e-12, 'historical GPT + Gemini usage is repriced once');
assert.ok(Math.abs(ccxTotals.perFile['agent-gem'].cost - 0.02802) < 1e-12, 'agent uses the same price rule');
assert.strictEqual(s.readSessionTotals(ccx, cc).cost, ccxTotals.cost, 'redraw does not double count');
const cached = JSON.parse(fs.readFileSync(oldCache));
cached.pricing = 'outdated-prices';
cached.totals.cost = 0;
fs.writeFileSync(oldCache, JSON.stringify(cached));
assert.strictEqual(s.readSessionTotals(ccx, cc).cost, ccxTotals.cost, 'changed prices invalidate cached totals');
fs.appendFileSync(ccx, JSON.stringify(reply('unknown', 'unknown-future-model', u, t0)) + '\n');
assert.ok(plain(s.formatSessionTotals(s.readSessionTotals(ccx, cc), now)).startsWith('$0.05+?'), 'partial prices are visibly incomplete');
assert.ok(plain(s.formatSessionTotals({ ...ccxTotals, cost: 0, unpriced: 1 }, now)).startsWith('$—'), 'missing price never looks free');
for (const [cost, dollars] of [[999, '$999'], [1000, '$1000'], [12345, '$12345'], [1234567, '$1234567']]) {
  assert.ok(plain(s.formatSessionTotals({ ...tot, cost }, now)).startsWith(`${dollars} ·`), 'dollar totals are never capped or truncated at three digits');
}

fs.rmSync(dir, { recursive: true, force: true });
console.log('subagents selftest: ok');
