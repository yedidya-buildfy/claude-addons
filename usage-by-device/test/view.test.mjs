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

test("daily: the last 30 local days, oldest first, each device's amount per day", () => {
  const v = view(L, "aaaaaaaaaaaaaaaa", plan, now);
  assert.equal(v.daily.length, 30);
  assert.equal(v.daily.at(-1).day, "2026-09-26");
  assert.equal(v.daily[0].day, "2026-08-28");
  assert.deepEqual(v.daily.at(-1).by, { aaaaaaaaaaaaaaaa: 30, bbbbbbbbbbbbbbbb: 10 });
  assert.equal(v.daily.at(-1).total, 40);
  assert.equal(v.daily[0].total, 100);
  assert.deepEqual(v.daily[1].by, {});
});
