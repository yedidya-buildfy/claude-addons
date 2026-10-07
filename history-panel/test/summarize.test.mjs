// history-panel/test/summarize.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { summarizeBatch, parseAnswer } from "../lib/summarize.mjs";

test("batch asks once and maps answers by uuid; titles fit in 28 chars", async () => {
  let calls = 0;
  const ask = async (messages) => {
    calls++;
    assert.match(messages[1].content, /#1[\s\S]*תדחוף/);
    return JSON.stringify([{ n: 1, title: "דחיפה למאגר התוספים וגם עוד הרבה מילים", asked: "לדחוף.", happened: "נדחף." }]);
  };
  const out = await summarizeBatch([{ uuid: "u1", prompt: "תדחוף", reply: ["נדחף."], rows: [{ what: "נדחף ל‑master", detail: "b" }] }], ask);
  assert.equal(calls, 1);
  assert.ok([...out.u1.title].length <= 28 && "דחיפה למאגר התוספים וגם עוד הרבה מילים".startsWith(out.u1.title + " "));
  assert.equal(out.u1.happened, "נדחף.");
});

test("answer parser accepts fenced JSON and rejects junk", () => {
  assert.deepEqual(parseAnswer('```json\n[{"n":1,"title":"a","asked":"b","happened":"c"}]\n```'), [{ n: 1, title: "a", asked: "b", happened: "c" }]);
  assert.equal(parseAnswer("sorry"), null);
});

test("a long title is cut at a word, not inside one", async () => {
  const ask = async () => JSON.stringify([{ n: 1, title: "תכנון היסטוריית שיחות ועלויות לכל הודעה", asked: "a", happened: "b" }]);
  const out = await summarizeBatch([{ uuid: "u1", prompt: "x", reply: [], rows: [] }], ask);
  assert.equal(out.u1.title, "תכנון היסטוריית שיחות");
});

test("the claude -p fallback runs with hooks off and without the parent's session variables", async () => {
  const { fallbackArgs } = await import("../lib/summarize.mjs");
  const { args, env } = fallbackArgs("prompt", { CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "cli", PATH: "/bin" });
  assert.ok(args.includes("--settings") && JSON.parse(args[args.indexOf("--settings") + 1]).disableAllHooks === true);
  assert.equal(env.CLAUDECODE, undefined);
  assert.equal(env.CLAUDE_CODE_ENTRYPOINT, undefined);
  assert.equal(env.PATH, "/bin");
  assert.equal(env.HISTORY_PANEL_CHILD, "1");
});

test("two summarizers on one session: the second does not run, and saves merge", async () => {
  const fs = await import("node:fs"), os = await import("node:os"), path = await import("node:path");
  const { run } = await import("../lib/summarize.mjs");
  const CACHE = fs.mkdtempSync(path.join(os.tmpdir(), "hp-lock-"));
  const entry = (uuid) => ({ uuid, prompt: uuid, reply: [], rows: [], running: false });
  const readCache = () => { try { return JSON.parse(fs.readFileSync(path.join(CACHE, "s.json"), "utf8")); } catch { return { entries: {}, ai: {}, failed: {} }; } };
  let release;
  const gate = new Promise((r) => (release = r));
  const slow = async (m) => { await gate; return JSON.stringify([{ n: 1, title: "a", asked: "a", happened: "a" }]); };
  const first = run("s", { load: () => ({ entries: [entry("u1")] }), readCache, CACHE, ask: slow });
  await new Promise((r) => setTimeout(r, 20));
  let secondAsked = false;
  await run("s", { load: () => ({ entries: [entry("u1")] }), readCache, CACHE, ask: async () => { secondAsked = true; return "[]"; } });
  assert.equal(secondAsked, false);
  // something else saved meanwhile: the first run must keep it
  fs.writeFileSync(path.join(CACHE, "s.json"), JSON.stringify({ entries: { other: { title: "o", asked: "o", happened: "o" } }, ai: {}, failed: {} }));
  release();
  await first;
  assert.deepEqual(Object.keys(readCache().entries).sort(), ["other", "u1"]);
  assert.equal(fs.existsSync(path.join(CACHE, "s.lock")), false);
});

test("the subagent line is asked from its final words", async () => {
  const { run } = await import("../lib/summarize.mjs");
  const fs = await import("node:fs"), os = await import("node:os"), path = await import("node:path");
  const CACHE = fs.mkdtempSync(path.join(os.tmpdir(), "hp-ai-"));
  const seen = [];
  const ask = async (m) => { seen.push(m[1].content); return m[0].content.includes("JSON array") ? "[]" : "מצא שני מקומות."; };
  const row = { aiKey: "agent:z", more: [["סוג", "Explore"]], result: "Found two conflicting places." };
  await run("s", { load: () => ({ entries: [{ uuid: "u", prompt: "p", reply: [], rows: [row], running: false }] }), readCache: () => ({ entries: {}, ai: {}, failed: {} }), CACHE, ask });
  assert.ok(seen.some((c) => c.includes("Found two conflicting places.")));
});
