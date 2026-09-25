#!/usr/bin/env node
// Self-check for the per-subagent rows in gsd-statusline.js.
// Run: node ~/.claude/gsd-statusline-subagents-selftest.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'subagents-selftest-'));
process.env.CLAUDE_CONFIG_DIR = dir;
const s = require('./gsd-statusline.js');

const transcript = path.join(dir, 'session.jsonl');
const subDir = path.join(dir, 'session', 'subagents');
fs.mkdirSync(subDir, { recursive: true });

function agent(id, meta, lines, ageMs = 0) {
  const file = path.join(subDir, `agent-${id}.jsonl`);
  fs.writeFileSync(file, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  fs.writeFileSync(path.join(subDir, `agent-${id}.meta.json`), JSON.stringify(meta));
  const t = (Date.now() - ageMs) / 1000;
  fs.utimesSync(file, t, t);
}
const reply = (model, effort, tokens, stop, timestamp = new Date().toISOString()) => ({
  type: 'assistant', effort, timestamp,
  message: { model, stop_reason: stop, usage: { input_tokens: 2, cache_creation_input_tokens: 0, cache_read_input_tokens: tokens - 2 } },
});

agent('running', { description: 'Build the form' }, [
  reply('claude-opus-5-5', 'medium', 250_000, 'tool_use'),
  { type: 'user', message: { content: [{ type: 'tool_result' }] } },
]);
agent('haiku', { description: 'Quick lookup' }, [reply('claude-haiku-4-5-20251001', undefined, 50_000, 'tool_use')]);
// The user's last prompt was a minute ago; a notification after it is not a prompt.
const minuteAgo = new Date(Date.now() - 60_000).toISOString();
fs.writeFileSync(transcript, [
  { type: 'user', origin: { kind: 'human' }, timestamp: new Date(Date.now() - 10 * 60_000).toISOString(), message: { content: 'old' } },
  { type: 'user', origin: { kind: 'human' }, timestamp: minuteAgo, message: { content: 'go' } },
  { type: 'user', origin: { kind: 'task-notification' }, timestamp: new Date().toISOString(), message: { content: '<task-notification>' } },
].map(l => JSON.stringify(l)).join('\n') + '\n');
assert.strictEqual(s.readLastHumanPromptAt(transcript), Date.parse(minuteAgo));

agent('done', { description: 'Finished one' }, [reply('claude-sonnet-5', 'high', 10_000, 'end_turn')]);
agent('olddone', { description: 'Long gone' }, [reply('claude-sonnet-5', 'high', 10_000, 'end_turn', new Date(Date.now() - 2 * 60_000).toISOString())]);
agent('killed', { description: 'Killed' }, [reply('claude-sonnet-5', 'high', 10_000, 'tool_use')], 60 * 60 * 1000);

const agents = s.readSubagents(transcript);
assert.deepStrictEqual(agents.map(a => a.name).sort(), ['Build the form', 'Finished one', 'Quick lookup']);
assert.strictEqual(agents[agents.length - 1].name, 'Finished one', 'finished ones sort last');

const opus = agents.find(a => a.name === 'Build the form');
assert.strictEqual(opus.used, 250_000);
assert.strictEqual(opus.window, 1_000_000, 'Opus subagents run on 1M');
assert.strictEqual(opus.effort, 'medium');
assert.strictEqual(agents.find(a => a.name === 'Quick lookup').window, 200_000);
assert.strictEqual(s.subagentWindow('claude-gpt-sol', 300_000), 1_000_000, 'usage past 200K proves 1M');

const out = s.formatSubagentRows(agents, {}).replace(/\x1b\[[\d;]*m/g, '');
assert.ok(out.startsWith('\n'), 'rows go below the main line');
assert.ok(out.includes('↳ Build the form · Opus 5.5 · medium │ ██░░░░░░░░ 25% 250K/1M'), out);
assert.ok(out.includes('↳ Quick lookup · Haiku 4.5 │'), out);
assert.ok(out.includes('✓ Finished one · Sonnet 5 · high'), out);

assert.deepStrictEqual(s.readSubagents(path.join(dir, 'nosession.jsonl')), []);
assert.strictEqual(s.readLastHumanPromptAt(path.join(dir, 'nosession.jsonl')), 0);
assert.strictEqual(s.formatSubagentRows([]), '');

fs.rmSync(dir, { recursive: true, force: true });
console.log('subagents selftest: ok');
