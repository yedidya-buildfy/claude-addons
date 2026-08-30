#!/usr/bin/env node
// Loopback hop in front of cliproxyapi. Claude Code still talks to one local
// address; this process cleans tool schemas, then forwards to the proxy.
// Streaming responses are piped through unchanged.
'use strict';

const http = require('node:http');
const path = require('node:path');
const { sanitizeRequestBody } = require('./sanitize-schema');

const listenPort = Number(process.env.CCX_REWRITE_PORT || 8316);
const upstreamPort = Number(process.env.CCX_UPSTREAM_PORT || 8317);
const upstreamHost = process.env.CCX_UPSTREAM_HOST || '127.0.0.1';

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
  if (!body.length) return body;
  if (!/json/i.test(contentType || '')) return body;
  let parsed;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch (_) {
    return body;
  }
  const cleaned = sanitizeRequestBody(parsed);
  return Buffer.from(JSON.stringify(cleaned));
}

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    const incoming = Buffer.concat(chunks);
    const body = maybeSanitize(incoming, req.headers['content-type']);
    const headers = copyHeaders(req.headers);
    headers.host = `${upstreamHost}:${upstreamPort}`;
    headers['content-length'] = String(body.length);

    const upstream = http.request({
      hostname: upstreamHost,
      port: upstreamPort,
      path: req.url,
      method: req.method,
      headers,
    }, (upRes) => {
      res.writeHead(upRes.statusCode || 502, copyHeaders(upRes.headers));
      upRes.pipe(res);
    });
    upstream.on('error', (err) => {
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
