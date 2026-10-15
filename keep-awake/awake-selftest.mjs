// node keep-awake/awake-selftest.mjs — the decision logic only; never touches the power setting.
import assert from 'node:assert/strict';
import { step, toggle, blank, LIMITS } from './awake.mjs';

const T = 1_000_000;
const obs = (o = {}) => ({ now: T, working: 0, onBattery: false, pct: 90, ...o });

// lid armed while idle waits for work instead of ending at once
let s = toggle(blank(), 'lid', T);
s = step(s, obs()); s = step(s, obs());
assert.equal(s.mode, 'lid');
// work seen, then one idle gap is not enough, two are
s = step(s, obs({ working: 2 }));
s = step(s, obs());
assert.equal(s.mode, 'lid');
s = step(s, obs());
assert.equal(s.mode, 'off'); assert.equal(s.note, 'done');
// pin ignores work ending
s = toggle(blank(), 'pin', T);
for (let i = 0; i < 5; i++) s = step(s, obs());
assert.equal(s.mode, 'pin');
// same button again = off
assert.equal(toggle(s, 'pin', T).mode, 'off');
// switching lid -> pin keeps it on
assert.equal(toggle(toggle(blank(), 'lid', T), 'pin', T).mode, 'pin');
// safety caps
assert.equal(step(s, obs({ onBattery: true, pct: LIMITS.batteryFloor - 1 })).mode, 'off');
assert.equal(step(s, obs({ onBattery: false, pct: 5 })).mode, 'pin');
assert.equal(step(s, obs({ now: T + LIMITS.maxMs + 1 })).note, '12h cap');
// ☕ stays until turned off: no work-ending, no battery or time cap
s = toggle(blank(), 'on', T);
s = step(s, obs({ working: 1 })); s = step(s, obs()); s = step(s, obs());
s = step(s, obs({ onBattery: true, pct: 3, now: T + LIMITS.maxMs * 2 }));
assert.equal(s.mode, 'on');
console.log('awake selftest: ok');
