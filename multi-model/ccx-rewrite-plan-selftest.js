#!/usr/bin/env node
// Self-check for plan-mode detection in ccx-rewrite.js.
// Run: node ~/.claude/scripts/ccx-rewrite-plan-selftest.js
'use strict';
const assert = require('node:assert/strict');
const { isPlanMode, rewriteModel } = require('./ccx-rewrite.js');

const tools = [{ name: 'Bash' }, { name: 'ExitPlanMode' }];
const user = (...texts) => ({ role: 'user', content: texts.map((t) => ({ type: 'text', text: t })) });
const assistant = { role: 'assistant', content: [{ type: 'text', text: 'ok' }] };

const ON = '<system-reminder>\nPlan mode is active. The user indicated that they do not want you to execute yet.\n</system-reminder>';
const STILL = 'Plan mode still active (see full instructions earlier in conversation).';
const OFF = '## Exited Plan Mode\nYou have exited plan mode. You can now make edits, run tools, and take actions.';

// Tool list alone says nothing.
assert.equal(isPlanMode({ tools, messages: [user('hi')] }), false);

// Reminder in the newest user turn switches planning on.
assert.equal(isPlanMode({ tools, messages: [user('hi'), assistant, user('do it', ON)] }), true);

// It stays on across tool-result turns until the exit note appears.
const toolResult = { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'out' }] };
assert.equal(isPlanMode({ tools, messages: [user('do it', ON), assistant, toolResult, assistant, toolResult] }), true);
assert.equal(isPlanMode({ tools, messages: [user('do it', ON), assistant, user('more', STILL)] }), true);
assert.equal(isPlanMode({ tools, messages: [user('do it', ON), assistant, user('go', OFF)] }), false);

// Re-entering after an exit is on again.
assert.equal(isPlanMode({ tools, messages: [user('a', ON), assistant, user('b', OFF), assistant, user('c', ON)] }), true);

// String content (no blocks) is read too.
assert.equal(isPlanMode({ messages: [{ role: 'user', content: ON }] }), true);

// Model routing follows it for the proxy-only combo.
let body = { model: 'claude-fplan-sonnet[1m]', messages: [user('x', ON)] };
assert.equal(rewriteModel(body).plan, true);
assert.match(body.model, /fable/);
body = { model: 'claude-fplan-sonnet[1m]', tools, messages: [user('x')] };
assert.equal(rewriteModel(body).plan, false);
assert.match(body.model, /sonnet/);

console.log('ok — plan-mode detection');
