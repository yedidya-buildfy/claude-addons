#!/usr/bin/env node
// usage-by-device — who on a shared Claude plan used how much.
//   sync [--force]            read new local usage, exchange with the other machines
//   rename <deviceId> <name>  rename any machine on the plan
//   retention <hours>         how long updates wait in the mailbox (12–168)
//   json                      the table the add-ons page shows
//   watch                     the same, one line per change, live
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { collect } from "./read-usage.mjs";
import { readJson, writeJson, emptyLedger, mergeDevice, mergeSettings, prune, deviceId, defaultName, validName, validDevice, validRetention, validTimeZone } from "./ledger.mjs";
import { derive, seal, unseal, sealDevice, publish, poll, DEFAULT_SERVER } from "./wire.mjs";
import { view } from "./view.mjs";

const HOME = process.env.HOME;
const DIR = path.join(HOME, ".claude", "usage-by-device");
const F = {
  ledger: path.join(DIR, "ledger.json"), state: path.join(DIR, "state.json"), lock: path.join(DIR, "sync.lock"),
  server: path.join(DIR, "server"), lastSync: path.join(DIR, "last-sync"), id: path.join(DIR, "device-id"), log: path.join(HOME, ".claude", "cache", "usage-by-device.log"),
  plan: path.join(HOME, ".claude", "cache", "claude-usage.json"), planFetch: path.join(HOME, ".claude", "scripts", "usage-fetch.sh"),
};
const EPOCH = "1970-01-01T00:00:00.000Z";
const log = (msg) => { try { fs.mkdirSync(path.dirname(F.log), { recursive: true }); fs.appendFileSync(F.log, `${new Date().toISOString()} ${msg}\n`); } catch {} };
const server = () => (fs.existsSync(F.server) ? fs.readFileSync(F.server, "utf8").trim() : DEFAULT_SERVER).replace(/\/$/, "");
// the hardware lookup is slow-ish; do it once per machine
const myId = () => {
  if (process.env.UBD_DEVICE_ID) return process.env.UBD_DEVICE_ID;
  try { const v = fs.readFileSync(F.id, "utf8").trim(); if (/^[0-9a-f]{16}$/.test(v)) return v; } catch {}
  const v = deviceId();
  try { fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(F.id, v); } catch {}
  return v;
};
const identity = () => derive(readJson(path.join(HOME, ".claude.json"), {}).oauthAccount);
const hash = (o) => crypto.createHash("sha1").update(JSON.stringify(o)).digest("hex");
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// One writer at a time on this machine. The lock names its owner; a lock whose
// owner is gone (killed hook, crashed run) is stale at once, any lock after 5 minutes.
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };
function lock(wait) {
  fs.mkdirSync(DIR, { recursive: true });
  for (let i = 0; ; i++) {
    try { fs.writeFileSync(F.lock, String(process.pid), { flag: "wx" }); return true; } catch {}
    try {
      const owner = Number(fs.readFileSync(F.lock, "utf8"));
      if (!alive(owner) || Date.now() - fs.statSync(F.lock).mtimeMs > 5 * 60e3) {
        // take it over by rename, so two processes clearing the same stale lock can't both win
        const mine = `${F.lock}.${process.pid}`;
        fs.writeFileSync(mine, String(process.pid));
        fs.renameSync(mine, F.lock);
        if (fs.readFileSync(F.lock, "utf8") === String(process.pid)) return true;
      }
    } catch {}
    if (!wait || i >= 100) return false;
    sleep(100);
  }
}
const unlock = () => { try { if (fs.readFileSync(F.lock, "utf8") === String(process.pid)) fs.rmSync(F.lock, { force: true }); } catch {} };
function withLock(fn) {
  if (!lock(true)) throw new Error("another sync is busy, try again");
  try { return fn(); } finally { unlock(); }
}

// Merges one mailbox message. Returns the device id (or "settings") it updated, else null.
function absorb(ledger, key, event) {
  const p = unseal(key, event.message);
  if (p?.kind === "device" && /^[0-9a-f]{16}$/.test(p.id) && validDevice(p.dev)) {
    const cur = ledger.devices[p.id];
    // only this machine knows its own usage (a clock step or an old copy must not replace it); the name may come from anyone
    ledger.devices[p.id] = p.id === myId() && cur ? mergeDevice(cur, { ...cur, name: p.dev.name, nameSetAt: p.dev.nameSetAt }) : mergeDevice(cur, p.dev);
    return p.id;
  }
  if (p?.kind === "settings" && validRetention(p.settings?.retentionHours) && typeof p.settings.setAt === "string"
      && (p.settings.timeZone === undefined || (validTimeZone(p.settings.timeZone) && typeof p.settings.tzSetAt === "string"))) {
    ledger.settings = mergeSettings(ledger.settings, p.settings);
    return "settings";
  }
  return null;
}

