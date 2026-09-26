// The ledger: every machine's usage on this plan, as this machine last heard it.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { dayKey, daysBefore, hourKey } from "./read-usage.mjs";

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
  // an entry too big for one message travels without its hours — keep the ones already known
  const hours = Object.keys(usage.hours).length || usage === a ? usage.hours : a.hours;
  return { name: naming.name, nameSetAt: naming.nameSetAt, updatedAt: usage.updatedAt, days: usage.days, hours };
}

// Retention: newest change wins. Time zone: the first one set wins, so the plan's clock never flips back and forth.
export function mergeSettings(a, b) {
  const r = b.setAt > a.setAt ? b : a;
  const z = !a.timeZone ? b : !b.timeZone ? a : b.tzSetAt < a.tzSetAt ? b : a;
  const out = { retentionHours: r.retentionHours, setAt: r.setAt };
  if (z.timeZone) Object.assign(out, { timeZone: z.timeZone, tzSetAt: z.tzSetAt });
  return out;
}

export const validTimeZone = (tz) => { try { new Intl.DateTimeFormat("en", { timeZone: tz }); return typeof tz === "string"; } catch { return false; } };

const r3 = (x) => Math.round(x * 1000) / 1000;

export function prune(dev, now = new Date(), tz) {
  const oldestDay = daysBefore(dayKey(now, tz), DAYS_KEPT - 1);
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
