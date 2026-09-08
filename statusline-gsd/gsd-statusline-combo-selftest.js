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

// Full label keeps effort and context suffixes.
assert.strictEqual(
  s.formatModelLabel({
    model: { display_name: 'Claude Opus 5' },
    effort: { level: 'high' },
    context_window: { context_window_size: 1000000 },
    transcript_path: planning,
  }),
  'Claude Fable 5.1 · high · 1M ctx'
);

// Unlabelled ids still render as names, never as raw ids.
assert.strictEqual(s.prettyModelName('claude-fable-5-1[1m]', {}), 'Fable 5.1');

fs.rmSync(dir, { recursive: true, force: true });
console.log('ok — plan/execute combo label');