// Folds what this run learned into the ledger on disk, under the lock, so a
// rename made meanwhile survives: names and usage both merge newest-wins.
function saveMerged(ledger, stateUpdate) {
  withLock(() => {
    const disk = readJson(F.ledger, emptyLedger());
    for (const [id, dev] of Object.entries(ledger.devices)) disk.devices[id] = mergeDevice(disk.devices[id], dev);
    disk.settings = mergeSettings(disk.settings, ledger.settings);
    writeJson(F.ledger, disk);
    writeJson(F.state, { ...readJson(F.state, {}), ...stateUpdate(readJson(F.state, {})) });
    Object.assign(ledger, disk);
  });
}

async function sync({ force = false } = {}) {
  const id = identity();
  if (!id) return log("no Claude login found — skipped");
  let last = 0;
  try { last = Number(fs.readFileSync(F.lastSync, "utf8")); } catch {}
  if (!force && Date.now() - last < 60e3) return; // checked on every Claude reply — reads a few bytes, not the whole state
  const now = new Date(), t = now.getTime();
  let ledger, state;
  // 1. this machine's own usage — local only, under the lock, before any network call
  if (!lock(false)) return;
  try {
    state = readJson(F.state, {});
    ledger = readJson(F.ledger, emptyLedger());
    if (!ledger.settings.timeZone) Object.assign(ledger.settings, { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, tzSetAt: now.toISOString() });
    const tz = ledger.settings.timeZone;
    let me = ledger.devices[myId()];
    if (!me || !state.offsets || state.bucketTz !== tz) { // nothing to add onto, or days were cut by another clock → recount from the logs
      me = ledger.devices[myId()] = { name: me?.name ?? (process.env.UBD_DEVICE_NAME || defaultName()), nameSetAt: me?.nameSetAt ?? EPOCH, updatedAt: EPOCH, days: {}, hours: {} };
      state.offsets = {};
      state.bucketTz = tz;
    }
    if (collect({ projectsDir: path.join(HOME, ".claude", "projects"), offsets: state.offsets, dev: me, now: t, tz }) || me.updatedAt === EPOCH) me.updatedAt = now.toISOString();
    for (const d of Object.values(ledger.devices)) prune(d, now, tz);
    // read positions of files quiet for a day need no memory of recent replies (keeps the state small)
    for (const st of Object.values(state.offsets)) if (st.at && t - st.at > 86400e3) st.recent = {};
    state.lastSyncAt = t;
    fs.writeFileSync(F.lastSync, String(t));
    writeJson(F.ledger, ledger);
    writeJson(F.state, state);
  } catch (e) {
    return log(`sync: ${e.message}`);
  } finally {
    unlock();
  }

  // 2. the mailbox — no lock held, so a rename from the page never waits on the network
  try {
    const srv = server(), retentionMs = ledger.settings.retentionHours * 3600e3;
    const fresh = state.lastId && t - (state.lastPollAt ?? 0) < retentionMs;
    const published = state.published ?? {};
    const events = await poll(srv, id.topic, fresh ? state.lastId : `${ledger.settings.retentionHours}h`);
    for (const e of events) {
      const got = absorb(ledger, id.key, e);
      const cur = got === "settings" ? ledger.settings : ledger.devices[got];
      // what we just received is already in the mailbox — no need to echo it
      if (got && hash(cur) === hash(unseal(id.key, e.message)[got === "settings" ? "settings" : "dev"])) published[got] = { hash: hash(cur), at: e.time * 1000 };
    }
    const lastId = events.length ? events.at(-1).id : state.lastId;
    saveMerged(ledger, () => ({ lastId, lastPollAt: t, published, mailbox: { ok: true, at: t } })); // what was received is kept even if a publish fails

    const due = (k, obj) => { const h = hash(obj), p = published[k]; return !p || p.hash !== h || t - p.at > retentionMs / 2 ? h : null; };
    for (const [devId, dev] of Object.entries(ledger.devices)) {
      const h = due(devId, dev);
      if (!h) continue;
      await publish(srv, id.topic, sealDevice(id.key, devId, dev));
      published[devId] = { hash: h, at: t };
    }
    const hs = due("settings", ledger.settings);
    if (hs && (ledger.settings.setAt !== EPOCH || ledger.settings.timeZone)) {
      await publish(srv, id.topic, seal(id.key, { kind: "settings", settings: ledger.settings }));
      published.settings = { hash: hs, at: t };
    }
    saveMerged(ledger, () => ({ published }));
  } catch (e) {
    log(`sync: ${e.message}`);
    try { withLock(() => writeJson(F.state, { ...readJson(F.state, {}), mailbox: { ok: false, at: t, error: e.message } })); } catch {}
  }
}

