import { test } from "node:test";
import assert from "node:assert/strict";
import { due, slots } from "./due.mjs";

const at = (d, h, m = 0) => new Date(2026, 8, d, h, m); // local time, September 2026

test("one a day at 11, then one more each missed day, up to every hour", () => {
  assert.deepEqual(slots(1), [11]);
  assert.deepEqual(slots(2), [11, 23]);
  assert.deepEqual(slots(3), [3, 11, 19]);
  assert.equal(slots(24).length, 24);
});

test("checked yesterday: waits for 11, goes once, then not again today", () => {
  const ok = at(26, 11, 5);
  assert.equal(due(at(27, 10, 59), ok, ok).go, false);
  assert.equal(due(at(27, 11), ok, ok).go, true);
  assert.equal(due(at(27, 16), ok, ok).go, true);              // was off at 11 — catches up
  assert.equal(due(at(27, 16), ok, at(27, 11, 2)).go, false);  // tried at 11 and failed: wait for the next slot
  assert.equal(due(at(27, 16), at(27, 11, 2), at(27, 11, 2)).go, false); // succeeded today
});

test("missed days add tries: two days without success → 11 and 23", () => {
  const ok = at(25, 11), tried = at(27, 11, 1);
  assert.equal(due(at(27, 22), ok, tried).go, false);
  assert.equal(due(at(27, 23), ok, tried).go, true);
});

test("a Mac only on in the early morning gets there once the tries reach its hours", () => {
  const ok = at(1, 11);
  assert.equal(due(at(3, 8), ok, null).go, false);  // 2 a day: 11, 23
  assert.equal(due(at(9, 8), ok, null).go, true);   // 8 a day: … 5, 8, 11 …
});

test("never checked → every hour", () => {
  assert.equal(due(at(27, 4), null, at(27, 3, 30)).go, true);
  assert.equal(due(at(27, 4, 30), null, at(27, 4, 1)).go, false);
});
