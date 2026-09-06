#!/usr/bin/env node
// Loopback hop in front of cliproxyapi. Claude Code still talks to one local
// address; this process cleans tool schemas, then forwards to the proxy.
// Streaming responses are piped through unchanged.
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { sanitizeRequestBody } = require('./sanitize-schema');

const listenPort = Number(process.env.CCX_REWRITE_PORT || 8316);
const upstreamPort = Number(process.env.CCX_UPSTREAM_PORT || 8317);
const upstreamHost = process.env.CCX_UPSTREAM_HOST || '127.0.0.1';
const cataloguePath = path.join(os.homedir(), '.claude-ccx', 'ccx-catalogue.json');

function getLatestModel(tier, provider = 'Claude') {
  try {
    if (!fs.existsSync(cataloguePath)) return null;
    const data = JSON.parse(fs.readFileSync(cataloguePath, 'utf8'));
    const candidates = data.filter((m) => m.tier === tier && m.provider === provider && m.version != null);
    if (!candidates.length) return null;
    candidates.sort((a, b) => (b.version || 0) - (a.version || 0));
    return candidates[0] ? candidates[0].id : null;
  } catch (_) {
    return null;
  }
}

function isPlanMode(body) {
  if (Array.isArray(body.tools)) {
    return body.tools.some((t) => {
      const name = t.name || (t.function && t.function.name);
      return name === 'ExitPlanMode';
    });
  }
  return false;
}

function rewriteGeminiIdentity(body, model) {
  if (!model.startsWith('claude-gemini-') && !model.startsWith('gemini-')) return false;
  if (!Array.isArray(body.system)) return false;
  let rewritten = false;
  for (const block of body.system) {
    if (block && block.type === 'text' && block.text === "You are a Claude agent, built on Anthropic's Claude Agent SDK.") {
      block.text = 'You are a coding agent.';
      delete block.cache_control;
      rewritten = true;
    }
  }
  return rewritten;
}

function rewriteModel(body) {
  if (!body || typeof body !== 'object') return { plan: false, incoming: '' };
  const incoming = typeof body.model === 'string' ? body.model : '';
  const rawModel = incoming.replace(/\[(1|2)m\]$/i, '').trim();
  if (!rawModel) return { plan: false, incoming };

  const plan = isPlanMode(body);

  if (rawModel === 'claude-fplan-sonnet' || rawModel === 'fplan-sonnet' || rawModel === 'sonnetplan') {
    if (plan) {
      body.model = getLatestModel('fable') || 'claude-fable-5-1';
    } else {
      body.model = getLatestModel('sonnet') || 'claude-sonnet-5';
    }
  } else if (rawModel === 'claude-fplan-opus' || rawModel === 'fplan-opus' || rawModel === 'opusplan') {
    if (plan) {
      body.model = getLatestModel('fable') || 'claude-fable-5-1';
    } else {
      body.model = getLatestModel('opus') || 'claude-opus-5';
    }
  } else {
    body.model = rawModel;
  }

  return {
    plan,
    incoming,
    outgoing: body.model,
    identityRewritten: rewriteGeminiIdentity(body, body.model),
  };
}

const HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
]);

function copyHeaders(src) {
  const out = {};
  for (const [key, value] of Object.entries(src)) {
    if (HOP.has(key.toLowerCase())) continue;
    out[key] = value;
  }
  return out;
}

function maybeSanitize(body, contentType) {
  if (!body.length) return { buffer: body, meta: null };
  if (!/json/i.test(contentType || '')) return { buffer: body, meta: null };
  let parsed;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch (_) {
    return { buffer: body, meta: null };
  }
  const meta = rewriteModel(parsed);
  const cleaned = sanitizeRequestBody(parsed);
  return { buffer: Buffer.from(JSON.stringify(cleaned)), meta };
}

const server = http.createServer((req, res) => {
  const chunks = [];
  const start = Date.now();
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    const incoming = Buffer.concat(chunks);
    const { buffer: body, meta } = maybeSanitize(incoming, req.headers['content-type']);
    const headers = copyHeaders(req.headers);
    headers.host = `${upstreamHost}:${upstreamPort}`;
    headers['content-length'] = String(body.length);

    const modelLog = meta && meta.incoming
      ? ` | model: ${meta.incoming}${meta.outgoing !== meta.incoming ? ` → ${meta.outgoing}` : ''} (plan: ${meta.plan}${meta.identityRewritten ? ', Gemini identity rewritten' : ''})`
      : '';

    const upstream = http.request({
      hostname: upstreamHost,
      port: upstreamPort,
      path: req.url,
      method: req.method,
      headers,
    }, (upRes) => {
      const elapsed = ((Date.now() - start) / 1000).toFixed(2);
      process.stderr.write(`[${new Date().toISOString()}] ${req.method} ${req.url}${modelLog} → ${upRes.statusCode} (${elapsed}s)\n`);
      res.writeHead(upRes.statusCode || 502, copyHeaders(upRes.headers));
      upRes.pipe(res);
    });
    upstream.on('error', (err) => {
      process.stderr.write(`[${new Date().toISOString()}] ${req.method} ${req.url}${modelLog} → error: ${err.message}\n`);
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
      }
      res.end(`ccx-rewrite: upstream ${path.basename(err.message || 'error')}`);
    });
    upstream.end(body);
  });
});

server.requestTimeout = 0;
server.headersTimeout = 0;
server.timeout = 0;

server.listen(listenPort, '127.0.0.1', () => {
  const addr = server.address();
  process.stderr.write(`ccx-rewrite listening 127.0.0.1:${addr.port} → ${upstreamHost}:${upstreamPort}\n`);
});
