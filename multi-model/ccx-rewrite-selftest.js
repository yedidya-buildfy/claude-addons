#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const { spawn } = require('node:child_process');
const path = require('node:path');

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

async function freePort() {
  const server = http.createServer();
  const port = await listen(server);
  await close(server);
  return port;
}

async function waitUntilReady(child, stderr) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`request cleaner exited ${child.exitCode}`);
    if (stderr().includes('ccx-rewrite listening')) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('request cleaner did not start');
}

async function request(port) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/v1/messages', method: 'POST' }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.setTimeout(1_500, () => req.destroy(new Error('timed out waiting for request cleaner')));
    req.end('{}');
  });
}

async function main() {
  const upstream = http.createServer(() => {});
  const upstreamPort = await listen(upstream);
  const rewritePort = await freePort();
  const child = spawn(process.execPath, [path.join(__dirname, 'ccx-rewrite.js')], {
    env: {
      ...process.env,
      CCX_REWRITE_PORT: String(rewritePort),
      CCX_UPSTREAM_PORT: String(upstreamPort),
      CCX_UPSTREAM_TIMEOUT_MS: '100',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });

  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });

  try {
    await waitUntilReady(child, () => stderr);
    const result = await request(rewritePort);
    assert.equal(result.status, 504);
    assert.match(result.body, /timed out after 100ms/);
    assert.match(stderr, /timeout after 100ms/);
    console.log('PASS: stalled upstream requests fail after configured timeout');
  } finally {
    child.kill('SIGTERM');
    await close(upstream);
  }
}

main().catch((error) => {
  console.error(`FAIL: ${error.message}`);
  process.exitCode = 1;
});
