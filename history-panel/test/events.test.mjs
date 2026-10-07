// history-panel/test/events.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { bashRows, foldPushRetries } from "../lib/events.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { rowsFromTool } from "../lib/events.mjs";
import { price } from "./fixture.mjs";

const ok = (out) => ({ isError: false, out, at: "2026-10-07T17:00:00Z" });
const bad = (out) => ({ isError: true, out, at: "2026-10-07T17:00:00Z" });
const kinds = (rows) => rows.map((r) => [r.kind, r.what, r.detail, !!r.fail]);

test("commit + push in one command: one row each, facts from git's own output", () => {
  const out = "[master d5faff1] feat(hebrew-rtl): right-align\n 7 files changed, 194 insertions(+)\nTo https://github.com/yedidya-buildfy/claude-addons.git\n   3a6306b..d5faff1  master -> master";
  const rows = bashRows('cd /x/claude-addons && git add . && git commit -m "feat" && git push origin master', ok(out), "/r");
  assert.deepEqual(kinds(rows), [["commit", "נשמר שינוי", "claude-addons · d5faff1", false], ["push", "נדחף ל‑master", "claude-addons · d5faff1", false]]);
  assert.deepEqual(rows[0].more.find(([k]) => k === "קבצים"), ["קבצים", "7 · +194 −0"]);
  assert.deepEqual(rows[1].more.find(([k]) => k === "שינויים"), ["שינויים", "3a6306b → d5faff1"]);
});

test("quiet commit falls back to git log --oneline output", () => {
  const rows = bashRows("git commit -q -m x && git log --oneline -1", ok("049c356 docs(history-panel): design"), "/r/claude-addons");
  assert.equal(rows[0].detail, "claude-addons · 049c356");
});

test("push rejected twice then quiet success folds into one success row with attempts", () => {
  const rej = "To https://github.com/a/b.git\n ! [remote rejected] master -> master (Internal Server Error)\nerror: failed to push some refs";
  const rows = foldPushRetries([...bashRows("git push origin master", bad(rej), "/r/b"), ...bashRows("git push origin master", bad(rej), "/r/b"), ...bashRows("git push -q origin master", ok(""), "/r/b")]);
  assert.deepEqual(kinds(rows), [["push", "נדחף ל‑master", "b", false]]);
  assert.deepEqual(rows[0].more.find(([k]) => k === "ניסיונות"), ["ניסיונות", "3 · 2 נדחו"]);
});

test("a retry loop inside one command that ends well is a success with attempts", () => {
  const rej = " ! [remote rejected] master -> master (Internal Server Error)\n";
  const rows = bashRows("for i in 1 2 3; do git push -q origin master && break; done", ok(rej + rej), "/r/b");
  assert.deepEqual(kinds(rows), [["push", "נדחף ל‑master", "b", false]]);
  assert.deepEqual(rows[0].more.find(([k]) => k === "ניסיונות"), ["ניסיונות", "3 · 2 נדחו"]);
});

test("failed push stays red", () => {
  const rows = bashRows("git push origin main", bad("error: failed to push some refs to 'x'"), "/r/b");
  assert.deepEqual(kinds(rows), [["push", "דחיפה נכשלה", "b · main", true]]);
});

test("merge, conflict, worktree", () => {
  assert.deepEqual(kinds(bashRows("git -C /r/app merge helmet-mics", ok("Updating 1..2\nFast-forward"), "/r/app")), [["merge", "אוחד", "helmet-mics → app", false]]);
  assert.deepEqual(kinds(bashRows("git merge feat", bad("CONFLICT (content): Merge conflict in a.js\nAutomatic merge failed"), "/r/app")), [["merge", "האיחוד נעצר בהתנגשות", "feat → app", true]]);
  assert.deepEqual(kinds(bashRows("git worktree add -b helmet ../e2k-helmet platform", ok("Preparing worktree"), "/r/app")), [["worktree", "נפתח עותק עבודה", "e2k-helmet · ענף helmet", false]]);
  assert.deepEqual(bashRows("git merge-base a b", ok("abc"), "/r"), []);
});

test("dev server with port from args or output; unknown port is said", () => {
  assert.equal(bashRows("PORT=3001 npm run dev", ok(""), "/r/app")[0].port, 3001);
  assert.equal(bashRows("npm run dev", ok("  ▲ Next.js\n  - Local: http://localhost:3002"), "/r/app")[0].detail, "localhost:3002");
  assert.equal(bashRows("npx vite --port 5174", ok(""), "/r/app")[0].port, 5174);
  assert.equal(bashRows("npm run dev", ok(""), "/r/app")[0].detail, "פורט לא ידוע");
  assert.deepEqual(bashRows("npm run devtools", ok(""), "/r/app"), []);
});

test("production deploys from the built-in list", () => {
  assert.deepEqual(kinds(bashRows('curl -s -X GET "http://1.2.3.4:8000/api/v1/deploy?uuid=abc123" -H "Authorization: Bearer x"', ok('{"deployments":[]}'), "/r")), [["prod", "עלה לפרודקשן", "Coolify · abc123", false]]);
  assert.deepEqual(kinds(bashRows("vercel deploy --prod", bad("Error: no token"), "/r/site")), [["prod", "העלייה לפרודקשן נכשלה", "Vercel · site", true]]);
  assert.equal(bashRows("npx convex deploy", ok("Deployed"), "/r/app")[0].kind, "prod");
});