function rename(devId, name) {
  if (!validName(name)) throw new Error("השם צריך להיות 1–40 תווים");
  withLock(() => {
    const ledger = readJson(F.ledger, emptyLedger());
    const d = ledger.devices[devId];
    if (!d) throw new Error("אין מכשיר כזה");
    d.name = name.trim();
    d.nameSetAt = new Date().toISOString();
    writeJson(F.ledger, ledger);
  });
}

function setRetention(hours) {
  if (!validRetention(hours)) throw new Error("בין 12 ל-168 שעות");
  withLock(() => {
    const ledger = readJson(F.ledger, emptyLedger());
    ledger.settings = { retentionHours: hours, setAt: new Date().toISOString() };
    writeJson(F.ledger, ledger);
  });
}

function currentView() {
  const plan = readJson(F.plan, null);
  try {
    const age = Date.now() - fs.statSync(F.plan).mtimeMs;
    if (age > 10 * 60e3 && fs.existsSync(F.planFetch)) spawn(F.planFetch, [], { stdio: "ignore", detached: true }).unref();
  } catch {}
  return view(readJson(F.ledger, emptyLedger()), myId(), plan, new Date(), readJson(F.state, {}).mailbox ?? null);
}

async function watch() {
  // whoever started us (the add-ons page) is gone → stop, instead of retrying forever as an orphan
  const parent = process.ppid;
  setInterval(() => { if (process.ppid !== parent) process.exit(0); }, 2000).unref();
  process.stdout.on("error", () => process.exit(0));
  const print = () => process.stdout.write(JSON.stringify(currentView()) + "\n");
  print();
  await sync({ force: true });
  print();
  const id = identity();
  if (!id) { setInterval(() => {}, 3600e3); return; } // not logged in: nothing live to follow, but stay up so the page doesn't keep restarting us
  // live: resume from the last message seen, give up on a silent connection (ntfy sends a keepalive every 45s),
  // and back off while the mailbox is down so reconnects don't eat the rate limit syncs need
  const base = Number(process.env.UBD_WATCH_RETRY_MS) || 5000;
  let since = readJson(F.state, {}).lastId, wait = base;
  for (;;) {
    const ctl = new AbortController();
    let idle = setTimeout(() => ctl.abort(), 120e3);
    try {
      const r = await fetch(`${server()}/${id.topic}/json${since ? `?since=${encodeURIComponent(since)}` : ""}`, { signal: ctl.signal });
      if (!r.ok) throw new Error(`stream ${r.status}`);
      let buf = "";
      const dec = new TextDecoder();
      for await (const chunk of r.body) {
        clearTimeout(idle); idle = setTimeout(() => ctl.abort(), 120e3);
        wait = base;
        buf += dec.decode(chunk, { stream: true });
        for (let i; (i = buf.indexOf("\n")) >= 0;) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          let e;
          try { e = JSON.parse(line); } catch { continue; }
          if (e.event !== "message") continue;
          since = e.id;
          withLock(() => { const l = readJson(F.ledger, emptyLedger()); if (absorb(l, id.key, e)) writeJson(F.ledger, l); });
          print();
        }
      }
    } catch (e) {
      log(`watch: ${e.message}`);
      wait = Math.min(wait * 2, 5 * 60e3);
    } finally {
      clearTimeout(idle);
    }
    await new Promise((ok) => setTimeout(ok, wait));
  }
}

const [cmd, ...args] = process.argv.slice(2);
try {
  if (cmd === "sync") await sync({ force: args.includes("--force") });
  else if (cmd === "rename") { rename(args[0], args.slice(1).join(" ")); await sync({ force: true }); }
  else if (cmd === "retention") { setRetention(Number(args[0])); await sync({ force: true }); }
  else if (cmd === "json") console.log(JSON.stringify(currentView()));
  else if (cmd === "watch") await watch();
  else { console.error("usage: ubd.mjs sync [--force] | rename <deviceId> <name> | retention <hours> | json | watch"); process.exitCode = 2; }
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
}
