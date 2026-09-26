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
