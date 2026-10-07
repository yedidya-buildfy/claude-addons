// history-panel/test/cli.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { human, reply, result, turnEnd } from "./fixture.mjs";

const CLI = new URL("../history.mjs", import.meta.url).pathname;
const STATUSLINE = new URL("../../statusline-gsd/gsd-statusline.js", import.meta.url).pathname;

function sandbox(lines, { name = "תוסף עברית", cache = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hp-cli-"));
  const proj = path.join(root, "projects", "-r-app");
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(path.join(proj, "s1.jsonl"), lines.map(JSON.stringify).join("\n") + "\n{broken");
  fs.mkdirSync(path.join(root, "state"));
  fs.writeFileSync(path.join(root, "state", "s1.name"), name);
  fs.mkdirSync(path.join(root, "cache"));
  if (cache) fs.writeFileSync(path.join(root, "cache", "s1.json"), JSON.stringify(cache));
  const env = { ...process.env, HISTORY_PROJECTS: path.join(root, "projects"), HISTORY_STATE: path.join(root, "state"), HISTORY_CACHE: path.join(root, "cache"), HISTORY_STATUSLINE: STATUSLINE, HISTORY_NO_SPAWN: "1" };
  return (...args) => execFileSync("node", [CLI, ...args], { env, encoding: "utf8" });
}

test("build prints the view's JSON with status-line prices, slices and rows", () => {
  const run = sandbox([
    human("תדחוף", 0),
    reply(1, { id: "A", stop: "tool_use", usage: { input_tokens: 0, output_tokens: 1000, cache_read_input_tokens: 100_000, cache_creation_input_tokens: 0 }, tools: [["t1", "Bash", { command: "git push origin master" }]] }),
    result(2, "t1", "To https://github.com/a/b.git\n   1111111..2222222  master -> master"),
    reply(3, { id: "B", text: "נדחף." }), turnEnd(4),
  ], { cache: { entries: {}, ai: {}, failed: {} } });
  const out = JSON.parse(run("build", "s1"));
  assert.equal(out.name, "תוסף עברית");
  assert.equal(out.bad, 1);
  assert.equal(out.turns.length, 1);
  const t = out.turns[0];
  assert.equal(t.n, 1);
  assert.equal(t.summarized, false);
  assert.equal(t.title, "תדחוף");                     // unsummarized: the prompt's head stands in
  assert.equal(t.did, "לא סוכם עדיין");
  assert.deepEqual(t.events.map((e) => [e[0], e[2]]), [["push", "נדחף ל‑master"]]);
  assert.ok(t.cost > 0.02 && t.cost < 0.05);          // opus-5-5: 1000×$20/M + 100k×$0.2/M (+ B) — the status line's own table
});

test("cached summaries replace the stand-ins", () => {
  const lines = [human("x", 0), reply(1), turnEnd(2)];
  const run = sandbox(lines, { cache: { entries: { [lines[0].uuid]: { title: "כותרת", asked: "ביקשת", happened: "קרה" } }, ai: {}, failed: {} } });
  const t = JSON.parse(run("build", "s1")).turns[0];
  assert.deepEqual([t.title, t.ask, t.did, t.summarized], ["כותרת", "ביקשת", "קרה", true]);
});

test("unknown session is a calm JSON error, exit 0", () => {
  const run = sandbox([human("x", 0)]);
  assert.deepEqual(JSON.parse(run("build", "nope")), { error: "לא נמצאה רשומה לשיחה הזו" });
});

test("entry prints the full prompt and reply as Markdown", () => {
  const run = sandbox([human("השאלה המלאה", 0), reply(1, { text: "התשובה המלאה" }), turnEnd(2)]);
  const md = run("entry", "s1", "1");
  assert.match(md, /השאלה המלאה/);
  assert.match(md, /התשובה המלאה/);
});
