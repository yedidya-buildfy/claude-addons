// What the page shows: each device's share of the plan per period and per plan window.
import { dayKey, daysBefore } from "./read-usage.mjs";

const sumDays = (dev, keys) => keys.reduce((a, k) => a + (dev.days[k]?.w ?? 0), 0);
// the same amount split by model family (f = Fable, o = Opus, s = Sonnet, h = Haiku) — kept per day, so a window is split by the days it touches
const FAMS = ["f", "o", "s", "h"];
const sumModels = (dev, keys) => Object.fromEntries(FAMS.map((f) => [f, keys.reduce((a, k) => a + (dev.days[k]?.[f] ?? 0), 0)]));
const addModels = (list) => Object.fromEntries(FAMS.map((f) => [f, list.reduce((a, m) => a + m[f], 0)]));
// an hour bucket counts if any of it falls inside the window
const sumHours = (dev, fromMs) => Object.entries(dev.hours).reduce((a, [k, w]) => (Date.parse(`${k}:00:00Z`) + 3600e3 > fromMs ? a + w : a), 0);

export function view(ledger, myId, plan, now = new Date(), mailbox = null) {
  const today = dayKey(now, ledger.settings.timeZone);
  const last = (n) => Array.from({ length: n }, (_, i) => daysBefore(today, i));
  const month = today.slice(0, 7);
  const periods = { today: last(1), d7: last(7), d30: last(30), month: last(31).filter((k) => k.startsWith(month)) };

  const windows = {};
  for (const [name, field, span] of [["five", "five_hour", 5 * 3600e3], ["week", "seven_day", 7 * 86400e3]]) {
    const w = plan?.[field];
    if (typeof w?.utilization === "number" && w.resets_at && Date.parse(w.resets_at) > now.getTime()) {
      const from = Date.parse(w.resets_at) - span, first = dayKey(new Date(from), ledger.settings.timeZone);
      windows[name] = { utilization: w.utilization, resetsAt: w.resets_at, from, days: last(8).filter((k) => k >= first) };
    }
  }

  const devs = Object.entries(ledger.devices);
  const total = (f) => devs.reduce((a, [, d]) => a + f(d), 0);
  const pTotals = Object.fromEntries(Object.entries(periods).map(([p, keys]) => [p, total((d) => sumDays(d, keys))]));
  const wTotals = Object.fromEntries(Object.entries(windows).map(([n, w]) => [n, total((d) => sumHours(d, w.from))]));

  // one entry per day for the "every day" chart, oldest first; only devices that used something that day
  const daily = last(30).reverse().map((day) => {
    const by = {};
    for (const [id, d] of devs) if (d.days[day]?.w) by[id] = d.days[day].w;
    return { day, by, total: Object.values(by).reduce((a, b) => a + b, 0), models: addModels(devs.map(([, d]) => sumModels(d, [day]))) };
  });

  return {
    me: myId,
    mailbox,
    daily,
    retentionHours: ledger.settings.retentionHours,
    // the whole plan split by model, per tab
    models: Object.fromEntries([...Object.entries(periods), ...Object.entries(windows).map(([n, w]) => [n, w.days])]
      .map(([p, keys]) => [p, addModels(devs.map(([, d]) => sumModels(d, keys)))])),
    plan: Object.fromEntries(Object.entries(windows).map(([n, w]) => [n, { utilization: w.utilization, resetsAt: w.resetsAt }])),
    devices: devs.map(([id, d]) => ({
      id, name: d.name, me: id === myId, updatedAt: d.updatedAt,
      periods: Object.fromEntries(Object.entries(periods).map(([p, keys]) => {
        const w = sumDays(d, keys);
        return [p, { w, share: pTotals[p] ? w / pTotals[p] : 0, models: sumModels(d, keys) }];
      })),
      windows: Object.fromEntries(Object.entries(windows).map(([n, win]) => {
        const share = wTotals[n] ? sumHours(d, win.from) / wTotals[n] : 0;
        return [n, { share, pct: Math.round(win.utilization * share * 10) / 10, models: sumModels(d, win.days) }];
      })),
    })).sort((a, b) => b.periods.d7.w - a.periods.d7.w),
  };
}
