#!/usr/bin/env node
// Self-check: right after a compaction the meter uses the post-compact size,
// not the stale pre-compact usage Claude Code keeps reporting until the next reply.
// Run: node gsd-statusline-compact-selftest.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readPostCompactTokens } = require('./gsd-statusline.js');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'compact-selftest-'));
function transcript(lines) {
  const p = path.join(dir, `t${Math.random().toString(36).slice(2)}.jsonl`);
  fs.writeFileSync(p, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  return p;
}
const reply = { type: 'assistant', message: { usage: { input_tokens: 2, cache_read_input_tokens: 600000 } } };
const boundary = { type: 'system', subtype: 'compact_boundary', compactMetadata: { preTokens: 600000, postTokens: 28822 } };

assert.strictEqual(readPostCompactTokens(transcript([reply, boundary, { type: 'user' }])), 28822);
assert.strictEqual(readPostCompactTokens(transcript([boundary, reply])), null);
assert.strictEqual(readPostCompactTokens(transcript([reply])), null);
assert.strictEqual(readPostCompactTokens(path.join(dir, 'missing.jsonl')), null);
console.log('compact selftest ok');
