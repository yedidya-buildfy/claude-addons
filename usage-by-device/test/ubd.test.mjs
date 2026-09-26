// End to end: real ubd.mjs processes, sandboxed HOMEs, a fake mailbox. Never the real HOME.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { fakeNtfy } from "./fake-ntfy.mjs";

const UBD = path.join(path.dirname(fileURLToPath(import.meta.url)), "../ubd.mjs");
const ACCT = { accountUuid: "acct-1", organizationUuid: "org-1" };

function machine(server, id, name, acct = ACCT) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ubd-e2e-"));
  fs.mkdirSync(path.join(home, ".claude/projects/p"), { recursive: true });
  fs.mkdirSync(path.join(home, ".claude/usage-by-device"), { recursive: true });
  if (acct) fs.writeFileSync(path.join(home, ".claude.json"), JSON.stringify({ oauthAccount: acct }));
  fs.writeFileSync(path.join(home, ".claude/usage-by-device/server"), server);
  const use = (msgId, model, dollars) => fs.appendFileSync(path.join(home, ".claude/projects/p/s.jsonl"),
    JSON.stringify({ timestamp: new Date().toISOString(), requestId: `r${msgId}`, message: { id: msgId, model, usage: { input_tokens: dollars * 5e5 } } }) + "\n"); // Sonnet 5: $2/MTok
  const run = (...args) => new Promise((ok) => execFile(process.execPath, [UBD, ...args],
    { env: { ...process.env, HOME: home, UBD_DEVICE_ID: id, UBD_DEVICE_NAME: name } }, (err, stdout, stderr) => ok({ code: err?.code ?? 0, stdout, stderr })));
  const ledger = () => JSON.parse(fs.readFileSync(path.join(home, ".claude/usage-by-device/ledger.json"), "utf8"));
  const log = () => { try { return fs.readFileSync(path.join(home, ".claude/cache/usage-by-device.log"), "utf8"); } catch { return ""; } };
  return { home, use, run, ledger, log };
}
const A = "aaaaaaaaaaaaaaaa", B = "bbbbbbbbbbbbbbbb", C = "cccccccccccccccc";

test("two machines on one plan see each other; a third sees neither on another plan", async () => {
  const box = await fakeNtfy();
  const a = machine(box.url, A, "Mine"), b = machine(box.url, B, "Dana"), x = machine(box.url, C, "Other", { accountUuid: "zz", organizationUuid: "zz" });
  a.use("m1", "claude-sonnet-5", 3);
  await a.run("sync", "--force");
  b.use("m2", "claude-sonnet-5", 1);
  await b.run("sync", "--force");
  await a.run("sync", "--force");
  await x.run("sync", "--force");
  assert.equal(b.ledger().devices[A].name, "Mine");
  assert.equal(a.ledger().devices[B].days[Object.keys(a.ledger().devices[B].days)[0]].w, 1);
  assert.deepEqual(Object.keys(x.ledger().devices), [C]);
  const v = JSON.parse((await a.run("json")).stdout);
  assert.equal(v.devices.find((d) => d.me).periods.today.share, 0.75);
  box.close();
});

test("rename and retention travel to the other machine; a stale sync never undoes a rename", async () => {
  const box = await fakeNtfy();
  const a = machine(box.url, A, "Mine"), b = machine(box.url, B, "Dana");
  await a.run("sync", "--force"); await b.run("sync", "--force");
  assert.equal((await b.run("rename", A, "MacBook", "Pro", "של", "ידידיה")).code, 0);
  assert.equal((await b.run("retention", "96")).code, 0);
  a.use("m3", "claude-sonnet-5", 1); // A has fresher usage, older name
  await a.run("sync", "--force");
  await b.run("sync", "--force");
  for (const m of [a, b]) {
    assert.equal(m.ledger().devices[A].name, "MacBook Pro של ידידיה");
    assert.equal(m.ledger().settings.retentionHours, 96);
  }
  assert.equal((await b.run("rename", A, "")).code, 1);
  assert.equal((await b.run("retention", "500")).code, 1);
  box.close();
});

test("gossip: a machine that is on keeps a closed machine's data alive", async () => {
  const box = await fakeNtfy();
  const a = machine(box.url, A, "Mine"), b = machine(box.url, B, "Dana"), c = machine(box.url, C, "Third");
  a.use("m1", "claude-sonnet-5", 2);
  await a.run("sync", "--force"); await b.run("sync", "--force");
  box.msgs.length = 0; // the mailbox forgot everything; A stays closed
  const st = path.join(b.home, ".claude/usage-by-device/state.json");
  const s = JSON.parse(fs.readFileSync(st, "utf8")); s.published = {}; fs.writeFileSync(st, JSON.stringify(s)); // B's refresh is due
  await b.run("sync", "--force");
  await c.run("sync", "--force");
  assert.equal(c.ledger().devices[A].name, "Mine");
  box.close();
});

test("offline or broken mailbox: usage still recorded, exit 0, logged", async () => {
  const a = machine("http://127.0.0.1:9", A, "Mine");
  a.use("m1", "claude-sonnet-5", 2);
  assert.equal((await a.run("sync", "--force")).code, 0);
  assert.equal(Object.values(a.ledger().devices[A].days)[0].w, 2);
  assert.match(a.log(), /sync:/);
});

test("garbage in the channel is ignored", async () => {
  const box = await fakeNtfy();
  const a = machine(box.url, A, "Mine");
  await a.run("sync", "--force");
  const topic = box.msgs[0].topic;
  await fetch(`${box.url}/${topic}`, { method: "POST", body: "not a sealed message" });
  assert.equal((await a.run("sync", "--force")).code, 0);
  assert.deepEqual(Object.keys(a.ledger().devices), [A]);
  box.close();
});

test("no Claude login → nothing happens, exit 0; syncs are throttled to one a minute", async () => {
  const box = await fakeNtfy();
  const n = machine(box.url, A, "Mine", null);
  assert.equal((await n.run("sync")).code, 0);
  assert.equal(box.requests(), 0);
  const a = machine(box.url, B, "Dana");
  await a.run("sync");
  const after = box.requests();
  await a.run("sync");
  assert.equal(box.requests(), after);
  box.close();
});
