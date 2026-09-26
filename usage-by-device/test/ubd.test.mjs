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

function machine(server, id, name, acct = ACCT, tz) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ubd-e2e-"));
  fs.mkdirSync(path.join(home, ".claude/projects/p"), { recursive: true });
  fs.mkdirSync(path.join(home, ".claude/usage-by-device"), { recursive: true });
  if (acct) fs.writeFileSync(path.join(home, ".claude.json"), JSON.stringify({ oauthAccount: acct }));
  fs.writeFileSync(path.join(home, ".claude/usage-by-device/server"), server);
  const use = (msgId, model, dollars, at = new Date()) => fs.appendFileSync(path.join(home, ".claude/projects/p/s.jsonl"),
    JSON.stringify({ timestamp: at.toISOString(), requestId: `r${msgId}`, message: { id: msgId, model, usage: { input_tokens: dollars * 5e5 } } }) + "\n"); // Sonnet 5: $2/MTok
  const run = (...args) => new Promise((ok) => execFile(process.execPath, [UBD, ...args],
    { env: { ...process.env, HOME: home, UBD_DEVICE_ID: id, UBD_DEVICE_NAME: name, ...(tz ? { TZ: tz } : {}) } }, (err, stdout, stderr) => ok({ code: err?.code ?? 0, stdout, stderr })));
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

test("the mailbox can rename this machine but never overwrite its own usage", async () => {
  const box = await fakeNtfy();
  const a = machine(box.url, A, "Mine");
  a.use("m1", "claude-sonnet-5", 2);
  await a.run("sync", "--force");
  const { derive, sealDevice } = await import("../wire.mjs");
  const { key, topic } = derive(ACCT);
  const forged = { name: "Renamed", nameSetAt: "2099-01-01T00:00:00.000Z", updatedAt: "2099-01-01T00:00:00.000Z", days: {}, hours: {} };
  await fetch(`${box.url}/${topic}`, { method: "POST", body: sealDevice(key, A, forged) });
  await a.run("sync", "--force");
  assert.equal(a.ledger().devices[A].name, "Renamed");
  assert.equal(Object.values(a.ledger().devices[A].days)[0].w, 2);
  box.close();
});

test("ledger deleted but read positions kept → this machine's usage is recounted, not published empty", async () => {
  const a = machine("http://127.0.0.1:9", A, "Mine");
  a.use("m1", "claude-sonnet-5", 2);
  await a.run("sync", "--force");
  fs.rmSync(path.join(a.home, ".claude/usage-by-device/ledger.json"));
  await a.run("sync", "--force");
  assert.equal(Object.values(a.ledger().devices[A].days)[0].w, 2);
});

test("a lock left by a dead process does not block the next sync", async () => {
  const a = machine("http://127.0.0.1:9", A, "Mine");
  fs.writeFileSync(path.join(a.home, ".claude/usage-by-device/sync.lock"), "999999");
  a.use("m1", "claude-sonnet-5", 2);
  await a.run("sync", "--force");
  assert.equal(Object.values(a.ledger().devices[A].days)[0].w, 2);
});

test("a rename is not blocked by a slow mailbox, and the slow sync keeps it", async () => {
  const box = await fakeNtfy({ pollDelayMs: 3000 });
  const a = machine(box.url, A, "Mine");
  a.use("m1", "claude-sonnet-5", 2);
  await a.run("sync", "--force");
  a.use("m2", "claude-sonnet-5", 1);
  const slow = a.run("sync", "--force");
  await new Promise((ok) => setTimeout(ok, 500));
  const t0 = Date.now();
  // rename's own sync also waits on the slow mailbox; the rename itself must land before that
  const renaming = a.run("rename", A, "Quick");
  await new Promise((ok) => setTimeout(ok, 1500));
  assert.equal(a.ledger().devices[A].name, "Quick", `rename not written after ${Date.now() - t0}ms`);
  await slow; await renaming;
  assert.equal(a.ledger().devices[A].name, "Quick");
  assert.equal(Object.values(a.ledger().devices[A].days)[0].w, 3);
  box.close();
});

test("watch exits when the page server that started it is gone", async () => {
  const a = machine("http://127.0.0.1:9", A, "Mine"); // mailbox down: the loop retries and prints nothing more
  const { spawn } = await import("node:child_process");
  const env = { ...process.env, HOME: a.home, UBD_DEVICE_ID: A, UBD_DEVICE_NAME: "Mine" };
  const wrapper = spawn(process.execPath, ["-e", `const c = require("child_process").spawn(process.execPath, [${JSON.stringify(UBD)}, "watch"], { stdio: ["ignore", "inherit", "ignore"] }); console.error(c.pid); setInterval(() => {}, 1e6);`], { env, stdio: ["ignore", "pipe", "pipe"] });
  const pid = Number(await new Promise((ok) => wrapper.stderr.once("data", (d) => ok(String(d).trim()))));
  let lines = 0;
  await new Promise((ok) => wrapper.stdout.on("data", (c) => { lines += String(c).split("\n").length - 1; if (lines >= 2) ok(); }));
  wrapper.kill("SIGKILL"); // like the page server dying without cleaning up
  const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
  for (let i = 0; i < 40 && alive(); i++) await new Promise((ok) => setTimeout(ok, 200));
  const still = alive();
  if (still) process.kill(pid);
  assert.equal(still, false);
});

test("friends in other time zones count days by the plan's one clock", async () => {
  const box = await fakeNtfy();
  const a = machine(box.url, A, "Israel", ACCT, "Asia/Jerusalem"), b = machine(box.url, B, "Thailand", ACCT, "Asia/Bangkok");
  const y = new Date(Date.now() - 86400e3), at = new Date(Date.UTC(y.getUTCFullYear(), y.getUTCMonth(), y.getUTCDate(), 19, 30)); // 22:30 in Israel, 02:30 next day in Thailand
  const israelDay = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jerusalem" }).format(at);
  await a.run("sync", "--force");            // the first machine sets the plan's clock
  b.use("m1", "claude-sonnet-5", 2, at);
  await b.run("sync", "--force");            // learns the plan's clock
  await b.run("sync", "--force");            // recounts by it
  assert.deepEqual(Object.keys(b.ledger().devices[B].days), [israelDay]);
  box.close();
});

test("the page is told whether the mailbox answered", async () => {
  const dead = machine("http://127.0.0.1:9", A, "Mine");
  await dead.run("sync", "--force");
  assert.equal(JSON.parse((await dead.run("json")).stdout).mailbox.ok, false);
  const box = await fakeNtfy();
  const live = machine(box.url, B, "Mine");
  await live.run("sync", "--force");
  assert.equal(JSON.parse((await live.run("json")).stdout).mailbox.ok, true);
  box.close();
});

test("watch picks up where it left off after the live connection drops", async () => {
  const box = await fakeNtfy({ streamOnce: true });
  const a = machine(box.url, A, "Mine");
  await a.run("sync", "--force"); // leaves a message in the mailbox
  const { spawn } = await import("node:child_process");
  const child = spawn(process.execPath, [UBD, "watch"], { env: { ...process.env, HOME: a.home, UBD_DEVICE_ID: A, UBD_DEVICE_NAME: "Mine", UBD_WATCH_RETRY_MS: "200" }, stdio: ["ignore", "ignore", "ignore"] });
  for (let i = 0; i < 40 && box.streams.length < 2; i++) await new Promise((ok) => setTimeout(ok, 200));
  child.kill();
  assert.ok(box.streams.length >= 2, `reconnects: ${box.streams.length}`);
  assert.match(box.streams[1], /since=m\d+/);
  box.close();
});
