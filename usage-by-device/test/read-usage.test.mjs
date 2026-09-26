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
