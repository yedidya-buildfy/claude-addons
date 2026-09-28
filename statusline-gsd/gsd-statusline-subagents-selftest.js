#!/usr/bin/env node
// Self-check for the agent-panel rows and the whole-session totals in
// gsd-statusline.js. Run: node ~/.claude/gsd-statusline-subagents-selftest.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'subagents-selftest-'));
process.env.CLAUDE_CONFIG_DIR = dir;
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
assert.strictEqual(s.usageCost('gpt-6', u), 0, 'unpriced model adds no dollars');
assert.strictEqual(s.usageCost('claude-opus-5-5', { ...u, speed: 'fast' }), 2 * opusCost);
// incremental: a new reply is picked up, nothing is counted twice
fs.appendFileSync(cur, JSON.stringify(reply('m4', 'claude-opus-5-5', u, new Date().toISOString())) + '\n');
assert.strictEqual(s.readSessionTotals(cur, cc).output, 5 * 500);
assert.strictEqual(s.readSessionTotals(cur, cc).output, 5 * 500);
const line = plain(s.formatSessionTotals(tot, now));
assert.ok(/^\$0\.\d\d · 2h 0m · 406K tokens \(reread 400K · new 4K · written 2K\)$/.test(line), line);
assert.strictEqual(s.formatSessionTotals(null), '');
assert.strictEqual(s.readSessionTotals(path.join(dir, 'none.jsonl'), cc).start, 0);

fs.rmSync(dir, { recursive: true, force: true });
console.log('subagents selftest: ok');
