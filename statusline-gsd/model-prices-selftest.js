#!/usr/bin/env node
// Run: node statusline-gsd/model-prices-selftest.js. No network or provider calls.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-prices-selftest-'));
process.env.CLAUDE_CONFIG_DIR = dir;
const p = require('./model-prices');
const file = path.join(dir, 'cache', 'model-prices.json');
const rate = { input_cost_per_token: 0.000002, output_cost_per_token: 0.00001, cache_read_input_token_cost: 0.0000001 };
const raw = { 'gpt-6.1-sol': rate, 'gemini/gemini-4-argon': rate };
const response = data => async () => new Response(JSON.stringify(data));
const state = () => JSON.parse(execFileSync(process.execPath, ['-e', `
  const p = require(${JSON.stringify(require.resolve('./model-prices'))});
  p.refreshPricingInBackground();
  console.log(JSON.stringify({ version: p.pricingVersion, stale: p.pricingStale, dollars: p.formatCost(1.25), unknown: p.formatCost(0, 1) }));
`], { env: process.env, encoding: 'utf8' }));

(async () => {
  try {
    assert.throws(() => p.parseModels(null), /Invalid/);
    assert.throws(() => p.parseModels([]), /Invalid/);
    assert.throws(() => p.parseModels({}), /no supported models/);
    assert.throws(() => p.parseModels({ 'gpt-bad': { ...rate, input_cost_per_token: -1 } }), /no supported models/);
    assert.throws(() => p.parseModels({ 'gpt-bad': { ...rate, output_cost_per_token: '0.5' } }), /no supported models/);
    assert.throws(() => p.parseModels({ 'gpt-bad': { ...rate, output_cost_per_token: Infinity } }), /no supported models/);
    const parsed = p.parseModels({
      ...raw,
      'openai/gpt-6.1-sol': { ...rate, output_cost_per_token: 0.0009 },
      'aws/gpt-6.1-sol': { ...rate, output_cost_per_token: 0.0008 },
      'gpt-test': { ...rate, output_cost_per_token_priority: 0.0005, injected: 'ignore me' },
    });
    assert.deepStrictEqual(parsed['gpt-6.1-sol'], rate, 'direct provider rate wins; resellers never overwrite it');
    assert.deepStrictEqual(parsed['gemini-4-argon'], rate, 'Gemini provider namespace is removed');
    assert.deepStrictEqual(parsed['gpt-test'], rate, 'only standard token prices cross the trust boundary');

    await p.refreshPrices(file, response(raw));
    const good = fs.readFileSync(file, 'utf8');
    assert.deepStrictEqual(JSON.parse(good).models, p.parseModels(raw));
    const first = state();
    assert.strictEqual(first.stale, false);
    assert.strictEqual(first.dollars, '$1.25');
    assert.strictEqual(first.unknown, '$—');
    assert.ok(!fs.existsSync(`${file}.attempt`), 'fresh prices do not start a download');
    for (const fetcher of [
      async () => new Response('', { status: 503 }),
      async () => { throw new Error('offline'); },
      async () => new Response('{broken'),
      response({}),
      async () => new Response('x'.repeat(8 * 1024 * 1024 + 1)),
    ]) {
      await assert.rejects(p.refreshPrices(file, fetcher));
      assert.strictEqual(fs.readFileSync(file, 'utf8'), good, 'failed update keeps the last good catalogue byte-for-byte');
    }
    await p.refreshPrices(file, response({ ...raw, 'gpt-6.1-sol': { ...rate, output_cost_per_token: 0.00002 } }));
    assert.notStrictEqual(state().version, first.version, 'price changes reprice historical usage');
    const changed = JSON.parse(fs.readFileSync(file));
    changed.updated = Date.now() - 2 * 24 * 60 * 60 * 1000;
    fs.writeFileSync(file, JSON.stringify(changed));
    fs.mkdirSync(`${file}.lock`);
    const stale = state();
    assert.strictEqual(stale.stale, true);
    assert.strictEqual(stale.dollars, '$1.25*', 'offline or old prices have a visible marker');
    assert.ok(!fs.existsSync(`${file}.attempt`), 'another session owns the refresh lock');
    fs.rmdirSync(`${file}.lock`);
    fs.writeFileSync(`${file}.attempt`, '');
    state();
    assert.ok(!fs.existsSync(`${file}.lock`), 'failed downloads retry hourly, not on every redraw');
    console.log('model prices selftest: ok');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
