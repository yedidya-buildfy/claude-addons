// Shared token-price lookup for the statusline. No inference or credentials.
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');

const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const priceFile = path.join(configDir, 'cache', 'model-prices.json');
const lockDir = `${priceFile}.lock`;
const attemptFile = `${priceFile}.attempt`;
const SOURCE = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
const DAY = 24 * 60 * 60 * 1000;
const HOUR = DAY / 24;

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

// Offline fallback for native Claude only; CCX never guesses another model's price.
const NATIVE_PRICES = [
  [/fable-5-1|mythos-5-1/, [10, 50, 0.25]],
  [/fable|mythos/, [10, 50, 1]],
  [/opus-5-5/, [4, 20, 0.2]],
  [/opus-4-1|opus-4(?!-\d)|opus-4-2025/, [15, 75, 1.5]],
  [/opus/, [5, 25, 0.5]],
  [/sonnet-5/, [2, 10, 0.2]],
  [/sonnet/, [3, 15, 0.3]],
  [/haiku-4/, [1, 5, 0.1]],
  [/haiku/, [0.8, 4, 0.08]],
];

// Whitelist data from the public catalogue; never evaluate downloaded content.
function parseModels(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid price catalogue');
  const models = {};
  for (const key of Object.keys(raw).sort()) {
    const id = key.replace(/^(?:openai|anthropic|gemini|xai)\//, '');
    if (!/^(?:claude|gpt|gemini|grok)-[\w.-]+$/.test(id)) continue;
    const row = raw[key];
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    const rates = {};
    for (const [field, value] of Object.entries(row)) {
      if (/^(?:input_cost_per_token|output_cost_per_token|cache_read_input_token_cost|cache_creation_input_token_cost)(?:_above_\d+k_tokens)?$/.test(field)
          && typeof value === 'number' && Number.isFinite(value) && value >= 0 && value < 1) rates[field] = value;
    }
    if (rates.input_cost_per_token === undefined || rates.output_cost_per_token === undefined) continue;
    // Direct provider rows win over provider-prefixed aliases.
    if (!models[id] || key === id) models[id] = rates;
  }
  if (!Object.keys(models).length) throw new Error('Price catalogue contains no supported models');
  return models;
}

const snapshot = readJson(priceFile);
let models = {};
try { models = parseModels(snapshot?.models); } catch {}
const catalogue = readJson(path.join(configDir, 'ccx-catalogue.json'));
const aliases = {};
for (const row of Array.isArray(catalogue) ? catalogue : []) {
  if (typeof row?.name !== 'string') continue;
  const name = row.name.toLowerCase().replace(/\s*\([^)]*\)/g, '').trim().replace(/\s+/g, '-').replace(/-(\d+)\.0-/g, '-$1-');
  for (const id of [row.id, row.raw_id]) if (typeof id === 'string') aliases[id] = name;
}
const pricingVersion = crypto.createHash('sha256')
  .update(JSON.stringify([models, aliases, NATIVE_PRICES.map(([re, rates]) => [re.source, rates])]))
  .digest('hex');
const pricingStale = !Object.keys(models).length || !Number.isFinite(snapshot?.updated) || Date.now() - snapshot.updated > DAY;

function priceFor(model) {
  const bare = String(model || '').replace(/\[\d+m\]$/i, '').trim().toLowerCase();
  const names = [bare, aliases[bare]].filter(Boolean);
  for (const name of [...names]) names.push(name.replace(/-(?:high|low|agent)$/, ''));
  for (const name of names) {
    const row = models[name] || models[`${name}-preview`];
    if (row) return { row, native: /^claude-/.test(name) };
  }
  // Encoded CCX ids start with "claude-fable" even for GPT/Gemini.
  if (!/^claude-(?:fable|mythos|opus|sonnet|haiku)-/.test(bare) || bare.includes('-dd-')) return null;
  const hit = NATIVE_PRICES.find(([re]) => re.test(bare));
  if (!hit) return null;
  const [input, output, cached] = hit[1].map(n => n / 1e6);
  return { native: true, row: { input_cost_per_token: input, output_cost_per_token: output, cache_read_input_token_cost: cached } };
}

