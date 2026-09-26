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

test("an entry that arrives without hours (too big for one message) keeps the hours already known", () => {
  const mine = dev({ updatedAt: T("25T10:00:00.000"), hours: { "2026-09-25T10": 3 } });
  const slim = dev({ updatedAt: T("26T10:00:00.000"), days: { "2026-09-26": { w: 5, f: 0, o: 5, s: 0, h: 0 } }, hours: {} });
  const m = mergeDevice(mine, slim);
  assert.equal(m.days["2026-09-26"].w, 5);
  assert.deepEqual(m.hours, { "2026-09-25T10": 3 });
});

test("the plan's shared time zone: the first one set wins", () => {
  const a = { retentionHours: 72, setAt: T("01T00:00:00.000"), timeZone: "Asia/Jerusalem", tzSetAt: T("01T00:00:00.000") };
  const b = { retentionHours: 96, setAt: T("26T00:00:00.000"), timeZone: "Asia/Bangkok", tzSetAt: T("26T00:00:00.000") };
  const m = mergeSettings(b, a);
  assert.equal(m.timeZone, "Asia/Jerusalem");
  assert.equal(m.retentionHours, 96);
  assert.equal(mergeSettings({ retentionHours: 72, setAt: T("01T00:00:00.000") }, b).timeZone, "Asia/Bangkok");
});
