// history-panel/test/events.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { bashRows, foldPushRetries } from "../lib/events.mjs";

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
