#!/usr/bin/env node
// Self-test for ccx-usage.js time formatting (no network, no caches).
'use strict';
const assert = require('node:assert');
process.stdout.isTTY = false;
const { resetText } = require('./ccx-usage.js');

const now = new Date(2026, 9, 6, 11, 0).getTime();
const at = (mins) => now + mins * 60_000;
assert.match(resetText(at(10), now), /^resets in 10m\s+\(11:10\)$/);
assert.match(resetText(at(170), now), /^resets in 2h 50m\s+\(13:50\)$/);
assert.match(resetText(at(1440 + 60), now), /^resets in 1d 1h\s+\(Wed 12:00\)$/);
assert.match(resetText(at(2 * 1440), now), /^resets in 2d\s+\(Thu 11:00\)$/);
assert.strictEqual(resetText(at(-1), now), 'reset passed');
assert.strictEqual(resetText(NaN, now), '');
console.log('ccx-usage selftest: ok');