function usageCost(model, usage) {
  const price = priceFor(model);
  if (!price) return null;
  const count = key => Number.isFinite(usage?.[key]) && usage[key] >= 0 ? usage[key] : 0;
  const fresh = count('input_tokens'), written = count('cache_creation_input_tokens');
  const cached = count('cache_read_input_tokens'), output = count('output_tokens');
  const prompt = fresh + written + cached;
  const row = { ...price.row };
  const tiers = [...new Set(Object.keys(row).map(k => k.match(/_above_(\d+)k_tokens$/)?.[1]).filter(Boolean))].map(Number).sort((a, b) => a - b);
  for (const tier of tiers) if (prompt > tier * 1000) {
    for (const key of ['input_cost_per_token', 'output_cost_per_token', 'cache_read_input_token_cost', 'cache_creation_input_token_cost']) {
      if (price.row[`${key}_above_${tier}k_tokens`] !== undefined) row[key] = price.row[`${key}_above_${tier}k_tokens`];
    }
  }
  const inputRate = row.input_cost_per_token;
  const readRate = row.cache_read_input_token_cost ?? inputRate;
  const hourWritten = Math.min(written, Math.max(0, Number(usage?.cache_creation?.ephemeral_1h_input_tokens) || 0));
  // CCX cache creation is ordinary fresh input, not Anthropic's cache-write premium.
  const writeCost = price.native
    ? (written - hourWritten) * (row.cache_creation_input_token_cost ?? inputRate * 1.25) + hourWritten * inputRate * 2
    : written * inputRate;
  const cost = fresh * inputRate + cached * readRate + output * row.output_cost_per_token + writeCost;
  return cost * (price.native && usage?.speed === 'fast' ? 2 : 1);
}

function formatCost(cost, unpriced = 0) {
  if (unpriced && !cost) return '$—';
  const dollars = cost >= 100 ? `$${Math.round(cost)}` : `$${cost.toFixed(2)}`;
  return dollars + (unpriced ? '+?' : '') + (pricingStale ? '*' : '');
}

async function refreshPrices(file = priceFile, fetcher = fetch) {
  const response = await fetcher(SOURCE, { signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`Price download failed: HTTP ${response.status}`);
  let text = '';
  for await (const chunk of response.body) {
    text += Buffer.from(chunk).toString('utf8');
    if (Buffer.byteLength(text) > 8 * 1024 * 1024) throw new Error('Price catalogue too large');
  }
  const data = { updated: Date.now(), source: SOURCE, models: parseModels(JSON.parse(text)) };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
    fs.renameSync(tmp, file);
  } finally { try { fs.unlinkSync(tmp); } catch {} }
  return data;
}

// Refresh once a day while a session is visible, retry hourly offline. Rendering never waits on a network request.
function refreshPricingInBackground() {
  if (!pricingStale) return;
  try {
    fs.mkdirSync(path.dirname(priceFile), { recursive: true });
    try { if (Date.now() - fs.statSync(attemptFile).mtimeMs < HOUR) return; } catch {}
    try {
      if (Date.now() - fs.statSync(lockDir).mtimeMs < 60_000) return;
      fs.rmdirSync(lockDir);
    } catch {}
    fs.mkdirSync(lockDir);
    fs.writeFileSync(attemptFile, '');
    const child = spawn(process.execPath, [__filename, '--refresh'], { detached: true, stdio: 'ignore', env: process.env });
    child.on('error', () => { try { fs.rmdirSync(lockDir); } catch {} });
    child.unref();
  } catch {}
}

if (require.main === module && process.argv.includes('--refresh')) {
  refreshPrices().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; })
    .finally(() => { try { fs.rmdirSync(lockDir); } catch {} });
}

module.exports = { usageCost, formatCost, pricingVersion, pricingStale, refreshPricingInBackground, refreshPrices, parseModels };
