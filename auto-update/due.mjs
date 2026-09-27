// When should the background updater actually look for an update?
// Once a day at 11:00. Every calendar day that passes without a successful
// check adds one more try, spread evenly from 11:00 (2 a day, then 3, …),
// until it is every hour — so a Mac that is rarely on still gets there.
//   node due.mjs <lastOkMs|0> <lastTryMs|0>   → exit 0 = go, 1 = not now (reason on stdout)
import fs from "node:fs";
import { fileURLToPath } from "node:url";

export const FIRST_HOUR = 11;
const dayNum = (d) => Math.floor((d.getTime() - d.getTimezoneOffset() * 60e3) / 86400e3); // local calendar day

// the hours of the day to try on, when `n` days have gone by without a successful check
export const slots = (n) => [...new Set(Array.from({ length: n }, (_, k) => (FIRST_HOUR + Math.floor((k * 24) / n)) % 24))].sort((a, b) => a - b);

export function due(now, lastOk, lastTry) {
  const n = lastOk ? Math.min(24, dayNum(now) - dayNum(lastOk)) : 24;
  if (n <= 0) return { go: false, why: "already checked today" };
  const past = slots(n).filter((h) => h <= now.getHours());
  if (!past.length) return { go: false, why: `next try at ${slots(n)[0]}:00 (${n} a day)` };
  const at = new Date(now); at.setHours(past.at(-1), 0, 0, 0);
  if (lastTry && lastTry >= at) return { go: false, why: `already tried at ${past.at(-1)}:00 (${n} a day)` };
  return { go: true, why: `${n} a day, slot ${past.at(-1)}:00` };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  const [ok, tried] = process.argv.slice(2).map((x) => (+x ? new Date(+x) : null));
  const r = due(new Date(), ok, tried);
  console.log(r.why);
  process.exit(r.go ? 0 : 1);
}