test("add-ons update", () => {
  const rows = bashRows("~/.claude/scripts/claude-addons-update.sh --force", ok("updating claude-addons: 3a6306bddf -> d5faff1d05...\nclaude-addons successfully updated to d5faff1."), "/r");
  assert.deepEqual(kinds(rows), [["update", "עדכון תוספים הותקן", "3a6306b → d5faff1", false]]);
});

test("text that only quotes git commands is not a row", () => {
  assert.deepEqual(bashRows("grep -n 'git push' notes.md", ok("12: run git push origin main"), "/r"), []);
  assert.deepEqual(bashRows("echo 'git commit -m x'", ok("git commit -m x"), "/r"), []);
});

test("each answered question is its own row with question, options and the choice", () => {
  const call = { name: "AskUserQuestion", cwd: "/r", input: { questions: [
    { question: "איך להציג עלות?", options: [{ label: "דולרים לפי מחירון (מומלץ)" }, { label: "אחוז מהמנוי" }] },
    { question: "אילו שיחות?", options: [{ label: "רק פתוחים" }] } ] } };
  const result = { answers: { "איך להציג עלות?": "דולרים לפי מחירון (מומלץ)", "אילו שיחות?": "בכל שיחה ההיסטוריה שלה" } };
  const rows = rowsFromTool(call, { isError: false, out: "", result, at: "t" }, { price });
  assert.deepEqual(rows.map((r) => r.what), ["ענית: איך להציג עלות?", "ענית: אילו שיחות?"]);
  assert.deepEqual(rows[0].more, [["השאלה", "איך להציג עלות?"], ["האפשרויות", "דולרים לפי מחירון (מומלץ) · אחוז מהמנוי"], ["בחרת", "דולרים לפי מחירון (מומלץ)"]]);
  assert.deepEqual(rows[1].more.at(-1), ["כתבת", "בכל שיחה ההיסטוריה שלה"]);
});

test("a declined question is a stop-like row, not an answer", () => {
  const call = { name: "AskUserQuestion", cwd: "/r", input: { questions: [{ question: "Q?", options: [] }] } };
  const rows = rowsFromTool(call, { isError: true, out: "The user doesn't want to proceed", result: null, at: "t" }, { price });
  assert.equal(rows[0].fail, true);
});

test("subagent row reads its own record for cost, time and tool count", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hp-"));
  fs.writeFileSync(path.join(dir, "agent-abc.jsonl"), [
    { type: "assistant", timestamp: "2026-10-07T14:27:00Z", message: { id: "x1", model: "claude-sonnet-5", usage: { input_tokens: 100_000, output_tokens: 80_000 }, content: [{ type: "tool_use", name: "Grep" }] } },
    { type: "assistant", timestamp: "2026-10-07T14:29:10Z", message: { id: "x2", model: "claude-sonnet-5", usage: { input_tokens: 0, output_tokens: 0 }, content: [{ type: "tool_use", name: "Read" }, { type: "text", text: "done" }] } },
  ].map(JSON.stringify).join("\n"));
  const call = { name: "Agent", cwd: "/r", input: { subagent_type: "Explore", description: "map mic positions", model: "sonnet" } };
  const [r] = rowsFromTool(call, { isError: false, out: "", result: { agentId: "abc", resolvedModel: "claude-sonnet-5" }, at: "t" }, { price, subagentDir: dir });
  assert.equal(r.what, "סוכן משנה: Explore");
  assert.equal(r.cost, 0.18);
  assert.equal(r.detail, "2 דק׳ · $0.18");
  assert.deepEqual(r.more.find(([k]) => k === "כלים"), ["כלים", "2 קריאות"]);
  assert.equal(r.aiKey, "agent:abc");
});

test("a commit is not failed by a later step of the same command", () => {
  const out = "Exit code 1\n## master...origin/master [ahead 1]\nremote: Internal Server Error\n ! [remote rejected] master -> master";
  const rows = bashRows("git commit -q -m x && git fetch -q && git push -q origin master", bad(out), "/r/app");
  assert.deepEqual(kinds(rows)[0], ["commit", "נשמר שינוי", "app", false]);
  assert.deepEqual(kinds(bashRows("git commit -m x", bad("nothing to commit, working tree clean"), "/r/app")), [["commit", "השמירה נכשלה", "app", true]]);
});

test("repo name follows cd through a shell variable, and a push names its remote", () => {
  assert.equal(bashRows('R=/x/claude-addons; cd $R && git commit -m "a" && git log --oneline -1', ok("abc1234 a"), "/r")[0].detail, "claude-addons · abc1234");
  assert.equal(bashRows("git push origin master", ok("To https://github.com/a/claude-addons.git\n   1111111..2222222  master -> master"), "/r/repo")[0].detail, "claude-addons · 2222222");
});

test("commands inside a heredoc or a quoted string are not run commands", () => {
  const heredoc = "cat >> notes.md <<'EOF'\nrun: cd x && git push origin master\nEOF\n";
  assert.deepEqual(bashRows(heredoc, ok(""), "/r"), []);
  assert.deepEqual(kinds(bashRows('git commit -m "then && git push origin main"', ok("[main abc1234] then"), "/r/app")).map((k) => k[0]), ["commit"]);
});

test("a push error after a successful commit does not fail the commit", () => {
  const rows = bashRows("git commit -q -m x && git push -q origin master", bad("error: failed to push some refs to 'x'\nfatal: unable to access"), "/r/app");
  assert.deepEqual(kinds(rows).map((k) => [k[0], k[3]]), [["commit", false], ["push", true]]);
});
