# usage-by-device Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A claude-addons add-on that shows, per named machine, how much of a shared Claude plan each one used (today / 7 days / 30 days / this month / 5-hour / week), synced between machines through a small mailbox on the owner's Akamai server.

**Architecture:** Each machine reads its own Claude Code session logs incrementally into weighted day/hour buckets, keeps a ledger of every machine's buckets, and exchanges encrypted per-device entries through a self-hosted ntfy topic derived from the Claude subscription. Sync runs from Claude Code hooks (no daemon); the `addons` page shows a live table via a generic "panel" extension to the engine.

**Tech Stack:** Node ≥ 20 stdlib only (`crypto`, `zlib`, `fetch`, `node:test`), stock `binwiederhier/ntfy` Docker image on Coolify.

**Spec:** `docs/superpowers/specs/2026-09-26-usage-by-device-design.md`

## Global Constraints

- No npm dependencies. Node stdlib only.
- Every test runs against a throwaway `HOME` — never the real one.
- Hooks and sync never fail Claude: every error → exit 0 + one line in `~/.claude/cache/usage-by-device.log` (except `rename`/`retention`, which exit 1 with a message for the page).
- Ledger/state written via temp file + rename.
- Days kept: 31 (local calendar). Hours kept: 7 × 24 (UTC). Retention setting: integer 12–168, default 72, plan-wide, newest change wins.
- Mailbox message body ≤ 4000 characters (ntfy's 4096-byte limit with margin).
- Device name: 1–40 characters, no control characters.
- Server: `cache-duration: 168h`, attachments off, container memory ≤ 64 MB, no auth (repo is public).
- Repo branch is `master`. Work in a worktree: `git -C ~/Desktop/Everything/old/claude-addons worktree add ../claude-addons-ubd -b usage-by-device master`.
- UI text Hebrew, RTL, matching the existing page tokens (`--accent`, `--card`, …) in light and dark.

## Review Focus

1. **A reply logged several times** (once per content block) → counted once. Test in Task 2.
2. **A log file mid-write** (last line without newline) → not counted until complete, then counted once. Test in Task 2.
3. **Two machines renaming the same device, or a rename racing a sync** → newest rename wins everywhere; a sync never undoes it. Tests in Tasks 3 and 5.
4. **Mailbox unreachable / machine offline** → own usage still recorded locally, hook exits 0, next online sync catches up. Test in Task 5.
5. **A message from another subscription or garbage in the topic** → ignored, never crashes, never merged. Tests in Tasks 4 and 5.

---

### Task 1: The mailbox on Akamai

**Files:**
- Create: `usage-by-device/server/server.yml`
- Create: `usage-by-device/server/README.md`

**Interfaces:**
- Produces: a public HTTPS base URL `https://usage.zencocovillas.com` (constant `DEFAULT_SERVER` in Task 4). If the owner picks another host name in Step 1, use that everywhere this plan says `usage.zencocovillas.com`.

- [ ] **Step 1: Confirm the host name with the owner**

This touches the production server and DNS. Ask: "The mailbox needs a web address. Proposed: `usage.zencocovillas.com` — you add one DNS A record → `172.233.209.162`. OK, or another name?" Wait for the answer and the DNS record.

- [ ] **Step 2: Write the server config**

`usage-by-device/server/server.yml`:

```yaml
# ntfy for usage-by-device — a mailbox, nothing else.
base-url: "https://usage.zencocovillas.com"
listen-http: ":80"
cache-file: "/var/cache/ntfy/cache.db"
cache-duration: "168h"            # ceiling for the retention setting on the page
attachment-cache-dir: ""          # attachments off
message-size-limit: "4096"
visitor-request-limit-burst: 60
visitor-request-limit-replenish: "5s"
visitor-message-daily-limit: 5000
enable-signup: false
enable-login: false
web-root: "disable"
```

`usage-by-device/server/README.md`:

```markdown
# usage-by-device mailbox

Stock `binwiederhier/ntfy` on the Akamai Coolify box. No code of ours runs here.

Coolify: project "claude-addons", resource type Docker Compose, domain
https://usage.zencocovillas.com, memory limit 64M, CPU shares 256.

    services:
      ntfy:
        image: binwiederhier/ntfy:latest
        command: serve
        volumes:
          - ./server.yml:/etc/ntfy/server.yml:ro
          - ntfy-cache:/var/cache/ntfy
        mem_limit: 64m
        cpu_shares: 256
    volumes:
      ntfy-cache:

Check: publish, restart the container, poll with since=72h — the message must still be there.
```

- [ ] **Step 3: Deploy through Coolify**

Create the Compose resource in the Coolify UI (`http://172.233.209.162:8000`) with the compose above, the file `server.yml` mounted, the domain, and Let's Encrypt. Tell the owner before pressing Deploy (production box).

- [ ] **Step 4: Verify persistence and limits**

```bash
T=ubd_selftest_$(openssl rand -hex 6)
curl -sf -d hello https://usage.zencocovillas.com/$T
ssh root@172.233.209.162 'docker restart $(docker ps -qf ancestor=binwiederhier/ntfy)'
sleep 5
curl -sf "https://usage.zencocovillas.com/$T/json?poll=1&since=72h" | grep -c '"hello"'   # expect 1
head -c 5000 /dev/zero | tr '\0' a | curl -s -o /dev/null -w '%{http_code}\n' --data-binary @- https://usage.zencocovillas.com/$T  # expect 413
ssh root@172.233.209.162 'docker stats --no-stream --format "{{.Name}} {{.MemUsage}}" | grep -i ntfy'  # well under 64MiB
```

- [ ] **Step 5: Commit**

```bash
git add usage-by-device/server
git commit -m "feat(usage-by-device): mailbox server config (ntfy on Coolify, 7-day cache)"
```

---

### Task 2: Reading this machine's usage

**Files:**
- Create: `usage-by-device/read-usage.mjs`
- Test: `usage-by-device/test/read-usage.test.mjs`

**Interfaces:**
- Produces:
  - `weight(model: string, usage: {input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens}) → number` (equivalent $)
  - `family(model) → "f"|"o"|"s"|"h"`
  - `dayKey(Date) → "YYYY-MM-DD"` (local), `hourKey(Date) → "YYYY-MM-DDTHH"` (UTC)
  - `collect({ projectsDir, offsets, dev, now }) → boolean` — adds new replies into `dev.days[day] = {w,f,o,s,h}` and `dev.hours[hour] = w`; mutates `offsets` (`{ [realPath]: { offset, recent: string[] } }`).

- [ ] **Step 1: Write the failing tests**

`usage-by-device/test/read-usage.test.mjs`:

```js
// Every test runs against a throwaway folder — never the real ~/.claude.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { weight, family, dayKey, collect } from "../read-usage.mjs";

const U = (i, o = 0, cw = 0, cr = 0) => ({ input_tokens: i, output_tokens: o, cache_creation_input_tokens: cw, cache_read_input_tokens: cr });
const line = (id, model, ts, u) => JSON.stringify({ type: "assistant", timestamp: ts, requestId: `r${id}`, message: { id, model, usage: u } }) + "\n";
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "ubd-read-")); fs.mkdirSync(path.join(d, "p1")); return d; };
const dev = () => ({ days: {}, hours: {} });
const NOW = new Date("2026-09-26T12:00:00Z");

test("weight uses the model's list price", () => {
  assert.equal(weight("claude-opus-5-5", U(1e6)), 4);
  assert.equal(weight("claude-opus-5", U(1e6)), 5);
  assert.equal(weight("claude-fable-5-1", U(0, 1e6)), 50);
  assert.equal(weight("claude-haiku-4-5-20251001", U(0, 0, 0, 1e6)), 0.1);
  assert.equal(weight("something-new", U(1e6)), 2); // unknown → Sonnet 5
  assert.equal(family("claude-mythos-5-1"), "f");
  assert.equal(family("claude-sonnet-5"), "s");
});

test("a reply logged once per content block is counted once", () => {
  const d = tmp(), f = path.join(d, "p1/a.jsonl");
  const l = line("m1", "claude-opus-5-5", NOW.toISOString(), U(1e6));
  fs.writeFileSync(f, l + l + l);
  const x = dev();
  assert.equal(collect({ projectsDir: d, offsets: {}, dev: x, now: NOW.getTime() }), true);
  assert.equal(x.days[dayKey(NOW)].w, 4);
  assert.equal(x.days[dayKey(NOW)].o, 4);
  assert.equal(x.hours["2026-09-26T12"], 4);
});

test("incremental: a second call counts only what was appended", () => {
  const d = tmp(), f = path.join(d, "p1/a.jsonl"), offsets = {}, x = dev();
  fs.writeFileSync(f, line("m1", "claude-sonnet-5", NOW.toISOString(), U(1e6)));
  collect({ projectsDir: d, offsets, dev: x, now: NOW.getTime() });
  fs.appendFileSync(f, line("m2", "claude-sonnet-5", NOW.toISOString(), U(1e6)));
  collect({ projectsDir: d, offsets, dev: x, now: NOW.getTime() });
  assert.equal(x.days[dayKey(NOW)].w, 4);
  assert.equal(collect({ projectsDir: d, offsets, dev: x, now: NOW.getTime() }), false);
});

test("a half-written last line waits until it is complete", () => {
  const d = tmp(), f = path.join(d, "p1/a.jsonl"), offsets = {}, x = dev();
  const l = line("m1", "claude-sonnet-5", NOW.toISOString(), U(1e6));
  fs.writeFileSync(f, l.slice(0, 40));
  collect({ projectsDir: d, offsets, dev: x, now: NOW.getTime() });
  assert.deepEqual(x.days, {});
  fs.appendFileSync(f, l.slice(40));
  collect({ projectsDir: d, offsets, dev: x, now: NOW.getTime() });
  assert.equal(x.days[dayKey(NOW)].w, 2);
});

test("a symlinked copy of the folder is read once", () => {
  const d = tmp();
  fs.writeFileSync(path.join(d, "p1/a.jsonl"), line("m1", "claude-sonnet-5", NOW.toISOString(), U(1e6)));
  fs.symlinkSync(path.join(d, "p1"), path.join(d, "alias"));
  const x = dev();
  collect({ projectsDir: d, offsets: {}, dev: x, now: NOW.getTime() });
  assert.equal(x.days[dayKey(NOW)].w, 2);
});

test("replies older than 32 days and synthetic entries are ignored", () => {
  const d = tmp();
  fs.writeFileSync(path.join(d, "p1/a.jsonl"),
    line("old", "claude-sonnet-5", "2026-08-01T00:00:00Z", U(1e6)) + line("syn", "<synthetic>", NOW.toISOString(), U(1e6)) + "not json\n");
  const x = dev();
  assert.equal(collect({ projectsDir: d, offsets: {}, dev: x, now: NOW.getTime() }), false);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test usage-by-device/test/read-usage.test.mjs`
Expected: FAIL — `Cannot find module '../read-usage.mjs'`.

- [ ] **Step 3: Implement**

`usage-by-device/read-usage.mjs`:

```js
// Reads Claude Code's own session logs and turns new replies into weighted
// usage buckets. Incremental: remembers how far each file was read.
import fs from "node:fs";
import path from "node:path";

// $/MTok list prices: input, output, cache write (5 min), cache read.
// ponytail: prefix table, first match wins — add a row when a new model family ships; unknown → Sonnet 5.
export const PRICES = [
  ["claude-fable", 10, 50, 12.5, 0.25],
  ["claude-mythos", 10, 50, 12.5, 0.25],
  ["claude-opus-5-5", 4, 20, 5, 0.2],
  ["claude-opus", 5, 25, 6.25, 0.5],
  ["claude-sonnet-5", 2, 10, 2.5, 0.2],
  ["claude-sonnet", 3, 15, 3.75, 0.3],
  ["claude-haiku", 1, 5, 1.25, 0.1],
];

export function weight(model, u) {
  const p = PRICES.find(([pre]) => model.startsWith(pre)) ?? PRICES[4];
  return ((u.input_tokens || 0) * p[1] + (u.output_tokens || 0) * p[2]
    + (u.cache_creation_input_tokens || 0) * p[3] + (u.cache_read_input_tokens || 0) * p[4]) / 1e6;
}

export const family = (model) => (/fable|mythos/.test(model) ? "f" : /opus/.test(model) ? "o" : /haiku/.test(model) ? "h" : "s");

const pad = (n) => String(n).padStart(2, "0");
export const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; // local calendar day
export const hourKey = (d) => d.toISOString().slice(0, 13); // UTC — compared against the plan's UTC reset times

// Every .jsonl under the folder, once per real file (the ccx profile symlinks the same folder).
function logFiles(root, sinceMs) {
  const out = new Set();
  const walk = (dir, depth) => {
    if (depth > 6) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      let st;
      try { st = fs.statSync(p); } catch { continue; }
      if (st.isDirectory()) walk(p, depth + 1);
      else if (e.name.endsWith(".jsonl") && st.mtimeMs >= sinceMs) out.add(fs.realpathSync(p));
    }
  };
  walk(root, 0);
  return [...out];
}

// Complete lines from `from` to the end of the file, and the offset after the last newline.
// ponytail: reads the whole new tail into memory — fine for session logs (tens of MB), not for GB files.
function readNew(file, from) {
  const fd = fs.openSync(file, "r");
  try {
    const size = fs.fstatSync(fd).size;
    if (size < from) from = 0; // file was rewritten
    const buf = Buffer.alloc(size - from);
    fs.readSync(fd, buf, 0, buf.length, from);
    const end = buf.lastIndexOf(10);
    if (end < 0) return { lines: [], offset: from };
    return { lines: buf.subarray(0, end).toString("utf8").split("\n"), offset: from + end + 1 };
  } finally {
    fs.closeSync(fd);
  }
}

export function collect({ projectsDir, offsets, dev, now = Date.now() }) {
  const since = now - 32 * 86400e3;
  const files = logFiles(projectsDir, since);
  let added = false;
  for (const file of files) {
    const st = offsets[file] ?? { offset: 0, recent: [] };
    const { lines, offset } = readNew(file, st.offset);
    for (const text of lines) {
      if (!text.includes('"usage"')) continue;
      let d;
      try { d = JSON.parse(text); } catch { continue; }
      const m = d.message;
      if (!m?.usage || typeof m.model !== "string" || m.model.startsWith("<") || !d.timestamp) continue;
      const key = `${m.id}:${d.requestId}`;
      if (st.recent.includes(key)) continue; // the same reply is logged once per content block
      st.recent.push(key);
      if (st.recent.length > 200) st.recent.shift();
      const t = new Date(d.timestamp);
      if (!(t.getTime() >= since)) continue;
      const w = weight(m.model, m.usage);
      const day = (dev.days[dayKey(t)] ??= { w: 0, f: 0, o: 0, s: 0, h: 0 });
      day.w += w;
      day[family(m.model)] += w;
      dev.hours[hourKey(t)] = (dev.hours[hourKey(t)] ?? 0) + w;
      added = true;
    }
    st.offset = offset;
    offsets[file] = st;
  }
  const live = new Set(files);
  for (const f of Object.keys(offsets)) if (!live.has(f)) delete offsets[f];
  return added;
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `node --test usage-by-device/test/read-usage.test.mjs`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add usage-by-device/read-usage.mjs usage-by-device/test/read-usage.test.mjs
git commit -m "feat(usage-by-device): read local session logs into weighted day/hour buckets"
```

---

### Task 3: The ledger — identity, merge, pruning

**Files:**
- Create: `usage-by-device/ledger.mjs`
- Test: `usage-by-device/test/ledger.test.mjs`

**Interfaces:**
- Consumes: `dayKey`, `hourKey` from Task 2.
- Produces:
  - `readJson(file, fallback)`, `writeJson(file, data)` (atomic)
  - `emptyLedger() → { devices: {}, settings: { retentionHours: 72, setAt: ISO } }`
  - `mergeDevice(a|undefined, b) → device`, `mergeSettings(a, b) → settings`
  - `prune(dev, now: Date) → dev`
  - `deviceId() → 16 hex chars`, `defaultName() → string`
  - `validName(s) → boolean`, `validDevice(dev) → boolean`, `validRetention(n) → boolean`
  - device shape: `{ name, nameSetAt: ISO, updatedAt: ISO, days: {[day]: {w,f,o,s,h}}, hours: {[hour]: number} }`

- [ ] **Step 1: Write the failing tests**

`usage-by-device/test/ledger.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readJson, writeJson, emptyLedger, mergeDevice, mergeSettings, prune, deviceId, validName, validDevice, validRetention } from "../ledger.mjs";

const T = (s) => `2026-09-${s}Z`;
const dev = (o) => ({ name: "A", nameSetAt: T("01T00:00:00.000"), updatedAt: T("01T00:00:00.000"), days: {}, hours: {}, ...o });

test("newest usage and newest name win independently", () => {
  const mine = dev({ updatedAt: T("26T10:00:00.000"), days: { "2026-09-26": { w: 5, f: 0, o: 5, s: 0, h: 0 } } });
  const theirs = dev({ name: "Dana's Mac", nameSetAt: T("26T09:00:00.000"), updatedAt: T("25T10:00:00.000") });
  const m = mergeDevice(mine, theirs);
  assert.equal(m.name, "Dana's Mac");
  assert.equal(m.days["2026-09-26"].w, 5);
  assert.equal(mergeDevice(undefined, theirs).name, "Dana's Mac");
});

test("newest retention setting wins", () => {
  const a = emptyLedger().settings;
  assert.equal(mergeSettings(a, { retentionHours: 96, setAt: T("26T00:00:00.000") }).retentionHours, 96);
  assert.equal(mergeSettings({ retentionHours: 96, setAt: T("26T00:00:00.000") }, a).retentionHours, 96);
});

test("prune keeps 31 days and 7 days of hours, and rounds", () => {
  const d = dev({
    days: { "2026-08-26": { w: 1, f: 0, o: 1, s: 0, h: 0 }, "2026-08-27": { w: 1.23456, f: 0, o: 1.23456, s: 0, h: 0 } },
    hours: { "2026-09-19T11": 1, "2026-09-19T13": 2.00049 },
  });
  prune(d, new Date("2026-09-26T12:30:00Z"));
  assert.deepEqual(Object.keys(d.days), ["2026-08-27"]);
  assert.equal(d.days["2026-08-27"].w, 1.235);
  assert.deepEqual(Object.keys(d.hours), ["2026-09-19T13"]);
  assert.equal(d.hours["2026-09-19T13"], 2);
});

test("writeJson is atomic and readJson falls back on garbage", () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ubd-l-")), "x/ledger.json");
  writeJson(f, { a: 1 });
  assert.deepEqual(readJson(f, null), { a: 1 });
  fs.writeFileSync(f, "{bad");
  assert.deepEqual(readJson(f, "fb"), "fb");
  assert.deepEqual(fs.readdirSync(path.dirname(f)), ["ledger.json"]);
});

test("identity and validation", () => {
  assert.match(deviceId(), /^[0-9a-f]{16}$/);
  assert.equal(deviceId(), deviceId());
  assert.ok(validName("MacBook Pro של ידידיה"));
  assert.ok(!validName(""));
  assert.ok(!validName("x".repeat(41)));
  assert.ok(!validName("a\nb"));
  assert.ok(validDevice(dev()));
  assert.ok(!validDevice({ ...dev(), days: { "2026-09-26": { w: "lots" } } }));
  assert.ok(!validDevice({ ...dev(), name: 5 }));
  assert.ok(validRetention(72) && !validRetention(11) && !validRetention(169) && !validRetention(72.5));
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test usage-by-device/test/ledger.test.mjs`
Expected: FAIL — `Cannot find module '../ledger.mjs'`.

- [ ] **Step 3: Implement**

`usage-by-device/ledger.mjs`:

```js
// The ledger: every machine's usage on this plan, as this machine last heard it.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { dayKey, hourKey } from "./read-usage.mjs";

export const DAYS_KEPT = 31;
export const HOURS_KEPT = 7 * 24;
const EPOCH = "1970-01-01T00:00:00.000Z";

export function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}

export function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, file);
}

export const emptyLedger = () => ({ devices: {}, settings: { retentionHours: 72, setAt: EPOCH } });

// Newest usage wins and newest name wins — separately, so a rename made on
// another machine is never undone by this machine's fresher usage.
export function mergeDevice(a, b) {
  if (!a) return structuredClone(b);
  const usage = b.updatedAt > a.updatedAt ? b : a;
  const naming = b.nameSetAt > a.nameSetAt ? b : a;
  return { name: naming.name, nameSetAt: naming.nameSetAt, updatedAt: usage.updatedAt, days: usage.days, hours: usage.hours };
}

export const mergeSettings = (a, b) => (b.setAt > a.setAt ? { retentionHours: b.retentionHours, setAt: b.setAt } : a);

const r3 = (x) => Math.round(x * 1000) / 1000;

export function prune(dev, now = new Date()) {
  const oldestDay = dayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - (DAYS_KEPT - 1)));
  const oldestHour = hourKey(new Date(now.getTime() - HOURS_KEPT * 3600e3));
  for (const k of Object.keys(dev.days)) if (k < oldestDay) delete dev.days[k];
  for (const k of Object.keys(dev.hours)) if (k < oldestHour) delete dev.hours[k];
  for (const d of Object.values(dev.days)) for (const f of Object.keys(d)) d[f] = r3(d[f]);
  for (const k of Object.keys(dev.hours)) dev.hours[k] = r3(dev.hours[k]);
  return dev;
}

// A stable id per machine that never reveals the hardware UUID itself.
export function deviceId() {
  let raw = "";
  try {
    raw = process.platform === "darwin"
      ? execFileSync("ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"], { encoding: "utf8" }).match(/"IOPlatformUUID" = "([^"]+)"/)?.[1] ?? ""
      : fs.readFileSync("/etc/machine-id", "utf8").trim();
  } catch {}
  return crypto.createHash("sha256").update(raw || os.hostname()).digest("hex").slice(0, 16);
}

export function defaultName() {
  try {
    if (process.platform === "darwin") return execFileSync("scutil", ["--get", "ComputerName"], { encoding: "utf8" }).trim();
  } catch {}
  return os.hostname();
}

export const validName = (s) => typeof s === "string" && s.trim().length >= 1 && s.trim().length <= 40 && !/[\u0000-\u001f\u007f]/.test(s);
export const validRetention = (n) => Number.isInteger(n) && n >= 12 && n <= 168;

const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
const num = (x) => typeof x === "number" && Number.isFinite(x) && x >= 0;

// Everything that arrives from the mailbox passes through here before it is merged.
export function validDevice(d) {
  if (!d || typeof d !== "object" || !validName(d.name) || !ISO.test(d.nameSetAt) || !ISO.test(d.updatedAt)) return false;
  if (!d.days || typeof d.days !== "object" || !d.hours || typeof d.hours !== "object") return false;
  for (const [k, v] of Object.entries(d.days)) {
    if (!/^\d{4}-\d\d-\d\d$/.test(k) || !v || !["w", "f", "o", "s", "h"].every((f) => num(v[f]))) return false;
  }
  for (const [k, v] of Object.entries(d.hours)) if (!/^\d{4}-\d\d-\d\dT\d\d$/.test(k) || !num(v)) return false;
  return true;
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `node --test usage-by-device/test/ledger.test.mjs`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add usage-by-device/ledger.mjs usage-by-device/test/ledger.test.mjs
git commit -m "feat(usage-by-device): ledger with per-field newest-wins merge, pruning, device identity"
```

---

### Task 4: The wire — channel, encryption, mailbox calls

**Files:**
- Create: `usage-by-device/wire.mjs`
- Test: `usage-by-device/test/wire.test.mjs`

**Interfaces:**
- Produces:
  - `DEFAULT_SERVER = "https://usage.zencocovillas.com"`, `MAX_BODY = 4000`
  - `derive(oauthAccount) → { topic: string, key: Buffer } | null`
  - `seal(key, obj) → base64 string`, `unseal(key, text) → obj | null`
  - `sealDevice(key, id, dev) → string` (≤ MAX_BODY; drops hours if needed)
  - `publish(server, topic, body, fetchImpl?) → Promise<id>`
  - `poll(server, topic, since, fetchImpl?) → Promise<Array<{id, time, message}>>`

- [ ] **Step 1: Write the failing tests**

`usage-by-device/test/wire.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { derive, seal, unseal, sealDevice, MAX_BODY } from "../wire.mjs";

const acct = { accountUuid: "aaaa-1", organizationUuid: "org-1" };

test("same subscription → same channel and key; another → different", () => {
  const a = derive(acct), b = derive({ ...acct }), c = derive({ accountUuid: "zzz", organizationUuid: "org-1" });
  assert.equal(a.topic, b.topic);
  assert.match(a.topic, /^ubd_[0-9a-f]{40}$/);
  assert.notEqual(a.topic, c.topic);
  assert.ok(a.key.equals(b.key));
  assert.equal(derive(undefined), null);
  assert.equal(derive({ accountUuid: "x" }), null);
});

test("seal/unseal round trip; wrong key or garbage → null", () => {
  const { key } = derive(acct);
  const s = seal(key, { kind: "x", n: 1 });
  assert.deepEqual(unseal(key, s), { kind: "x", n: 1 });
  assert.equal(unseal(derive({ accountUuid: "zzz", organizationUuid: "o" }).key, s), null);
  assert.equal(unseal(key, "hello"), null);
  assert.equal(unseal(key, ""), null);
});

test("worst case device (31 busy days, every hour of the week busy) fits one message", () => {
  const { key } = derive(acct);
  const days = {}, hours = {};
  for (let i = 0; i < 31; i++) days[`2026-08-${String(i + 1).padStart(2, "0")}`] = { w: 123.456, f: 12.345, o: 98.765, s: 11.111, h: 1.235 };
  const t0 = Date.parse("2026-09-19T00:00:00Z");
  for (let i = 0; i < 168; i++) hours[new Date(t0 + i * 3600e3).toISOString().slice(0, 13)] = 1.234 + i / 1000;
  const dev = { name: "x".repeat(40), nameSetAt: "2026-09-26T00:00:00.000Z", updatedAt: "2026-09-26T00:00:00.000Z", days, hours };
  const body = sealDevice(key, "0123456789abcdef", dev);
  assert.ok(body.length <= MAX_BODY, `body ${body.length}`);
  const back = unseal(key, body);
  assert.equal(back.id, "0123456789abcdef");
  assert.equal(Object.keys(back.dev.days).length, 31);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test usage-by-device/test/wire.test.mjs`
Expected: FAIL — `Cannot find module '../wire.mjs'`.

- [ ] **Step 3: Implement**

`usage-by-device/wire.mjs`:

```js
// How machines on the same plan find each other and talk: a channel and a key
// derived from the Claude subscription, encrypted messages in an ntfy mailbox.
import crypto from "node:crypto";
import zlib from "node:zlib";

export const DEFAULT_SERVER = "https://usage.zencocovillas.com";
export const MAX_BODY = 4000; // ntfy turns bodies over 4096 bytes into attachments

export function derive(oauth) {
  if (!oauth?.accountUuid || !oauth?.organizationUuid) return null;
  const secret = `${oauth.accountUuid}:${oauth.organizationUuid}`;
  const h = (label) => crypto.createHmac("sha256", secret).update(label).digest();
  return { topic: "ubd_" + h("usage-by-device/topic/v1").toString("hex").slice(0, 40), key: h("usage-by-device/key/v1") };
}

export function seal(key, obj) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([c.update(zlib.gzipSync(JSON.stringify(obj))), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64");
}

export function unseal(key, text) {
  try {
    const b = Buffer.from(text, "base64");
    if (b.length < 29) return null;
    const d = crypto.createDecipheriv("aes-256-gcm", key, b.subarray(0, 12));
    d.setAuthTag(b.subarray(12, 28));
    return JSON.parse(zlib.gunzipSync(Buffer.concat([d.update(b.subarray(28)), d.final()])).toString("utf8"));
  } catch {
    return null;
  }
}

// One device per message. If it ever outgrows a message the hours go first;
// the 5-hour / week columns then fall back to what the receiver already had.
export function sealDevice(key, id, dev) {
  const body = seal(key, { kind: "device", id, dev });
  return body.length <= MAX_BODY ? body : seal(key, { kind: "device", id, dev: { ...dev, hours: {} } });
}

export async function publish(server, topic, body, f = fetch) {
  const r = await f(`${server}/${topic}`, { method: "POST", body, signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error(`publish ${r.status}`);
  return (await r.json()).id;
}

export async function poll(server, topic, since, f = fetch) {
  const r = await f(`${server}/${topic}/json?poll=1&since=${encodeURIComponent(since)}`, { signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`poll ${r.status}`);
  const out = [];
  for (const l of (await r.text()).split("\n")) {
    if (!l) continue;
    try { const e = JSON.parse(l); if (e.event === "message" && typeof e.message === "string") out.push(e); } catch {}
  }
  return out;
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `node --test usage-by-device/test/wire.test.mjs`
Expected: PASS (3 tests). If the worst-case test fails on size, shorten the hour keys on the wire before touching `MAX_BODY`.

- [ ] **Step 5: Commit**

```bash
git add usage-by-device/wire.mjs usage-by-device/test/wire.test.mjs
git commit -m "feat(usage-by-device): subscription-derived channel, AES-GCM messages, ntfy calls"
```

---

### Task 5: The view and the command (`ubd.mjs`)

**Files:**
- Create: `usage-by-device/view.mjs`
- Create: `usage-by-device/ubd.mjs`
- Create: `usage-by-device/test/fake-ntfy.mjs`
- Test: `usage-by-device/test/view.test.mjs`, `usage-by-device/test/ubd.test.mjs`

**Interfaces:**
- Consumes: everything from Tasks 2–4.
- Produces:
  - `view(ledger, myId, plan, now) → { me, retentionHours, plan: {five?, week?}, devices: [{ id, name, me, updatedAt, periods: {today,d7,d30,month: {w, share}}, windows: {five?, week?: {share, pct}} }] }`
  - CLI: `node ubd.mjs sync [--force] | rename <deviceId> <name…> | retention <hours> | json | watch`
  - Files: `~/.claude/usage-by-device/{ledger.json,state.json,sync.lock,server}`; env overrides for tests: `UBD_DEVICE_ID`, `UBD_DEVICE_NAME`.
  - `watch` prints one JSON view per line on stdout, forever.

- [ ] **Step 1: Write the failing view test**

`usage-by-device/test/view.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { view } from "../view.mjs";

const day = (w) => ({ w, f: 0, o: w, s: 0, h: 0 });
const now = new Date(2026, 8, 26, 15, 0); // local 26 Sep 2026 15:00
const L = {
  settings: { retentionHours: 72, setAt: "x" },
  devices: {
    aaaaaaaaaaaaaaaa: { name: "Mine", updatedAt: "u", nameSetAt: "n", days: { "2026-09-26": day(30), "2026-09-01": day(10), "2026-08-28": day(100) },
      hours: { [new Date(now.getTime() - 3600e3).toISOString().slice(0, 13)]: 30 } },
    bbbbbbbbbbbbbbbb: { name: "Dana", updatedAt: "u", nameSetAt: "n", days: { "2026-09-26": day(10) },
      hours: { [new Date(now.getTime() - 2 * 3600e3).toISOString().slice(0, 13)]: 10 } },
  },
};
const plan = {
  five_hour: { utilization: 40, resets_at: new Date(now.getTime() + 2 * 3600e3).toISOString() },
  seven_day: { utilization: 44, resets_at: new Date(now.getTime() + 2 * 86400e3).toISOString() },
};

test("shares per period, month = this calendar month only", () => {
  const v = view(L, "aaaaaaaaaaaaaaaa", plan, now);
  const mine = v.devices.find((d) => d.me);
  assert.equal(mine.periods.today.share, 0.75);
  assert.equal(mine.periods.month.w, 40);           // 26.9 + 1.9, not 28.8
  assert.equal(mine.periods.d30.w, 140);            // includes 28.8
  assert.equal(v.devices[0].id, "aaaaaaaaaaaaaaaa"); // busiest first
});

test("plan windows split the official percentage by share inside the window", () => {
  const v = view(L, "aaaaaaaaaaaaaaaa", plan, now);
  const mine = v.devices.find((d) => d.me), dana = v.devices.find((d) => !d.me);
  assert.equal(mine.windows.five.pct, 30);
  assert.equal(dana.windows.week.pct, 11);
  assert.equal(view(L, "aaaaaaaaaaaaaaaa", null, now).devices[0].windows.five, undefined);
});

test("no usage anywhere → shares are 0, not NaN", () => {
  const v = view({ settings: L.settings, devices: { cccccccccccccccc: { name: "x", updatedAt: "u", nameSetAt: "n", days: {}, hours: {} } } }, "cccccccccccccccc", null, now);
  assert.equal(v.devices[0].periods.today.share, 0);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test usage-by-device/test/view.test.mjs`
Expected: FAIL — `Cannot find module '../view.mjs'`.

- [ ] **Step 3: Implement the view**

`usage-by-device/view.mjs`:

```js
// What the page shows: each device's share of the plan per period and per plan window.
import { dayKey } from "./read-usage.mjs";

const sumDays = (dev, keys) => keys.reduce((a, k) => a + (dev.days[k]?.w ?? 0), 0);
// an hour bucket counts if any of it falls inside the window
const sumHours = (dev, fromMs) => Object.entries(dev.hours).reduce((a, [k, w]) => (Date.parse(`${k}:00:00Z`) + 3600e3 > fromMs ? a + w : a), 0);

export function view(ledger, myId, plan, now = new Date()) {
  const day = (i) => dayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - i));
  const last = (n) => Array.from({ length: n }, (_, i) => day(i));
  const month = dayKey(now).slice(0, 7);
  const periods = { today: last(1), d7: last(7), d30: last(30), month: last(31).filter((k) => k.startsWith(month)) };

  const windows = {};
  for (const [name, field, span] of [["five", "five_hour", 5 * 3600e3], ["week", "seven_day", 7 * 86400e3]]) {
    const w = plan?.[field];
    if (typeof w?.utilization === "number" && w.resets_at) windows[name] = { utilization: w.utilization, resetsAt: w.resets_at, from: Date.parse(w.resets_at) - span };
  }

  const devs = Object.entries(ledger.devices);
  const total = (f) => devs.reduce((a, [, d]) => a + f(d), 0);
  const pTotals = Object.fromEntries(Object.entries(periods).map(([p, keys]) => [p, total((d) => sumDays(d, keys))]));
  const wTotals = Object.fromEntries(Object.entries(windows).map(([n, w]) => [n, total((d) => sumHours(d, w.from))]));

  return {
    me: myId,
    retentionHours: ledger.settings.retentionHours,
    plan: Object.fromEntries(Object.entries(windows).map(([n, w]) => [n, { utilization: w.utilization, resetsAt: w.resetsAt }])),
    devices: devs.map(([id, d]) => ({
      id, name: d.name, me: id === myId, updatedAt: d.updatedAt,
      periods: Object.fromEntries(Object.entries(periods).map(([p, keys]) => {
        const w = sumDays(d, keys);
        return [p, { w, share: pTotals[p] ? w / pTotals[p] : 0 }];
      })),
      windows: Object.fromEntries(Object.entries(windows).map(([n, win]) => {
        const share = wTotals[n] ? sumHours(d, win.from) / wTotals[n] : 0;
        return [n, { share, pct: Math.round(win.utilization * share * 10) / 10 }];
      })),
    })).sort((a, b) => b.periods.d7.w - a.periods.d7.w),
  };
}
```

- [ ] **Step 4: Run the view test**

Run: `node --test usage-by-device/test/view.test.mjs`
Expected: PASS (3 tests).

- [ ] **Step 5: Write the fake mailbox and the failing end-to-end tests**

`usage-by-device/test/fake-ntfy.mjs`:

```js
// A stand-in for the ntfy mailbox: publish, and poll since an id or a duration.
import http from "node:http";

export async function fakeNtfy() {
  const msgs = [];
  let n = 0, requests = 0;
  const srv = http.createServer((req, res) => {
    requests++;
    const u = new URL(req.url, "http://x");
    const [, topic, kind] = u.pathname.split("/");
    if (req.method === "POST") {
      let b = "";
      req.on("data", (c) => (b += c));
      req.on("end", () => {
        if (Buffer.byteLength(b) > 4096) { res.writeHead(413); return res.end("{}"); }
        const m = { id: `m${++n}`, time: Math.floor(Date.now() / 1000), event: "message", topic, message: b };
        msgs.push(m);
        res.end(JSON.stringify(m));
      });
      return;
    }
    if (kind === "json" && u.searchParams.get("poll") === "1") {
      const i = msgs.findIndex((m) => m.id === u.searchParams.get("since"));
      res.end(msgs.slice(i + 1).filter((m) => m.topic === topic).map((m) => JSON.stringify(m) + "\n").join(""));
      return;
    }
    res.writeHead(404); res.end("{}");
  });
  await new Promise((ok) => srv.listen(0, "127.0.0.1", ok));
  return { url: `http://127.0.0.1:${srv.address().port}`, msgs, requests: () => requests, close: () => srv.close() };
}
```

`usage-by-device/test/ubd.test.mjs`:

```js
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
```

- [ ] **Step 6: Run to verify they fail**

Run: `node --test usage-by-device/test/ubd.test.mjs`
Expected: FAIL — every test, `Cannot find module …/ubd.mjs` in stderr / ledger file missing.

- [ ] **Step 7: Implement the command**

`usage-by-device/ubd.mjs`:

```js
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
import { readJson, writeJson, emptyLedger, mergeDevice, mergeSettings, prune, deviceId, defaultName, validName, validDevice, validRetention } from "./ledger.mjs";
import { derive, seal, unseal, sealDevice, publish, poll, DEFAULT_SERVER } from "./wire.mjs";
import { view } from "./view.mjs";

const HOME = process.env.HOME;
const DIR = path.join(HOME, ".claude", "usage-by-device");
const F = {
  ledger: path.join(DIR, "ledger.json"), state: path.join(DIR, "state.json"), lock: path.join(DIR, "sync.lock"),
  server: path.join(DIR, "server"), log: path.join(HOME, ".claude", "cache", "usage-by-device.log"),
  plan: path.join(HOME, ".claude", "cache", "claude-usage.json"), planFetch: path.join(HOME, ".claude", "scripts", "usage-fetch.sh"),
};
const EPOCH = "1970-01-01T00:00:00.000Z";
const log = (msg) => { try { fs.mkdirSync(path.dirname(F.log), { recursive: true }); fs.appendFileSync(F.log, `${new Date().toISOString()} ${msg}\n`); } catch {} };
const server = () => (fs.existsSync(F.server) ? fs.readFileSync(F.server, "utf8").trim() : DEFAULT_SERVER).replace(/\/$/, "");
const myId = () => process.env.UBD_DEVICE_ID || deviceId();
const identity = () => derive(readJson(path.join(HOME, ".claude.json"), {}).oauthAccount);
const hash = (o) => crypto.createHash("sha1").update(JSON.stringify(o)).digest("hex");
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// One writer at a time on this machine; a lock older than 5 minutes is a crashed run.
function lock(wait) {
  fs.mkdirSync(DIR, { recursive: true });
  for (let i = 0; ; i++) {
    try { if (Date.now() - fs.statSync(F.lock).mtimeMs > 5 * 60e3) fs.rmSync(F.lock, { force: true }); } catch {}
    try { fs.closeSync(fs.openSync(F.lock, "wx")); return true; } catch {}
    if (!wait || i >= 100) return false;
    sleep(100);
  }
}
const unlock = () => fs.rmSync(F.lock, { force: true });
function withLock(fn) {
  if (!lock(true)) throw new Error("another sync is busy, try again");
  try { return fn(); } finally { unlock(); }
}

// Merges one mailbox message. Returns the device id (or "settings") it updated, else null.
function absorb(ledger, key, event) {
  const p = unseal(key, event.message);
  if (p?.kind === "device" && /^[0-9a-f]{16}$/.test(p.id) && validDevice(p.dev)) {
    ledger.devices[p.id] = mergeDevice(ledger.devices[p.id], p.dev);
    return p.id;
  }
  if (p?.kind === "settings" && validRetention(p.settings?.retentionHours) && typeof p.settings.setAt === "string") {
    ledger.settings = mergeSettings(ledger.settings, p.settings);
    return "settings";
  }
  return null;
}

async function sync({ force = false } = {}) {
  const id = identity();
  if (!id) return log("no Claude login found — skipped");
  if (!force && Date.now() - (readJson(F.state, {}).lastSyncAt ?? 0) < 60e3) return;
  if (!lock(false)) return;
  try {
    const now = new Date(), t = now.getTime();
    const state = readJson(F.state, {});
    const ledger = readJson(F.ledger, emptyLedger());
    const me = (ledger.devices[myId()] ??= { name: process.env.UBD_DEVICE_NAME || defaultName(), nameSetAt: EPOCH, updatedAt: EPOCH, days: {}, hours: {} });
    if (!state.offsets) { me.days = {}; me.hours = {}; state.offsets = {}; } // no memory of what was read → recount
    if (collect({ projectsDir: path.join(HOME, ".claude", "projects"), offsets: state.offsets, dev: me, now: t }) || me.updatedAt === EPOCH) me.updatedAt = now.toISOString();
    for (const d of Object.values(ledger.devices)) prune(d, now);
    state.lastSyncAt = t;
    writeJson(F.ledger, ledger); // local usage is safe before any network call
    writeJson(F.state, state);

    const srv = server(), retentionMs = ledger.settings.retentionHours * 3600e3;
    const fresh = state.lastId && t - (state.lastPollAt ?? 0) < retentionMs;
    state.published ??= {};
    const events = await poll(srv, id.topic, fresh ? state.lastId : `${ledger.settings.retentionHours}h`);
    for (const e of events) {
      const got = absorb(ledger, id.key, e);
      const cur = got === "settings" ? ledger.settings : ledger.devices[got];
      // what we just received is already in the mailbox — no need to echo it
      if (got && hash(cur) === hash(unseal(id.key, e.message)[got === "settings" ? "settings" : "dev"])) state.published[got] = { hash: hash(cur), at: e.time * 1000 };
    }
    if (events.length) state.lastId = events.at(-1).id;
    state.lastPollAt = t;

    const due = (k, obj) => { const h = hash(obj), p = state.published[k]; return !p || p.hash !== h || t - p.at > retentionMs / 2 ? h : null; };
    for (const [devId, dev] of Object.entries(ledger.devices)) {
      const h = due(devId, dev);
      if (!h) continue;
      await publish(srv, id.topic, sealDevice(id.key, devId, dev));
      state.published[devId] = { hash: h, at: t };
    }
    const hs = due("settings", ledger.settings);
    if (hs && ledger.settings.setAt !== EPOCH) {
      await publish(srv, id.topic, seal(id.key, { kind: "settings", settings: ledger.settings }));
      state.published.settings = { hash: hs, at: t };
    }
    writeJson(F.ledger, ledger);
    writeJson(F.state, state);
  } catch (e) {
    log(`sync: ${e.message}`);
  } finally {
    unlock();
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
  return view(readJson(F.ledger, emptyLedger()), myId(), plan);
}

async function watch() {
  const print = () => process.stdout.write(JSON.stringify(currentView()) + "\n");
  print();
  await sync({ force: true });
  print();
  const id = identity();
  if (!id) return;
  for (;;) {
    try {
      const r = await fetch(`${server()}/${id.topic}/json`);
      let buf = "";
      for await (const chunk of r.body) {
        buf += Buffer.from(chunk).toString("utf8");
        for (let i; (i = buf.indexOf("\n")) >= 0;) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          let e;
          try { e = JSON.parse(line); } catch { continue; }
          if (e.event !== "message") continue;
          withLock(() => { const l = readJson(F.ledger, emptyLedger()); if (absorb(l, id.key, e)) writeJson(F.ledger, l); });
          print();
        }
      }
    } catch (e) {
      log(`watch: ${e.message}`);
    }
    await new Promise((ok) => setTimeout(ok, 5000));
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
```

- [ ] **Step 8: Run all add-on tests**

Run: `node --test usage-by-device/test/`
Expected: PASS — read-usage (6), ledger (5), wire (3), view (3), ubd (6).

- [ ] **Step 9: Commit**

```bash
git add usage-by-device/view.mjs usage-by-device/ubd.mjs usage-by-device/test/fake-ntfy.mjs usage-by-device/test/view.test.mjs usage-by-device/test/ubd.test.mjs
git commit -m "feat(usage-by-device): sync/rename/retention/json/watch command with gossip and throttling"
```

---

### Task 6: The add-on manifest, hooks, and engine panel support

**Files:**
- Create: `usage-by-device/addon.json`
- Create: `usage-by-device/settings.json.snippet`
- Create: `usage-by-device/README.md`
- Modify: `engine/addons.mjs` (state() adds `panel`; three new routes)
- Test: `engine/test/engine.test.mjs` (append one test)

**Interfaces:**
- Consumes: CLI from Task 5.
- Produces:
  - manifest field `panel: { script: "~/…/ubd.mjs", calls: ["rename", "retention"] }`
  - `GET /api/panel?addon=<id>` → the `json` output
  - `POST /api/panel/call` `{ addon, cmd, args: string[] }` → `{ ok: true }` or 400 with the command's message
  - `GET /api/panel/stream?addon=<id>` → Server-Sent Events, one `data:` per `watch` line
  - `state()` entries gain `panel: boolean` (true when the add-on is on and declares a panel)

- [ ] **Step 1: Write the manifest, hooks and README**

`usage-by-device/addon.json`:

```json
{
  "id": "usage-by-device",
  "order": 55,
  "default": false,
  "title": "שימוש לפי מכשיר",
  "summary": "כמה כל מחשב על אותו מנוי קלוד ניצל: היום, 7 ימים, 30 ימים, החודש, 5 השעות והשבוע.",
  "detect": { "file": "~/.claude/usage-by-device/ubd.mjs" },
  "files": [
    { "from": "ubd.mjs", "to": "~/.claude/usage-by-device/ubd.mjs", "mode": "755" },
    { "from": "read-usage.mjs", "to": "~/.claude/usage-by-device/read-usage.mjs" },
    { "from": "ledger.mjs", "to": "~/.claude/usage-by-device/ledger.mjs" },
    { "from": "wire.mjs", "to": "~/.claude/usage-by-device/wire.mjs" },
    { "from": "view.mjs", "to": "~/.claude/usage-by-device/view.mjs" }
  ],
  "claudeSettings": [{ "file": "settings.json.snippet" }],
  "ownsCommands": "usage-by-device/ubd\\.mjs",
  "panel": { "script": "~/.claude/usage-by-device/ubd.mjs", "calls": ["rename", "retention"] },
  "group": "קלוד",
  "details": [
    "כל מחשב שמפעיל את התוסף נרשם בשם של המחשב, ואפשר לשנות לו שם מכאן.",
    "המחשבים על אותו מנוי מוצאים זה את זה לבד ומחליפים ביניהם רק מספרים, מוצפנים. תוכן השיחות לא יוצא מהמחשב.",
    "כל מחשב שומר עותק מלא אצלו; העדכון עובר כשהוא מחובר לאינטרנט, דרך תיבת דואר קטנה על השרת.",
    "השימוש משוקלל לפי המודל, כי אופוס שורף מהמכסה יותר מסונט.",
    "למה מכשיר לא מתעדכן: tail ~/.claude/cache/usage-by-device.log"
  ],
  "howToCheck": "הפעל בשני מחשבים על אותו מנוי, עבוד עם קלוד באחד, ופתח את הדף הזה בשני: השורה שלו מתעדכנת תוך דקה."
}
```

`usage-by-device/settings.json.snippet`:

```json
{
  "hooks": {
    "SessionStart": [
      { "hooks": [{ "type": "command", "command": "node $HOME/.claude/usage-by-device/ubd.mjs sync", "async": true }] }
    ],
    "Stop": [
      { "hooks": [{ "type": "command", "command": "node $HOME/.claude/usage-by-device/ubd.mjs sync", "async": true }] }
    ]
  }
}
```

`usage-by-device/README.md`:

```markdown
# שימוש לפי מכשיר

כמה כל מחשב על אותו מנוי קלוד ניצל, לפי שמות.

- כל מחשב קורא את יומני השיחות שלו (רק מספרי טוקנים ומודל), משקלל לפי מחיר המודל, ושומר לפי יום ולפי שעה.
- מחשבים על אותו מנוי מחליפים את הסיכומים דרך תיבת דואר על השרת, מוצפנים במפתח שנגזר מהמנוי.
- העדכון רץ בפתיחת סשן ובסוף כל תשובה של קלוד, לכל היותר פעם בדקה.
- 5 שעות ושבוע: הניצול הרשמי של המנוי, מחולק לפי החלק של כל מחשב באותו חלון.

קבצים: ~/.claude/usage-by-device/ (ledger.json = כל המכשירים, state.json = מה נקרא ומה נשלח, server = כתובת תיבת דואר אחרת).
```

- [ ] **Step 2: Write the failing engine test**

Append to `engine/test/engine.test.mjs`:

```js
test("panel routes: only declared calls run, arguments are checked", async () => {
  const { home, P } = sandbox();
  go(P, { ...all(false), enabled: { ...all(false).enabled, "usage-by-device": true } });
  const child = spawn(process.execPath, [path.join(repo, "engine/addons.mjs")], { env: { ...process.env, HOME: home, ADDONS_NO_OPEN: "1" } });
  const url = await new Promise((ok, bad) => {
    child.stdout.on("data", (d) => { const m = String(d).match(/http:\/\/127\.0\.0\.1:\d+\/\?t=\w+/); if (m) ok(m[0]); });
    child.on("exit", () => bad(new Error("server exited")));
  });
  const u = new URL(url), t = u.searchParams.get("t"), base = u.origin;
  const post = (b) => fetch(`${base}/api/panel/call?t=${t}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
  assert.equal((await post({ addon: "usage-by-device", cmd: "sync", args: [] })).status, 404);
  assert.equal((await post({ addon: "phone-alerts", cmd: "rename", args: [] })).status, 404);
  assert.equal((await post({ addon: "usage-by-device", cmd: "retention", args: [{}] })).status, 400);
  assert.equal((await post({ addon: "usage-by-device", cmd: "retention", args: ["500"] })).status, 400);
  const state = await (await fetch(`${base}/api/state?t=${t}`)).json();
  assert.equal(state.find((a) => a.id === "usage-by-device").panel, true);
  assert.equal(state.find((a) => a.id === "phone-alerts").panel, false);
  child.kill();
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `node --test engine/test/engine.test.mjs`
Expected: the new test FAILS (404 for everything / `panel` undefined); all older tests still PASS — including "everything on then off returns every file byte-identical", which now covers the new add-on's files and hooks.

- [ ] **Step 4: Implement the engine routes**

In `engine/addons.mjs`, change the import line to add `execFile`:

```js
import { execSync, execFile, spawn } from "node:child_process";
```

In `state()`, after `actions: …`, add:

```js
      panel: !!m.panel && st[m.id].on,
```

Before `return send(404, { error: "not found" });` add:

```js
      // an add-on's own live table (usage-by-device): its script prints JSON; only declared calls run
      if (url.pathname.startsWith("/api/panel")) {
        const b = req.method === "POST" ? await body(req) : {};
        const m = manifests.find((x) => x.id === (b.addon ?? url.searchParams.get("addon")));
        if (!m?.panel) return send(404, { error: "no such panel" });
        const script = m.panel.script.replace("~", P.home);
        const runScript = (args) => new Promise((ok) => execFile(process.execPath, [script, ...args], { timeout: 30000 }, (err, out, errOut) => ok({ err, out, errOut })));
        if (req.method === "GET" && url.pathname === "/api/panel") {
          const r = await runScript(["json"]);
          if (r.err) return send(400, { error: (r.errOut || r.err.message).trim() });
          return send(200, JSON.parse(r.out));
        }
        if (req.method === "POST" && url.pathname === "/api/panel/call") {
          if (!m.panel.calls.includes(b.cmd)) return send(404, { error: "no such call" });
          if (!Array.isArray(b.args) || b.args.length > 3 || b.args.some((a) => typeof a !== "string" || a.length > 60)) throw new Error("bad arguments");
          const r = await runScript([b.cmd, ...b.args]);
          if (r.err) return send(400, { error: (r.errOut || r.err.message).trim() });
          return send(200, { ok: true });
        }
        if (req.method === "GET" && url.pathname === "/api/panel/stream") {
          res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
          const child = spawn(process.execPath, [script, "watch"], { stdio: ["ignore", "pipe", "ignore"] });
          let buf = "";
          child.stdout.on("data", (c) => {
            buf += c;
            for (let i; (i = buf.indexOf("\n")) >= 0; buf = buf.slice(i + 1)) res.write(`data: ${buf.slice(0, i)}\n\n`);
            bump();
          });
          req.on("close", () => child.kill());
          return;
        }
        return send(404, { error: "not found" });
      }
```

- [ ] **Step 5: Run the engine tests**

Run: `node --test engine/test/engine.test.mjs`
Expected: PASS, all tests. Then `node --test usage-by-device/test/` still PASS.

- [ ] **Step 6: Commit**

```bash
git add usage-by-device/addon.json usage-by-device/settings.json.snippet usage-by-device/README.md engine/addons.mjs engine/test/engine.test.mjs
git commit -m "feat(usage-by-device): add-on manifest, sync hooks, engine panel routes"
```

---

### Task 7: The page — design, then build

**Files:**
- Create: `docs/superpowers/specs/2026-09-26-usage-by-device-mockup.html` (the chosen variant, kept for reference)
- Modify: `engine/page.html` (CSS block + `usagePanel()` + wiring in `card()` and `render()`)

**Interfaces:**
- Consumes: `/api/panel`, `/api/panel/call`, `/api/panel/stream`, `state[].panel` from Task 6; view shape from Task 5.

- [ ] **Step 1: Mockup with the owner**

Invoke the `design-in-browser` skill. Build 2–3 variants of the panel on the page's real tokens (light + dark, RTL, 780px column, phone width) with realistic data: 3 devices ("MacBook Pro של ידידיה" = this Mac, "המחשב של דנה", "Mac mini במשרד" updated 2 days ago), plan week 44 %, 5-hour 57 %. Variants to try: (a) compact table with share bars per period; (b) one card per device with a period switcher (היום / 7 ימים / 30 ימים / החודש) and big numbers; (c) stacked bar per period showing each device's slice. Owner picks; save the chosen file to the path above.

- [ ] **Step 2: Build the panel into the page**

In `engine/page.html` add, inside `<script>`, below `panel(a)`:

```js
// usage-by-device: live table fed by the add-on's own script
let usage = null, usageErr = "", usageStream = null;
const ago = (iso) => {
  const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
  return m < 2 ? "עכשיו" : m < 60 ? `לפני ${m} דק׳` : m < 48 * 60 ? `לפני ${Math.round(m / 60)} שע׳` : `לפני ${Math.round(m / 1440)} ימים`;
};
const pct = (x) => `${Math.round(x * 100)}%`;
function usagePanel(a) {
  if (!usageStream) {
    usageStream = new EventSource(`/api/panel/stream?${new URLSearchParams({ t: T, addon: a.id })}`);
    usageStream.onmessage = (e) => { usage = JSON.parse(e.data); usageErr = ""; paintUsage(a.id); };
    usageStream.onerror = () => { usageErr = "אין חיבור לתיבת הדואר — מוצג המידע האחרון שנשמר"; paintUsage(a.id); };
  }
  return `<div class="usage" id="usage-${a.id}">${usageBody(a.id)}</div>`;
}
function paintUsage(id) { const el = document.getElementById(`usage-${id}`); if (el) el.innerHTML = usageBody(id); }
function usageBody(id) {
  if (!usage) return `<div class="muted">טוען…</div>`;
  const P = [["today", "היום"], ["d7", "7 ימים"], ["d30", "30 ימים"], ["month", "החודש"]];
  const W = [["five", "5 שעות"], ["week", "שבוע"]].filter(([k]) => usage.plan[k]);
  return `${usageErr ? `<div class="drift">${esc(usageErr)}</div>` : ""}
    <table class="usage-t"><thead><tr><th>מכשיר</th>${P.map(([, l]) => `<th>${l}</th>`).join("")}${W.map(([k, l]) => `<th>${l}<small>${usage.plan[k].utilization}% סה״כ</small></th>`).join("")}<th>עודכן</th></tr></thead>
    <tbody>${usage.devices.map((d) => `<tr class="${d.me ? "me" : ""}">
      <td><input class="dev-name" data-dev="${id}:${d.id}" value="${esc(d.name)}" maxlength="40" aria-label="שם המכשיר">${d.me ? '<span class="tag">המחשב הזה</span>' : ""}</td>
      ${P.map(([k]) => `<td title="$${d.periods[k].w.toFixed(2)}"><span class="bar" style="--v:${d.periods[k].share}"></span>${pct(d.periods[k].share)}</td>`).join("")}
      ${W.map(([k]) => `<td>${d.windows[k].pct}%</td>`).join("")}
      <td class="muted">${ago(d.updatedAt)}</td></tr>`).join("")}</tbody></table>
    <label class="retention">שמור עדכונים בתיבת הדואר ל־<input type="number" min="12" max="168" step="1" data-retention="${id}" value="${usage.retentionHours}"> שעות</label>`;
}
```

In `card()`, right after `${settings}`, add:

```js
    ${a.panel && d.on ? usagePanel(a) : ""}
```

In the existing delegated event handling (the `change`/`keydown` listeners on `#list`), add:

```js
$("#list").addEventListener("change", async (e) => {
  const n = e.target.dataset.dev, r = e.target.dataset.retention;
  try {
    if (n) { const [addon, dev] = n.split(":"); await api("/api/panel/call", { addon, cmd: "rename", args: [dev, e.target.value] }); }
    if (r) await api("/api/panel/call", { addon: r, cmd: "retention", args: [String(e.target.value)] });
  } catch (err) { usageErr = err.message; paintUsage(n ? n.split(":")[0] : r); }
});
```

Add the CSS from the chosen mockup to the `<style>` block; at minimum:

```css
  .usage { border-top: 1px solid var(--line); padding: 12px 18px 16px; overflow-x: auto; }
  .usage-t { width: 100%; border-collapse: collapse; font-size: 14px; font-variant-numeric: tabular-nums; }
  .usage-t th { text-align: start; font-weight: 600; color: var(--faint); font-size: 12px; padding: 4px 6px; }
  .usage-t th small { display: block; font-weight: 400; }
  .usage-t td { padding: 6px; border-top: 1px solid var(--line); white-space: nowrap; }
  .usage-t tr.me td { background: var(--accent-soft); }
  .usage .bar { display: inline-block; width: 36px; height: 6px; border-radius: 3px; margin-inline-end: 6px; vertical-align: middle;
                background: linear-gradient(to left, var(--accent) calc(var(--v) * 100%), var(--line) 0); }
  .dev-name { border: 1px solid transparent; background: transparent; color: var(--ink); font: inherit; padding: 2px 4px; border-radius: 6px; width: 16ch; }
  .dev-name:hover, .dev-name:focus { border-color: var(--line); background: var(--bg); }
  .retention { display: block; margin-top: 10px; color: var(--muted); font-size: 13px; }
  .retention input { width: 5ch; font: inherit; }
  .muted { color: var(--muted); }
```

- [ ] **Step 3: Check it in the browser (headless, never stealing focus)**

With the add-on on in a sandbox HOME that has a ledger of 3 devices (copy the mockup data into `~/.claude/usage-by-device/ledger.json` of the sandbox): start `ADDONS_NO_OPEN=1 HOME=<sandbox> node engine/addons.mjs`, open the printed address in headless Chrome (`--headless=new`, Playwright `connect_over_cdp`), screenshot light + dark + 390px width. Rename a device → the input keeps the new name after the next stream update. Set retention 96 → the ledger's settings show 96.

- [ ] **Step 4: Run every test**

Run: `node --test engine/test/engine.test.mjs && node --test usage-by-device/test/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add engine/page.html docs/superpowers/specs/2026-09-26-usage-by-device-mockup.html
git commit -m "feat(usage-by-device): live per-device table on the add-ons page"
```

---

### Task 8: Ship and check on this Mac

**Files:** none new.

- [ ] **Step 1: Merge and push**

```bash
cd ~/Desktop/Everything/old/claude-addons
git fetch origin && git -C ../claude-addons-ubd merge origin/master
node --test engine/test/engine.test.mjs && node --test ../claude-addons-ubd/usage-by-device/test/
git merge --ff-only usage-by-device   # from the master checkout; if the tree is dirty, ask the owner first
git push origin master
```

- [ ] **Step 2: Turn it on here**

Run: `addons on usage-by-device`, then `node ~/.claude/usage-by-device/ubd.mjs sync --force` (the first run recounts the last 31 days — expect up to a minute), then `node ~/.claude/usage-by-device/ubd.mjs json`.
Expected: one device named after this Mac, today's share 100 %, week column present. `tail ~/.claude/cache/usage-by-device.log` shows no errors.

- [ ] **Step 3: Verify from the owner's side**

Owner: run `addons`, open "שימוש לפי מכשיר", see the Mac's row; rename it; on a second Mac on the same plan run `addons on usage-by-device`, use Claude there once, and watch its row appear on the first Mac within a minute.

- [ ] **Step 4: Memory**

Update `claude-addons-engine` memory: new manifest field `panel` (script + allowed calls, live SSE), and add a memory for the mailbox (host name, Coolify resource, 7-day cache, no auth by design).
