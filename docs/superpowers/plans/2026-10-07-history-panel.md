# history-panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `history-panel` add-on: a VS Code panel view that shows, for the focused terminal's Claude session, one entry per human prompt (title, asked, happened, cost, context slice) plus fixed-text technical rows.

**Architecture:** One pure Node CLI (`history.mjs build|summarize|entry`) reads the session record and owns every rule; a cheap-model summarizer fills a per-session cache; a thin VS Code extension maps the focused terminal to its session, runs the CLI and renders the approved mockup in a webview. Prices come from the status line itself (`gsd-statusline.js` already exports `usageCost`), so the two never disagree.

**Tech Stack:** Node ≥18 ESM (`node:test`, no dependencies), VS Code extension API (^1.80, plain JS, no build step), the add-ons engine manifest (`addon.json`).

**Spec:** `docs/superpowers/specs/2026-10-07-history-panel-design.md` · look: `docs/superpowers/specs/2026-10-07-history-panel-designs.html`

## Global Constraints

- Repo: `claude-addons`; one folder `history-panel/` with one `addon.json`; no per-add-on logic in the engine or installers.
- No npm dependencies; Node built-ins only. Tests: `node --test history-panel/test/`.
- Title ≤ 28 characters; "asked" and "happened" one or two sentences each, in the owner's language.
- Cost = the status line's `usageCost` (`~/.claude/gsd-statusline.js`), summed per entry incl. subagents.
- Context slice: start = previous entry's end (0 for the first), end = last main-chain call's input+cache-read+cache-creation tokens.
- Technical rows come only from structured record fields, never from searching free text of the whole record.
- Compact mode below 340 px (CSS container query); full mode above.
- Summaries: cheapest model first via the gateway `tab-autoname.py` uses; `claude -p --model haiku` last; failure shows the prompt's first 120 chars + "לא סוכם", retried after 2 minutes.
- Terminal scrollback 50,000 lines (VS Code settings snippet).
- Requires add-ons `tab-status` (terminal→session) and `statusline-gsd` (prices).
- UI text Hebrew; numbers LTR monospace.

## Review Focus

1. A session started before the add-on (no cache, maybe compacted) — expect full history on first focus, summaries arriving within a minute, no crash on a `compact_boundary` (slice shows the drop, not a negative bar).
2. A Bash call that both commits and pushes, or retries a push — expect one commit row and one push row with "attempts", not a red row when the last attempt succeeded.
3. Tool output that quotes "git push" / "Request interrupted" inside text (like this brainstorm's own greps) — expect no phantom rows.
4. A terminal with no Claude, a session that ended, or a record that is not found — expect a calm message, never an error stack.
5. A huge record (5,000+ lines) — expect `build` under 2 s; the view keeps the last result while a build runs.

---

## File map

```
history-panel/
├── addon.json                      engine manifest (Task 7)
├── settings.json.snippet           Stop hook → summarize --hook (Task 7)
├── vscode-settings.snippet         scrollback 50000 (Task 7)
├── history.mjs                     CLI: build | summarize | entry (Task 4)
├── lib/
│   ├── record.mjs                  record → entries (Task 1)
│   ├── events.mjs                  technical rows (Tasks 2, 3)
│   └── summarize.mjs               cheap-model summaries + cache (Task 5)
├── test/
│   ├── fixture.mjs                 synthetic record builder
│   ├── record.test.mjs
│   ├── events.test.mjs
│   ├── summarize.test.mjs
│   └── cli.test.mjs
└── vscode-extension/
    ├── package.json                panel view container + webview view (Task 6)
    ├── extension.js                terminal→session, run CLI, clicks (Task 6)
    └── view.html                   approved mockup, fed by build JSON (Task 6)
statusline-gsd/gsd-statusline.js    + context_window_size in the ctx bridge file (Task 4)
README.md                           + one row (Task 7)
```

---

### Task 1: Record parser — entries, cost, context slices

**Files:**
- Create: `history-panel/lib/record.mjs`, `history-panel/test/fixture.mjs`, `history-panel/test/record.test.mjs`
- Create (stub, filled in Tasks 2–3): `history-panel/lib/events.mjs`

**Interfaces:**
- Produces: `readLines(file) → { lines: object[], bad: number }`; `promptText(d) → string|null`; `parseSession(lines, { price, subagentDir }) → { entries: Entry[], first: iso, last: iso, model: string|null }` where `Entry = { uuid, at, prompt, reply: string[], cost, tokens: { read, fresh, written }, ctx: [start, end], rows: Row[], running: boolean }` and `Row = { kind, at, what, detail, more: [string,string][], fail?: true, cost?: number, ai?: string, aiKey?: string, port?: number }`. `price(model, usage) → dollars`.
- Consumes (from events.mjs): `rowsFromTool(call, res, ctx) → Row[]`, `rowFromNote(att, at, lastCall) → Row`, `rowFromStop(at, lastCall, nextPrompt) → Row`, `rowFromSlash(name, args, out, at) → Row`, `rowFromCompact(d) → Row`, `foldPushRetries(rows) → Row[]`.

- [ ] **Step 1: Write the fixture builder**

```js
// history-panel/test/fixture.mjs
// Builds small session records line by line, shaped like Claude Code's JSONL.
let n = 0;
const ts = (min) => new Date(Date.UTC(2026, 9, 7, 16, min)).toISOString();
export const human = (text, min) => ({ type: "user", uuid: `u${++n}`, timestamp: ts(min), cwd: "/r/app", message: { role: "user", content: text } });
export const reply = (min, { id = `m${++n}`, text = "", tools = [], usage = { input_tokens: 10, output_tokens: 100, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0 }, model = "claude-opus-5-5", stop = "end_turn", sidechain = false } = {}) => ({
  type: "assistant", uuid: `a${++n}`, timestamp: ts(min), cwd: "/r/app", isSidechain: sidechain,
  message: { id, model, stop_reason: stop, usage, content: [...(text ? [{ type: "text", text }] : []), ...tools.map(([tid, name, input]) => ({ type: "tool_use", id: tid, name, input }))] },
});
export const result = (min, tid, out, { isError = false, toolUseResult = { stdout: out, stderr: "" } } = {}) => ({
  type: "user", uuid: `r${++n}`, timestamp: ts(min), cwd: "/r/app", toolUseResult,
  message: { role: "user", content: [{ type: "tool_result", tool_use_id: tid, is_error: isError, content: out }] },
});
export const interrupt = (min) => ({ type: "user", uuid: `i${++n}`, timestamp: ts(min), message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user for tool use]" }] } });
export const note = (text, min, origin = { kind: "human" }) => ({ type: "attachment", uuid: `q${++n}`, timestamp: ts(min), attachment: { type: "queued_command", prompt: text, commandMode: origin ? "prompt" : "task-notification", ...(origin ? { origin } : {}) } });
export const slash = (name, args, min) => ({ type: "user", uuid: `s${++n}`, timestamp: ts(min), message: { role: "user", content: `<command-name>${name}</command-name>\n<command-message>${name.slice(1)}</command-message>\n<command-args>${args}</command-args>` } });
export const stdout = (out, min) => ({ type: "user", uuid: `o${++n}`, timestamp: ts(min), message: { role: "user", content: `<local-command-stdout>${out}</local-command-stdout>` } });
export const turnEnd = (min) => ({ type: "system", subtype: "turn_duration", timestamp: ts(min) });
export const compact = (min, pre, post) => ({ type: "system", subtype: "compact_boundary", timestamp: ts(min), compactMetadata: { preTokens: pre, postTokens: post } });
export const price = (model, u) => ((u.input_tokens || 0) + (u.output_tokens || 0)) / 1e6; // $1 per M, for readable expectations
```

- [ ] **Step 2: Write the failing tests**

```js
// history-panel/test/record.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSession, promptText } from "../lib/record.mjs";
import { human, reply, result, interrupt, note, slash, stdout, turnEnd, compact, price } from "./fixture.mjs";

const u = (fresh, read, out = 0) => ({ input_tokens: fresh, cache_read_input_tokens: read, cache_creation_input_tokens: 0, output_tokens: out });

test("one entry per human prompt; tool results, meta, wrappers and interrupts are not prompts", () => {
  assert.equal(promptText(human("[Image #1] שלום", 0)), "שלום");
  assert.equal(promptText(interrupt(1)), null);
  assert.equal(promptText({ ...human("x", 0), isMeta: true }), null);
  assert.equal(promptText(human("<local-command-caveat>x</local-command-caveat>", 0)), null);
  assert.equal(promptText(result(1, "t1", "ok")), null);
  assert.equal(promptText(slash("/feedback", "", 2)), null);
  assert.equal(promptText(slash("/design-in-browser", "history panel", 2)), "/design-in-browser history panel");
});

test("cost per entry sums unique assistant messages; context slices chain end to start", () => {
  const lines = [
    human("first", 0), reply(1, { id: "A", usage: u(10, 50_000, 990) }), reply(1, { id: "A", usage: u(10, 50_000, 990) }), turnEnd(2),
    human("second", 3), reply(4, { id: "B", usage: u(0, 80_000, 1000) }), reply(5, { id: "C", usage: u(0, 90_000, 0) }), turnEnd(6),
  ];
  const { entries } = parseSession(lines, { price });
  assert.equal(entries.length, 2);
  assert.equal(entries[0].cost, 1000 / 1e6);                // message A once, not twice
  assert.deepEqual(entries[0].ctx, [0, 50_010]);
  assert.deepEqual(entries[1].ctx, [50_010, 90_000]);       // starts where the first ended
  assert.equal(entries[1].cost, 1000 / 1e6);
  assert.deepEqual(entries[1].tokens, { read: 170_000, fresh: 0, written: 1000 });
  assert.equal(entries[1].running, false);
});

test("last entry without a turn end is running; reply text is kept", () => {
  const { entries } = parseSession([human("go", 0), reply(1, { text: "working on it", stop: "tool_use" })], { price });
  assert.equal(entries[0].running, true);
  assert.deepEqual(entries[0].reply, ["working on it"]);
});

test("sidechain usage does not move the main context", () => {
  const { entries } = parseSession([human("go", 0), reply(1, { usage: u(0, 40_000) }), reply(2, { usage: u(0, 900_000), sidechain: true }), turnEnd(3)], { price });
  assert.equal(entries[0].ctx[1], 40_000);
});

test("interrupt, human mid-turn note, task notification, local slash command", () => {
  const lines = [
    human("go", 0), reply(1, { stop: "tool_use", tools: [["t1", "Bash", { command: "sleep 99", description: "wait" }]] }),
    note("שעברית תתחיל בצד ימין", 2), note("The person enabled mod hot-reloading", 2, null), interrupt(3),
    human("and in the terminal", 4), slash("/feedback", "", 5), stdout("Feedback window opened", 5), reply(6), turnEnd(7),
  ];
  const { entries } = parseSession(lines, { price });
  assert.equal(entries.length, 2);
  assert.deepEqual(entries[0].rows.map((r) => r.kind), ["note", "stop"]);
  assert.equal(entries[0].rows[1].more.find(([k]) => k === "מה כתבת אחרי")[1], "and in the terminal");
  assert.deepEqual(entries[1].rows.map((r) => [r.kind, r.detail]), [["slash", "/feedback"]]);
});

test("compaction adds a row and the next slice starts from the compacted size", () => {
  const lines = [human("a", 0), reply(1, { usage: u(0, 800_000) }), turnEnd(2), compact(3, 800_000, 20_000), human("b", 4), reply(5, { usage: u(0, 30_000) }), turnEnd(6)];
  const { entries } = parseSession(lines, { price });
  assert.deepEqual(entries[1].ctx, [20_000, 30_000]);
  assert.equal(entries[0].rows.at(-1).kind, "compact");
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `node --test history-panel/test/record.test.mjs`
Expected: FAIL with `Cannot find module '…/lib/record.mjs'`

- [ ] **Step 4: Write events.mjs stub so record.mjs can import it**

```js
// history-panel/lib/events.mjs
// Technical rows: facts read from what Claude ran and what came back. Never a model.
export const first = (s) => String(s || "").split("\n").map((l) => l.trim()).find(Boolean) || "";
export const clip = (s, n = 60) => { s = String(s || ""); return s.length > n ? s.slice(0, n - 1) + "…" : s; };
export const toolLabel = (call) => call ? `${call.name}: ${clip(first(call.input.description || call.input.command || call.input.file_path || call.input.url || call.input.query || call.input.prompt), 50)}` : "—";

export function rowFromNote(att, at, lastCall) {
  const p = att.prompt;
  const text = (typeof p === "string" ? p : (p || []).filter((x) => x.type === "text").map((x) => x.text).join("\n")).replace(/\[Image #\d+\]\s*/g, "").trim();
  const more = [["כתבת", text]];
  if (att.imagePasteIds) more.push(["צירפת", "צילום מסך"]);
  more.push(["מה רץ באותו רגע", toolLabel(lastCall)]);
  return { kind: "note", at, what: "הוספת הכוונה באמצע", detail: `״${clip(text, 40)}״`, more };
}
export function rowFromStop(at, lastCall, nextPrompt) {
  return { kind: "stop", at, what: "עצרת את העבודה", detail: "Esc", more: [["מה נעצר", toolLabel(lastCall)], ["מה כתבת אחרי", nextPrompt || "—"]] };
}
export function rowFromSlash(name, args, out, at) {
  if (name === "/btw") return { kind: "btw", at, what: "שאלה צדדית (/btw)", detail: `״${clip(args, 40)}״`, more: [["שאלת", args], ["התשובה", out || "—"]] };
  return { kind: "slash", at, what: "פקודה", detail: name, more: [["פקודה", `${name}${args ? " " + args : ""}`], ["תוצאה", first(out) || "—"]] };
}
export function rowFromCompact(d) {
  const m = d.compactMetadata || {};
  const k = (n) => `${Math.round((n || 0) / 1000)}K`;
  return { kind: "compact", at: d.timestamp, what: "הקונטקסט נדחס", detail: `${k(m.preTokens)} → ${k(m.postTokens)}`, more: [["לפני", k(m.preTokens)], ["אחרי", k(m.postTokens)], ["סוג", m.trigger === "manual" ? "ידני (/compact)" : "אוטומטי"]] };
}
export function rowsFromTool() { return []; }          // Tasks 2–3
export function foldPushRetries(rows) { return rows; } // Task 2
```

- [ ] **Step 5: Write record.mjs**

```js
// history-panel/lib/record.mjs
// Reads a Claude Code session record (JSONL) into the panel's history: one
// entry per human prompt, with its cost, context slice and technical rows.
import fs from "node:fs";
import { rowsFromTool, rowFromNote, rowFromStop, rowFromSlash, rowFromCompact, foldPushRetries } from "./events.mjs";

const INTERRUPT = /^\[Request interrupted by user( for tool use)?\]$/;
const SLASH = /^<command-name>(\/[^<]+)<\/command-name>[\s\S]*?<command-args>([\s\S]*?)<\/command-args>/;

export function readLines(file) {
  const lines = [];
  let bad = 0;
  for (const raw of fs.readFileSync(file, "utf8").split("\n")) {
    if (!raw.trim()) continue;
    try { lines.push(JSON.parse(raw)); } catch { bad++; }
  }
  return { lines, bad };
}

function rawText(d) {
  const c = d.message?.content;
  if (typeof c === "string") return c.trim();
  if (!Array.isArray(c) || c.some((x) => x.type === "tool_result")) return null;
  return c.filter((x) => x.type === "text").map((x) => x.text).join("\n").trim();
}

// The text the human typed, or null when the line is not a human prompt.
export function promptText(d) {
  if (d.type !== "user" || d.isMeta || d.isSidechain) return null;
  const t = rawText(d);
  if (!t || INTERRUPT.test(t)) return null;
  const s = SLASH.exec(t);
  if (s) return s[2].trim() && s[1] !== "/btw" ? `${s[1]} ${s[2].trim()}` : null;
  if (t.startsWith("<")) return null;
  return t.replace(/\[Image #\d+\]\s*/g, "").trim() || null;
}

const inTok = (u) => (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);

export function parseSession(lines, { price, subagentDir = null } = {}) {
  const entries = [];
  const calls = new Map();
  const seen = new Set();
  let cur = null, model = null, lastCall = null, base = 0;
  const nextPrompt = (i) => { for (let j = i + 1; j < lines.length; j++) { const t = promptText(lines[j]); if (t) return t; } return null; };

  for (let i = 0; i < lines.length; i++) {
    const d = lines[i];
    const text = promptText(d);
    if (text !== null) {
      const start = cur ? cur.ctx[1] : base;
      cur = { uuid: d.uuid, at: d.timestamp, prompt: text, reply: [], cost: 0, tokens: { read: 0, fresh: 0, written: 0 }, ctx: [start, start], rows: [], running: true };
      entries.push(cur);
      continue;
    }
    if (d.type === "system" && d.subtype === "compact_boundary") {
      if (cur) { cur.rows.push(rowFromCompact(d)); cur.ctx[1] = d.compactMetadata?.postTokens ?? cur.ctx[1]; }
      else base = d.compactMetadata?.postTokens ?? 0;
      continue;
    }
    if (!cur) continue;
    if (d.type === "system" && d.subtype === "turn_duration") { cur.running = false; continue; }

    if (d.type === "assistant") {
      const m = d.message || {};
      const u = m.usage;
      if (u && m.id && !seen.has(m.id)) {
        seen.add(m.id);
        cur.cost += price(m.model, u);
        cur.tokens.read += u.cache_read_input_tokens || 0;
        cur.tokens.fresh += (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0);
        cur.tokens.written += u.output_tokens || 0;
      }
      if (d.isSidechain) continue;
      model = m.model || model;
      if (u && inTok(u)) cur.ctx[1] = inTok(u);
      for (const x of m.content || []) {
        if (x.type === "tool_use") { const call = { id: x.id, name: x.name, input: x.input || {}, at: d.timestamp, cwd: d.cwd || "" }; calls.set(x.id, call); lastCall = call; }
        else if (x.type === "text" && x.text.trim()) cur.reply.push(x.text.trim());
      }
      continue;
    }

    if (d.type === "attachment" && d.attachment?.type === "queued_command") {
      if (d.attachment.origin?.kind === "human") cur.rows.push(rowFromNote(d.attachment, d.timestamp, lastCall));
      continue;
    }

    if (d.type !== "user" || d.isSidechain) continue;
    const c = d.message?.content;
    if (Array.isArray(c)) {
      for (const x of c) {
        if (x.type !== "tool_result") continue;
        const call = calls.get(x.tool_use_id);
        if (!call) continue;
        const out = typeof x.content === "string" ? x.content : (x.content || []).filter((y) => y.type === "text").map((y) => y.text).join("\n");
        for (const row of rowsFromTool(call, { isError: !!x.is_error, out, result: d.toolUseResult, at: d.timestamp }, { price, subagentDir })) {
          if (row.cost) cur.cost += row.cost;
          cur.rows.push(row);
        }
      }
    }
    const t = rawText(d);
    if (t && INTERRUPT.test(t)) { cur.rows.push(rowFromStop(d.timestamp, lastCall, nextPrompt(i))); cur.running = false; continue; }
    const s = t && SLASH.exec(t);
    if (s && (!s[2].trim() || s[1] === "/btw")) {
      const o = lines[i + 1] && rawText(lines[i + 1]);
      const out = o && o.startsWith("<local-command-stdout>") ? o.replace(/<\/?local-command-stdout>/g, "").trim() : "";
      cur.rows.push(rowFromSlash(s[1], s[2].trim(), out, d.timestamp));
    }
  }
  for (const e of entries) e.rows = foldPushRetries(e.rows);
  return { entries, first: lines[0]?.timestamp || null, last: lines.at(-1)?.timestamp || null, model };
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `node --test history-panel/test/record.test.mjs`
Expected: PASS (6 tests). If "slash with no args" lands in entry 0 instead of 1, check that the slash branch runs after the tool-result loop and that `promptText` returns null for it.

- [ ] **Step 7: Commit**

```bash
git add history-panel/lib history-panel/test
git commit -m "feat(history-panel): parse session records into entries"
```

---

### Task 2: Git, server, deploy and update rows

**Files:**
- Modify: `history-panel/lib/events.mjs` (replace the `rowsFromTool` and `foldPushRetries` stubs)
- Create: `history-panel/test/events.test.mjs`

**Interfaces:**
- Consumes: `call = { id, name, input, at, cwd }`, `res = { isError, out, result, at }` from Task 1.
- Produces: `rowsFromTool(call, res, { price, subagentDir }) → Row[]`; `bashRows(cmd, res, cwd) → Row[]`; `foldPushRetries(rows) → Row[]`. Server rows carry `port: number|null` for Task 4's listening check.

- [ ] **Step 1: Write the failing tests**

```js
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test history-panel/test/events.test.mjs`
Expected: FAIL with `does not provide an export named 'bashRows'`

- [ ] **Step 3: Implement the Bash rules (append to events.mjs, replacing the two stubs)**

```js
import path from "node:path";

// A git subcommand as a real command word: start of the command or after && ; | (,
// optionally `git -C <dir>`. Quoted text (echo 'git push', grep "git push") does not match.
const gitCmd = (cmd, sub) => new RegExp(`(?:^|&&|;|\\|\\||\\(|\\bdo\\b)\\s*(?:[A-Z_]+=\\S+\\s+)*git(?:\\s+-C\\s+(\\S+))?\\s+${sub}\\b`).exec(cmd);
const repoOf = (cmd, cwd, dashC) => {
  const cd = /(?:^|&&|;)\s*cd\s+("?)([^"&;]+)\1\s*&&/.exec(cmd);
  return path.basename((dashC || (cd && cd[2].trim()) || cwd || "").replace(/\/+$/, "")) || "?";
};
const argsAfter = (cmd, sub) => {
  const m = new RegExp(`git(?:\\s+-C\\s+\\S+)?\\s+${sub}\\s+([^&;|]*)`).exec(cmd);
  return m ? m[1].trim().split(/\s+/).filter((a) => a && !a.startsWith("-")) : [];
};
const lineMatch = (out, re) => String(out || "").split("\n").map((l) => re.exec(l)).find(Boolean) || null;
const row = (kind, at, what, detail, more, extra = {}) => ({ kind, at, what, detail, more, ...extra });

function commitRow(cmd, res, cwd) {
  const g = gitCmd(cmd, "commit");
  if (!g) return [];
  const repo = repoOf(cmd, cwd, g[1]);
  const head = lineMatch(res.out, /^\[([^\s\]]+)(?: \(root-commit\))? ([0-9a-f]{7,})\] (.+)$/);
  const log = head ? null : lineMatch(res.out, /^([0-9a-f]{7,40}) (.+)$/);
  if (!head && !log) {
    if (res.isError) return [row("commit", res.at, "השמירה נכשלה", repo, [["מאגר", repo], ["שגיאה", first(res.out)]], { fail: true })];
    return [row("commit", res.at, "נשמר שינוי", repo, [["מאגר", repo]])];
  }
  const id = (head ? head[2] : log[1]).slice(0, 7);
  const more = [["מאגר", repo]];
  if (head) more.push(["ענף", head[1]]);
  more.push(["מזהה", id], ["הודעה", head ? head[3] : log[2]]);
  const st = lineMatch(res.out, /(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/);
  if (st) more.push(["קבצים", `${st[1]} · +${st[2] || 0} −${st[3] || 0}`]);
  return [row("commit", res.at, "נשמר שינוי", `${repo} · ${id}`, more)];
}

function pushRow(cmd, res, cwd) {
  const g = gitCmd(cmd, "push");
  if (!g) return [];
  const repo = repoOf(cmd, cwd, g[1]);
  const args = argsAfter(cmd, "push");
  const out = String(res.out || "");
  const range = lineMatch(out, /^\s*\+?\s*([0-9a-f]{7,})\.\.\.?([0-9a-f]{7,})\s+(\S+)\s+->\s+(\S+)/);
  const created = lineMatch(out, /^\s*\*\s+\[new branch\]\s+(\S+)\s+->\s+(\S+)/);
  const branch = range ? range[4] : created ? created[2] : args[1] || "?";
  const rejected = out.split("\n").filter((l) => /\[(remote )?rejected\]|^error: failed to push/.test(l.trim()));
  const remote = lineMatch(out, /^To\s+(\S+)/);
  const more = [["מאגר", remote ? remote[1].replace(/\.git$/, "").replace(/^https?:\/\//, "") : repo], ["ענף", branch]];
  if (range) more.push(["שינויים", `${range[1].slice(0, 7)} → ${range[2].slice(0, 7)}`]);
  if (res.isError) return [row("push", res.at, "דחיפה נכשלה", `${repo} · ${branch}`, [...more, ["שגיאה", rejected[0] || first(out)]], { fail: true, repo, branch })];
  const rejects = rejected.filter((l) => /rejected/.test(l)).length;
  if (rejects) more.push(["ניסיונות", `${rejects + 1} · ${rejects} נדחו`]);
  const what = /Everything up-to-date/.test(out) ? "דחיפה: כבר מעודכן" : `נדחף ל‑${branch}`;
  return [row("push", res.at, what, range ? `${repo} · ${range[2].slice(0, 7)}` : repo, more, { repo, branch })];
}

function mergeRow(cmd, res, cwd) {
  const g = gitCmd(cmd, "merge");
  if (!g || /merge\s+--abort/.test(cmd)) return [];
  const from = argsAfter(cmd, "merge").at(-1);
  if (!from) return [];
  const into = repoOf(cmd, cwd, g[1]);
  if (res.isError || /CONFLICT|Automatic merge failed/.test(res.out)) {
    const files = String(res.out).split("\n").filter((l) => l.startsWith("CONFLICT")).map((l) => l.replace(/^.*Merge conflict in /, ""));
    return [row("merge", res.at, "האיחוד נעצר בהתנגשות", `${from} → ${into}`, [["מ", from], ["אל", into], ["התנגשויות", files.join(", ") || first(res.out)]], { fail: true })];
  }
  const how = /Fast-forward/.test(res.out) ? "קדימה בלי שינוי היסטוריה" : /Already up to date/.test(res.out) ? "כבר היה מעודכן" : "איחוד רגיל";
  return [row("merge", res.at, "אוחד", `${from} → ${into}`, [["מ", from], ["אל", into], ["תוצאה", how]])];
}

function worktreeRow(cmd, res, cwd) {
  const g = gitCmd(cmd, "worktree\\s+add");
  if (!g) return [];
  const m = /worktree\s+add\s+(?:-b\s+(\S+)\s+)?(\S+)(?:\s+(\S+))?/.exec(cmd);
  const b = /-b\s+(\S+)/.exec(cmd);
  const folder = path.basename(m[2]);
  const branch = b ? b[1] : m[3] || folder;
  if (res.isError) return [row("worktree", res.at, "פתיחת עותק עבודה נכשלה", folder, [["תיקייה", m[2]], ["שגיאה", first(res.out)]], { fail: true })];
  return [row("worktree", res.at, "נפתח עותק עבודה", `${folder} · ענף ${branch}`, [["תיקייה", m[2]], ["ענף", branch], ["נפתח מ", m[3] && m[3] !== branch ? m[3] : "הענף הנוכחי"]])];
}

const DEV = /(?:^|&&|;|\s)(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?dev(?:\s|$)|next\s+dev\b|vite(?:\s|$)|convex\s+dev\b|python3?\s+-m\s+http\.server\b)/;
function serverRow(cmd, res, cwd) {
  if (!DEV.test(cmd)) return [];
  const a = /(?:-p|--port)[ =](\d{2,5})|PORT=(\d{2,5})|http\.server\s+(\d{2,5})/.exec(cmd);
  const o = lineMatch(res.out, /(?:localhost|127\.0\.0\.1):(\d{2,5})/);
  const port = Number((a && (a[1] || a[2] || a[3])) || (o && o[1])) || (/http\.server/.test(cmd) ? 8000 : null);
  const folder = repoOf(cmd, cwd);
  const more = [["פקודה", clip(cmd, 80)], ["תיקייה", folder], ["כתובת", port ? `http://localhost:${port}` : "לא ידוע"]];
  if (res.isError) return [row("server", res.at, "השרת המקומי לא עלה", port ? `localhost:${port}` : folder, [...more, ["שגיאה", first(res.out)]], { fail: true, port })];
  return [row("server", res.at, "שרת מקומי עלה", port ? `localhost:${port}` : "פורט לא ידוע", more, { port })];
}

// Production deploys we recognise. Add a line here for a new kind of deploy.
const PROD = [
  [/\/api\/v1\/deploy\b/, (cmd) => `Coolify · ${(/uuid=([\w-]+)/.exec(cmd) || [])[1] || "?"}`],
  [/git(?:\s+-C\s+\S+)?\s+push\b[^&;|]*\bproduction\b/, (cmd, cwd) => `ענף production · ${repoOf(cmd, cwd)}`],
  [/\bvercel\b[^&;|]*--prod\b/, (cmd, cwd) => `Vercel · ${repoOf(cmd, cwd)}`],
  [/\bconvex\s+deploy\b/, (cmd, cwd) => `Convex · ${repoOf(cmd, cwd)}`],
  [/\bfly(?:ctl)?\s+deploy\b/, (cmd, cwd) => `Fly · ${repoOf(cmd, cwd)}`],
];
function prodRow(cmd, res, cwd) {
  const hit = PROD.find(([re]) => re.test(cmd));
  if (!hit) return [];
  const where = hit[1](cmd, cwd);
  if (res.isError) return [row("prod", res.at, "העלייה לפרודקשן נכשלה", where, [["לאן", where], ["שגיאה", first(res.out)]], { fail: true })];
  return [row("prod", res.at, "עלה לפרודקשן", where, [["לאן", where], ["תשובה", clip(first(res.out), 120) || "—"]])];
}

function updateRow(cmd, res) {
  const done = lineMatch(res.out, /claude-addons successfully updated to (\w+)/);
  if (!done) return [];
  const from = lineMatch(res.out, /updating claude-addons: (\w+) -> (\w+)/);
  const a = from ? from[1].slice(0, 7) : "?", b = done[1].slice(0, 7);
  return [row("update", res.at, "עדכון תוספים הותקן", `${a} → ${b}`, [["לפני", a], ["אחרי", b]])];
}

export function bashRows(cmd, res, cwd) {
  const rows = [...worktreeRow(cmd, res, cwd), ...commitRow(cmd, res, cwd), ...mergeRow(cmd, res, cwd)];
  const prod = prodRow(cmd, res, cwd);
  if (!prod.length || !/push/.test(cmd)) rows.push(...pushRow(cmd, res, cwd)); // a push to production is the prod row
  rows.push(...prod, ...serverRow(cmd, res, cwd), ...updateRow(cmd, res));
  return rows;
}

// Failed pushes followed by a success to the same branch are one row: the success, with attempts.
export function foldPushRetries(rows) {
  const out = [];
  for (const r of rows) {
    const prev = out.at(-1);
    if (r.kind === "push" && prev?.kind === "push" && prev.fail && prev.repo === r.repo && prev.branch === r.branch) {
      const before = (prev.tries || 1);
      out.pop();
      if (r.fail) { out.push({ ...r, tries: before + 1 }); continue; }
      const more = r.more.filter(([k]) => k !== "ניסיונות");
      const rejects = before + Number((r.more.find(([k]) => k === "ניסיונות") || ["", "1 · 0"])[1].split(" · ")[1].split(" ")[0]);
      out.push({ ...r, more: [...more, ["ניסיונות", `${rejects + 1} · ${rejects} נדחו`]] });
      continue;
    }
    out.push(r);
  }
  return out;
}

export function rowsFromTool(call, res, ctx) {
  if (call.name === "Bash") return bashRows(String(call.input.command || ""), res, call.cwd);
  return [];
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test history-panel/test/`
Expected: PASS (all record + events tests).

- [ ] **Step 5: Commit**

```bash
git add history-panel/lib/events.mjs history-panel/test/events.test.mjs
git commit -m "feat(history-panel): git, server, deploy and update rows"
```

---

### Task 3: Answers, subagents, worktree tool rows

**Files:**
- Modify: `history-panel/lib/events.mjs` (`rowsFromTool`)
- Modify: `history-panel/test/events.test.mjs`

**Interfaces:**
- Produces: answer rows (one per question), agent rows with `cost` (added to the entry by Task 1's loop) and `aiKey = "agent:<agentId>"` for Task 5; EnterWorktree rows.

- [ ] **Step 1: Write the failing tests (append)**

```js
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { rowsFromTool } from "../lib/events.mjs";
import { price } from "./fixture.mjs";

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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test history-panel/test/events.test.mjs`
Expected: FAIL — `rows.map(...)` gives `[]` for AskUserQuestion.

- [ ] **Step 3: Implement (replace `rowsFromTool` in events.mjs)**

```js
import fs from "node:fs";

function answerRows(call, res) {
  const qs = call.input.questions || [];
  if (res.isError || !res.result?.answers) {
    return [row("answer", res.at, "דילגת על שאלה", clip(qs[0]?.question, 40), [["השאלה", qs.map((q) => q.question).join(" · ")], ["מה קרה", first(res.out) || "—"]], { fail: true })];
  }
  return qs.map((q) => {
    const chosen = String(res.result.answers[q.question] ?? "");
    const labels = (q.options || []).map((o) => o.label);
    const own = !labels.includes(chosen);
    return row("answer", res.at, `ענית: ${clip(q.question, 40)}`, own ? "תשובה משלך" : clip(chosen, 40),
      [["השאלה", q.question], ["האפשרויות", labels.join(" · ") || "—"], [own ? "כתבת" : "בחרת", chosen]]);
  });
}

function agentRow(call, res, { price, subagentDir }) {
  const type = call.input.subagent_type || "general-purpose";
  const id = res.result?.agentId;
  let cost = 0, tools = 0, t0 = null, t1 = null, model = res.result?.resolvedModel || call.input.model || "?";
  const file = id && subagentDir ? path.join(subagentDir, `agent-${id}.jsonl`) : null;
  if (file && fs.existsSync(file)) {
    const seen = new Set();
    for (const raw of fs.readFileSync(file, "utf8").split("\n")) {
      let d; try { d = JSON.parse(raw); } catch { continue; }
      if (d.timestamp) { t0 ??= d.timestamp; t1 = d.timestamp; }
      const m = d.type === "assistant" && d.message;
      if (!m) continue;
      if (m.usage && m.id && !seen.has(m.id)) { seen.add(m.id); cost += price(m.model, m.usage); }
      tools += (m.content || []).filter((x) => x.type === "tool_use").length;
      model = m.model || model;
    }
  }
  cost = Math.round(cost * 100) / 100;
  const mins = t0 && t1 ? Math.round((Date.parse(t1) - Date.parse(t0)) / 60000) : null;
  const time = mins === null ? "רץ" : mins < 1 ? "פחות מדקה" : `${mins} דק׳`;
  return [row("agent", res.at, `סוכן משנה: ${type}`, `${time} · $${cost.toFixed(2)}`,
    [["סוג", `${type} · ${model}`], ["המשימה", call.input.description || clip(first(call.input.prompt), 80)], ["זמן", time], ["עלות", `$${cost.toFixed(2)}`], ["כלים", `${tools} קריאות`]],
    { cost, aiKey: id ? `agent:${id}` : undefined, fail: res.isError || undefined })];
}

export function rowsFromTool(call, res, ctx) {
  if (call.name === "Bash") return bashRows(String(call.input.command || ""), res, call.cwd);
  if (call.name === "AskUserQuestion") return answerRows(call, res);
  if (call.name === "Agent" || call.name === "Task") return agentRow(call, res, ctx);
  if (call.name === "EnterWorktree") return [row("worktree", res.at, res.isError ? "פתיחת עותק עבודה נכשלה" : "נפתח עותק עבודה", clip(first(res.out), 50) || "—", [["תוצאה", first(res.out) || "—"]], res.isError ? { fail: true } : {})];
  return [];
}
```

Note: `cost` 0.18 in the test = (100,000 + 80,000) / 1e6 with the fixture's $1/M price. The agent's cost is added to the entry by Task 1's loop (`if (row.cost) cur.cost += row.cost`), because subagent usage lives only in the subagent's own record.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test history-panel/test/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add history-panel/lib/events.mjs history-panel/test/events.test.mjs
git commit -m "feat(history-panel): answer, subagent and worktree rows"
```

---

### Task 4: CLI `build` and `entry`, and the window size from the status line

**Files:**
- Create: `history-panel/history.mjs`, `history-panel/test/cli.test.mjs`
- Modify: `statusline-gsd/gsd-statusline.js:578-583` (add `context_window_size` to the bridge JSON)

**Interfaces:**
- Consumes: `readLines`, `parseSession` (Task 1); cache file shape from Task 5 (`{ entries: { [uuid]: { title, asked, happened } }, ai: { [aiKey]: string }, failed: { [uuid]: epochMs } }`) — a missing file means "nothing cached".
- Produces (stdout JSON of `build <id>`, the view's only input):
  ```
  { name, minutes, cost, ctxPct, window, bad, record, turns: [
    { uuid, n, t, cost, br, ctx: [startTokens, endTokens], title, ask, did, summarized, running,
      events: [[kind, time, what, detail, ai, more, fail]] } ] }
  ```
  `entry <id> <n>` prints Markdown (prompt, reply, rows). `findRecord(id) → path|null`.
- Env overrides for tests: `HISTORY_PROJECTS`, `HISTORY_STATE`, `HISTORY_CACHE`, `HISTORY_STATUSLINE`, `HISTORY_NO_SPAWN=1`.

- [ ] **Step 1: Write the failing test**

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test history-panel/test/cli.test.mjs`
Expected: FAIL — `Cannot find module …/history.mjs`.

- [ ] **Step 3: Write history.mjs**

```js
#!/usr/bin/env node
// history-panel CLI. build <session>: the panel's JSON. entry <session> <n>: one
// entry as Markdown. summarize <session> | --hook: fill missing summaries (Task 5).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { readLines, parseSession } from "./lib/record.mjs";

const HOME = os.homedir();
const PROJECTS = process.env.HISTORY_PROJECTS || path.join(HOME, ".claude", "projects");
const STATE = process.env.HISTORY_STATE || path.join(HOME, ".claude", "terminal-state");
export const CACHE = process.env.HISTORY_CACHE || path.join(HOME, ".claude", "history-panel", "cache");
const STATUSLINE = process.env.HISTORY_STATUSLINE || path.join(HOME, ".claude", "gsd-statusline.js");
const SAFE = /^[\w-]{1,80}$/;

const { usageCost } = createRequire(import.meta.url)(STATUSLINE);
const price = (model, u) => usageCost(model, u);

export function findRecord(id) {
  if (!SAFE.test(id)) return null;
  for (const dir of fs.existsSync(PROJECTS) ? fs.readdirSync(PROJECTS) : []) {
    const f = path.join(PROJECTS, dir, `${id}.jsonl`);
    if (fs.existsSync(f)) return f;
  }
  return null;
}
const readJson = (f, fallback) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return fallback; } };
export const readCache = (id) => readJson(path.join(CACHE, `${id}.json`), { entries: {}, ai: {}, failed: {} });

// Window size: what the status line last saw for this session, else by model.
function windowFor(id, model) {
  const bridge = readJson(path.join(os.tmpdir(), `claude-ctx-${id}.json`), null);
  if (bridge?.context_window_size) return bridge.context_window_size;
  return /opus-5|fable|sonnet-5|\[1m\]/.test(model || "") ? 1_000_000 : 200_000;
}
const hhmm = (iso) => { const d = new Date(iso); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };
const k = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : `${Math.round(n / 1000)}K`);
const listening = (port) => { try { execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN"], { stdio: "pipe", timeout: 1500 }); return true; } catch { return false; } };

function load(id) {
  const record = findRecord(id);
  if (!record) return null;
  const { lines, bad } = readLines(record);
  const subagentDir = path.join(path.dirname(record), id, "subagents");
  return { record, bad, ...parseSession(lines, { price, subagentDir }) };
}

export function build(id) {
  const s = load(id);
  if (!s) return { error: "לא נמצאה רשומה לשיחה הזו" };
  const cache = readCache(id);
  const window = windowFor(id, s.model);
  const ports = new Map();
  const turns = s.entries.map((e, i) => {
    const sum = cache.entries[e.uuid];
    const events = e.rows.map((r) => {
      let more = r.more;
      if (r.kind === "server" && r.port && !r.fail) {
        if (!ports.has(r.port)) ports.set(r.port, listening(r.port));
        more = [...more, ["מצב", ports.get(r.port) ? "עדיין רץ" : "כבר לא רץ"]];
      }
      return [r.kind, hhmm(r.at), r.what, r.detail, (r.aiKey && cache.ai[r.aiKey]) || "", more, !!r.fail];
    });
    return {
      uuid: e.uuid, n: i + 1, t: hhmm(e.at), cost: Math.round(e.cost * 100) / 100,
      br: `reread ${k(e.tokens.read)} · new ${k(e.tokens.fresh)} · written ${k(e.tokens.written)}`,
      ctx: e.ctx, title: sum?.title || e.prompt.slice(0, 28), ask: sum?.asked || e.prompt.slice(0, 120),
      did: sum?.happened || (e.running ? "" : "לא סוכם עדיין"), summarized: !!sum, running: e.running, events,
    };
  });
  const missing = s.entries.some((e) => !e.running && !cache.entries[e.uuid] && Date.now() - (cache.failed[e.uuid] || 0) > 120_000);
  if (missing && !process.env.HISTORY_NO_SPAWN) spawn(process.execPath, [new URL(import.meta.url).pathname, "summarize", id], { detached: true, stdio: "ignore" }).unref();
  const last = s.entries.at(-1);
  return {
    name: (fs.existsSync(path.join(STATE, `${id}.name`)) && fs.readFileSync(path.join(STATE, `${id}.name`), "utf8").trim()) || id.slice(0, 8),
    minutes: s.first && s.last ? Math.round((Date.parse(s.last) - Date.parse(s.first)) / 60000) : 0,
    cost: Math.round(s.entries.reduce((a, e) => a + e.cost, 0) * 100) / 100,
    ctxPct: last ? Math.round((last.ctx[1] / window) * 100) : 0, window, bad: s.bad, record: s.record, turns,
  };
}

export function entryMarkdown(id, n) {
  const s = load(id);
  const e = s?.entries[n - 1];
  if (!e) return "לא נמצאה ההודעה הזו.";
  const rows = e.rows.map((r) => `- ${r.fail ? "✕ " : ""}${r.what} · ${r.detail}\n${r.more.map(([a, b]) => `  - ${a}: ${b}`).join("\n")}`).join("\n");
  return `# #${n} · ${hhmm(e.at)}\n\n## ביקשת\n\n${e.prompt}\n\n## התשובה\n\n${e.reply.join("\n\n") || "—"}\n\n## פעולות\n\n${rows || "—"}\n`;
}

const [cmd, id, arg] = process.argv.slice(2);
if (import.meta.url === `file://${process.argv[1]}`) {
  if (cmd === "build") process.stdout.write(JSON.stringify(build(id)));
  else if (cmd === "entry") process.stdout.write(entryMarkdown(id, Number(arg)));
  else if (cmd === "summarize") { const { run } = await import("./lib/summarize.mjs"); await run(id, { load, readCache, CACHE }); }
  else { process.stderr.write("usage: history.mjs build|entry|summarize <session> [n]\n"); process.exit(2); }
}
```

- [ ] **Step 4: Status line writes the window size into its bridge file**

In `statusline-gsd/gsd-statusline.js`, inside `const bridgeData = JSON.stringify({ … })` (around line 578), add one field after `used_pct: rawUsedPct,`:

```js
            context_window_size: totalCtx,
```

Run: `node statusline-gsd/gsd-statusline-subagents-selftest.js && node statusline-gsd/gsd-statusline-compact-selftest.js`
Expected: both print their OK line (no change in behavior).

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test history-panel/test/`
Expected: PASS. If the price assertion fails, print `JSON.parse(run("build","s1")).turns[0].cost` and compare with `require("./statusline-gsd/gsd-statusline.js").usageCost("claude-opus-5-5", usage)` for each message — they must match exactly.

- [ ] **Step 6: Real-record smoke test (the brainstorm's own session)**

Run: `HISTORY_NO_SPAWN=1 HISTORY_STATUSLINE=statusline-gsd/gsd-statusline.js node history-panel/history.mjs build 5d2727f4-a4ff-4228-a9bd-773e5a9fb69c | node -e 'const s=JSON.parse(require("fs").readFileSync(0));const ev=s.turns.flatMap(t=>t.events);const c=k=>ev.filter(e=>e[0]===k).length;console.log({turns:s.turns.length,cost:s.cost,answers:c("answer"),notes:c("note"),stops:c("stop"),push:ev.filter(e=>e[0]==="push").map(e=>e[3])})'`
Expected: `answers` ≥ 3, `notes` ≥ 1, `stops` ≥ 1, `push` includes `"claude-addons · d5faff1"`; `cost` within $0.05 of the status line's session total shown in that terminal.

- [ ] **Step 7: Commit**

```bash
git add history-panel/history.mjs history-panel/test/cli.test.mjs statusline-gsd/gsd-statusline.js
git commit -m "feat(history-panel): build and entry commands; status line shares window size"
```

---

### Task 5: Summaries with the cheapest model

**Files:**
- Create: `history-panel/lib/summarize.mjs`, `history-panel/test/summarize.test.mjs`

**Interfaces:**
- Consumes: `load(id)`, `readCache(id)`, `CACHE` from Task 4 (passed in by `history.mjs`).
- Produces: `run(id, { load, readCache, CACHE, ask? })` — fills the cache; `summarizeBatch(items, ask) → { [uuid]: { title, asked, happened } }`; `askModel(messages) → string` (gateway models, then `claude -p --model haiku`); `hook(stdinJson)` — Stop hook entry.

- [ ] **Step 1: Write the failing tests**

```js
// history-panel/test/summarize.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { summarizeBatch, parseAnswer } from "../lib/summarize.mjs";

test("batch asks once and maps answers by uuid; titles are cut to 28 chars", async () => {
  let calls = 0;
  const ask = async (messages) => {
    calls++;
    assert.match(messages[1].content, /#1[\s\S]*תדחוף/);
    return JSON.stringify([{ n: 1, title: "דחיפה למאגר התוספים וגם עוד הרבה מילים", asked: "לדחוף.", happened: "נדחף." }]);
  };
  const out = await summarizeBatch([{ uuid: "u1", prompt: "תדחוף", reply: ["נדחף."], rows: [{ what: "נדחף ל‑master", detail: "b" }] }], ask);
  assert.equal(calls, 1);
  assert.equal([...out.u1.title].length, 28);
  assert.equal(out.u1.happened, "נדחף.");
});

test("answer parser accepts fenced JSON and rejects junk", () => {
  assert.deepEqual(parseAnswer('```json\n[{"n":1,"title":"a","asked":"b","happened":"c"}]\n```'), [{ n: 1, title: "a", asked: "b", happened: "c" }]);
  assert.equal(parseAnswer("sorry"), null);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test history-panel/test/summarize.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement summarize.mjs**

```js
// history-panel/lib/summarize.mjs
// Short "asked / happened" summaries by the cheapest model that answers.
// Same gateway and model order as the tab namer (tab-status/tab-autoname.py).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";

const API = process.env.HISTORY_API || "http://127.0.0.1:8317/v1/chat/completions";
const MODELS = (process.env.HISTORY_MODELS || "gemini-3.5-flash-lite,claude-gemini-flash,claude-grok-46").split(",").filter(Boolean);
const MAX_TEXT = 6000;
const BATCH = 10;
const head = (s, n) => (s.length > n ? s.slice(0, n / 2) + "\n…\n" + s.slice(-n / 2) : s);

const SYSTEM = "You summarize turns of a conversation between a user and a coding assistant, for the user's own history list. " +
  "For each numbered turn return {n, title, asked, happened}: title at most 28 characters; asked = what the user wanted, one sentence; " +
  "happened = the outcome, one or two short sentences, concrete (what was built, found, pushed, decided). " +
  "Write in the language the user wrote in. Plain words, no code identifiers, no file names. Reply with only a JSON array.";

export function parseAnswer(text) {
  const m = /\[[\s\S]*\]/.exec(String(text || ""));
  if (!m) return null;
  try { const a = JSON.parse(m[0]); return Array.isArray(a) ? a : null; } catch { return null; }
}

function key() {
  try { return fs.readFileSync(path.join(os.homedir(), ".cli-proxy-api", "local-key"), "utf8").trim() || "local"; } catch { return "local"; }
}

async function viaGateway(model, messages) {
  const r = await fetch(API, { method: "POST", signal: AbortSignal.timeout(40_000), headers: { "Content-Type": "application/json", Authorization: `Bearer ${key()}` },
    body: JSON.stringify({ model, max_tokens: 1500, temperature: 0, stream: false, messages }) });
  if (!r.ok) throw new Error(`gateway ${r.status}`);
  const c = (await r.json()).choices?.[0];
  if (!c || !["stop", "end_turn", null, undefined].includes(c.finish_reason)) throw new Error("cut off");
  return c.message?.content || "";
}

// Last resort on machines without the gateway. Runs in its own folder so its
// record does not land in the user's project, and our Stop hook skips it.
function viaClaude(messages) {
  const dir = path.join(os.homedir(), ".claude", "history-panel", "scratch");
  fs.mkdirSync(dir, { recursive: true });
  return new Promise((resolve, reject) => execFile("claude", ["-p", "--model", "haiku", `${messages[0].content}\n\n${messages[1].content}`],
    { cwd: dir, timeout: 90_000, env: { ...process.env, HISTORY_PANEL_CHILD: "1" } }, (err, out) => (err ? reject(err) : resolve(out))));
}

export async function askModel(messages) {
  let last;
  for (const m of MODELS) { try { return await viaGateway(m, messages); } catch (e) { last = e; } }
  try { return await viaClaude(messages); } catch (e) { throw last || e; }
}

export async function summarizeBatch(items, ask = askModel) {
  const body = items.map((e, i) => [`#${i + 1}`, `USER: ${head(e.prompt, MAX_TEXT)}`,
    `ASSISTANT (final words): ${head(e.reply.slice(-2).join("\n"), 2000)}`,
    `ACTIONS: ${e.rows.map((r) => `${r.what} ${r.detail}`).join("; ") || "none"}`].join("\n")).join("\n\n");
  const answer = parseAnswer(await ask([{ role: "system", content: SYSTEM }, { role: "user", content: body }]));
  const out = {};
  for (const a of answer || []) {
    const e = items[(a.n || 0) - 1];
    if (!e || !a.title) continue;
    out[e.uuid] = { title: [...String(a.title)].slice(0, 28).join(""), asked: String(a.asked || ""), happened: String(a.happened || "") };
  }
  return out;
}

const AGENT_SYSTEM = "In one short sentence, in Hebrew, plain words: what did this helper agent find or do? Reply with only the sentence.";

export async function run(id, { load, readCache, CACHE, ask = askModel }) {
  fs.mkdirSync(CACHE, { recursive: true });
  const lock = path.join(CACHE, `${id}.lock`);
  try { const st = fs.statSync(lock); if (Date.now() - st.mtimeMs < 120_000) return; } catch {}
  fs.writeFileSync(lock, String(process.pid));
  try {
    const s = load(id);
    if (!s) return;
    const cache = readCache(id);
    const todo = s.entries.filter((e) => !e.running && !cache.entries[e.uuid] && Date.now() - (cache.failed[e.uuid] || 0) > 120_000);
    for (let i = 0; i < todo.length; i += BATCH) {
      const batch = todo.slice(i, i + BATCH);
      let got = {};
      try { got = await summarizeBatch(batch, ask); } catch {}
      for (const e of batch) { if (got[e.uuid]) { cache.entries[e.uuid] = got[e.uuid]; delete cache.failed[e.uuid]; } else cache.failed[e.uuid] = Date.now(); }
      save(CACHE, id, cache);
    }
    for (const r of s.entries.flatMap((e) => e.rows).filter((r) => r.aiKey && !cache.ai[r.aiKey])) {
      try { cache.ai[r.aiKey] = (await ask([{ role: "system", content: AGENT_SYSTEM }, { role: "user", content: r.more.map(([a, b]) => `${a}: ${b}`).join("\n") }])).trim().slice(0, 200); } catch {}
    }
    save(CACHE, id, cache);
  } finally { fs.rmSync(lock, { force: true }); }
}

function save(dir, id, cache) {
  const tmp = path.join(dir, `${id}.json.${process.pid}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(cache));
  fs.renameSync(tmp, path.join(dir, `${id}.json`));
}
```

Note: the subagent line's input today is the row's facts (type, task, time); the subagent's own final text is not passed. That is enough for one sentence about what it was sent to do; feeding its final reply is a later improvement (ponytail: one model call per agent, facts only).

- [ ] **Step 4: Add the Stop hook path to history.mjs**

Replace the `summarize` branch in `history.mjs` with:

```js
  else if (cmd === "summarize") {
    if (process.env.HISTORY_PANEL_CHILD) process.exit(0);         // our own `claude -p` fallback
    if (id === "--hook") {                                          // Stop hook: return at once, work detached
      const input = JSON.parse(fs.readFileSync(0, "utf8") || "{}");
      if (SAFE.test(input.session_id || "")) spawn(process.execPath, [new URL(import.meta.url).pathname, "summarize", input.session_id], { detached: true, stdio: "ignore" }).unref();
      process.exit(0);
    }
    const { run } = await import("./lib/summarize.mjs");
    await run(id, { load, readCache, CACHE });
  }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test history-panel/test/`
Expected: PASS.

- [ ] **Step 6: Real smoke test against the gateway**

Run: `HISTORY_STATUSLINE=statusline-gsd/gsd-statusline.js HISTORY_CACHE=/tmp/hp-cache node history-panel/history.mjs summarize 5d2727f4-a4ff-4228-a9bd-773e5a9fb69c && node -e 'const c=require("/tmp/hp-cache/5d2727f4-a4ff-4228-a9bd-773e5a9fb69c.json");console.log(Object.values(c.entries).slice(0,3), Object.keys(c.failed).length)'`
Expected: three Hebrew summaries with titles ≤ 28 chars; `failed` 0. If the gateway is down, the `claude -p` path answers (slower).

- [ ] **Step 7: Commit**

```bash
git add history-panel/lib/summarize.mjs history-panel/test/summarize.test.mjs history-panel/history.mjs
git commit -m "feat(history-panel): cheap-model summaries with cache and Stop hook"
```

---

### Task 6: VS Code extension — panel view, terminal following, jump

**Files:**
- Create: `history-panel/vscode-extension/package.json`, `extension.js`, `view.html`

**Interfaces:**
- Consumes: `node ~/.claude/history-panel/history.mjs build <id>` JSON (Task 4) and `entry <id> <n>` Markdown; `~/.claude/terminal-state/tty.<tty>.session` and `<session>.state` (tab-status).
- Produces: webview messages `{ type: "data", data }` (extension → view); `{ type: "jump", n, total }`, `{ type: "open", n }` (view → extension).

- [ ] **Step 1: package.json**

```json
{
  "name": "claude-history",
  "displayName": "Claude History",
  "description": "What each Claude session did, beside its terminal.",
  "version": "0.1.0",
  "publisher": "claude-addons",
  "license": "MIT",
  "engines": { "vscode": "^1.80.0" },
  "main": "./extension.js",
  "activationEvents": ["onStartupFinished"],
  "contributes": {
    "viewsContainers": { "panel": [{ "id": "claudeHistory", "title": "History", "icon": "$(history)" }] },
    "views": { "claudeHistory": [{ "type": "webview", "id": "claudeHistory.view", "name": "History" }] }
  }
}
```

- [ ] **Step 2: extension.js**

```js
// Shows the focused terminal's Claude session history in a panel view.
// All rules live in ~/.claude/history-panel/history.mjs; this file only finds
// the session, runs it, and passes clicks back.
const vscode = require("vscode");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile, execFileSync } = require("child_process");

const STATE = path.join(os.homedir(), ".claude", "terminal-state");
const CLI = path.join(os.homedir(), ".claude", "history-panel", "history.mjs");
const STICKY = path.join(os.homedir(), ".claude", "scripts", "sticky-claude");
const SAFE = /^[\w./-]{1,80}$/;
const read = (f) => { try { return fs.readFileSync(f, "utf8").trim(); } catch { return ""; } };
const ps = (args) => { try { return execFileSync("ps", args, { encoding: "utf8" }); } catch { return ""; } };

// Mirror of tab-status's sessionTty: the shell's process subtree may paint on a
// second pty (sticky-claude); prefer the tty that owns a live session.
function sessionOf(shellPid) {
  const kids = new Map(), ttys = new Map();
  for (const line of ps(["-eo", "pid=,ppid=,tty="]).split("\n")) {
    const [pid, parent, tty] = line.trim().split(/\s+/);
    if (!/^\d+$/.test(pid)) continue;
    kids.set(parent, (kids.get(parent) || []).concat(pid));
    ttys.set(pid, SAFE.test(tty || "") && tty !== "??" ? tty : "");
  }
  const queue = [String(shellPid)], seen = new Set();
  while (queue.length) {
    const pid = queue.shift();
    if (seen.has(pid)) continue;
    seen.add(pid);
    const tty = ttys.get(pid);
    const id = tty && read(path.join(STATE, `tty.${tty}.session`));
    if (id && /^[\w-]+$/.test(id) && fs.existsSync(path.join(STATE, `${id}.state`))) return id;
    queue.push(...(kids.get(pid) || []));
  }
  return null;
}

class HistoryView {
  constructor(ctx) { this.ctx = ctx; this.view = null; this.session = null; this.watcher = null; this.timer = null; this.busy = false; }

  resolveWebviewView(view) {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = fs.readFileSync(path.join(__dirname, "view.html"), "utf8");
    view.webview.onDidReceiveMessage((m) => this.onMessage(m));
    view.onDidChangeVisibility(() => view.visible && this.follow());
    this.follow();
  }

  async follow() {
    const term = vscode.window.activeTerminal;
    const pid = term && (await term.processId);
    const id = pid ? sessionOf(pid) : null;
    if (id !== this.session) {
      this.session = id;
      if (this.watcher) { this.watcher.close(); this.watcher = null; }
    }
    this.refresh();
  }

  refresh() {
    if (!this.view?.visible) return;
    if (!this.session) return this.post({ empty: "אין שיחה של קלוד בטרמינל הזה" });
    if (this.busy) { this.again = true; return; }
    this.busy = true;
    execFile(process.execPath.includes("Code") ? "node" : process.execPath, [CLI, "build", this.session], { maxBuffer: 64 << 20, timeout: 20_000 }, (err, out) => {
      this.busy = false;
      let data;
      try { data = JSON.parse(out); } catch { data = { error: err ? `ההיסטוריה לא נטענה: ${String(err.message).split("\n")[0]}` : "ההיסטוריה לא נטענה" }; }
      this.post(data);
      if (data.record && !this.watcher) {
        try { this.watcher = fs.watch(data.record, () => { clearTimeout(this.timer); this.timer = setTimeout(() => this.refresh(), 500); }); } catch {}
      }
      if (this.again) { this.again = false; this.refresh(); }
    });
  }

  post(data) { this.view?.webview.postMessage({ type: "data", data }); }

  async onMessage(m) {
    if (m.type === "jump") {
      const term = vscode.window.activeTerminal;
      if (!term || !fs.existsSync(STICKY)) return this.openEntry(m.n);   // no prompt marks to jump by
      term.show(false);
      await vscode.commands.executeCommand("workbench.action.terminal.scrollToBottom");
      for (let i = 0; i < m.total - m.n + 1; i++) await vscode.commands.executeCommand("workbench.action.terminal.scrollToPreviousCommand");
    } else if (m.type === "open") this.openEntry(m.n);
  }

  openEntry(n) {
    if (!this.session) return;
    execFile("node", [CLI, "entry", this.session, String(n)], { maxBuffer: 16 << 20 }, async (err, md) => {
      const doc = await vscode.workspace.openTextDocument({ content: err ? "ההודעה לא נטענה." : md, language: "markdown" });
      vscode.window.showTextDocument(doc, { preview: true, viewColumn: vscode.ViewColumn.Active });
    });
  }
}

function activate(ctx) {
  const view = new HistoryView(ctx);
  ctx.subscriptions.push(
    vscode.window.registerWebviewViewProvider("claudeHistory.view", view, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.window.onDidChangeActiveTerminal(() => view.follow()),
    { dispose: () => view.watcher && view.watcher.close() },
  );
  const tick = setInterval(() => view.follow(), 3000);    // a session can start in an already-focused terminal
  ctx.subscriptions.push({ dispose: () => clearInterval(tick) });
}
module.exports = { activate, deactivate() {} };
```

Note on `node`: VS Code's extension host is Electron, so `process.execPath` is the Code binary, not node. The `execFile` above therefore runs plain `node` from PATH. If `node` is not on the extension host's PATH (GUI-launched VS Code), replace it with the absolute path the add-on writes — Step 5 checks this.

- [ ] **Step 3: view.html — the approved mockup, data-driven**

Copy `docs/superpowers/specs/2026-10-07-history-panel-designs.html` to `history-panel/vscode-extension/view.html`, then make these exact changes:

1. Delete: the `<h1>`, `.lede`, the whole `.vsc` block's `vsc-head`, `.term`, both `.sash` elements and `.tlist`; keep only `<div class="hist" id="hist-pane">…</div>` as the body's only child, with `style="height:100vh"`.
2. CSS `:root`: replace the fixed backgrounds and ink with VS Code theme variables, keep the status-line colors:
   ```css
   --page: var(--vscode-panel-background); --panel: var(--vscode-editorWidget-background, #1e1e2e); --side: var(--vscode-panel-background);
   --hover: var(--vscode-list-hoverBackground); --line: var(--vscode-panel-border, #313244); --ink: var(--vscode-foreground); --muted: var(--vscode-descriptionForeground);
   --ui: var(--vscode-font-family); --he: var(--vscode-font-family); --mono: var(--vscode-editor-font-family);
   ```
   Remove the Google Fonts `<link>`; set `body { padding: 0; background: var(--side); }`.
3. Script: delete `SESSIONS`, `current`, the sash code, the `tlist` handler and `renderTerm`. Replace `WINDOW` and `pct` with per-session values:
   ```js
   const vscode = acquireVsCodeApi();
   let S = null;
   const pct = (tokens) => Math.round((tokens / S.window) * 100);
   const total = () => S.cost;
   ```
   In `slice`, `miniSlice` and `header`, use `t.ctx` (tokens) with `S.window` instead of `WINDOW` (`(x / S.window) * 100`); in `header` use `S.minutes`, `S.ctxPct`, `money(S.cost)`; when `t.ctx[1] < t.ctx[0]` (compaction) draw `mine` with zero width and label `↺ ${pct(t.ctx[1])}%`.
4. In `ev(...)`, accept the 7th element `fail`: when true use `EV.fail` for icon and color.
5. Unsummarized entries: when `!t.summarized && !t.running`, render `did` with class `busy`-like muted style and the text as given ("לא סוכם עדיין").
6. Replace `render()` with:
   ```js
   function render() {
     const h = document.getElementById("hist"), title = document.getElementById("htitle");
     if (!S || S.empty || S.error) { title.textContent = "HISTORY"; h.innerHTML = `<div class="empty">${(S && (S.empty || S.error)) || "טוען…"}</div>`; return; }
     title.innerHTML = header(S);
     h.innerHTML = cards(S) + (S.bad ? `<div class="empty">${S.bad} שורות ברשומה לא נקראו</div>` : "");
   }
   window.addEventListener("message", (e) => { if (e.data.type === "data") { S = e.data.data; render(); } });
   ```
   and `header(s)` uses `s.name`.
7. Card click: keep the `openTurns` toggle and then `vscode.postMessage({ type: "jump", n: t.n, total: S.turns.length })` instead of `render(i)` + overlay. Inside `.b-body`, append a link `<a class="open" data-open="${t.n}">פתח את ההודעה המלאה</a>`; clicking it posts `{ type: "open", n }` (check `e.target.dataset.open` first in the click handler and `return`).
8. Keep `openTurns` across data refreshes (it is keyed by index; refresh keeps the same order).

- [ ] **Step 4: Install by hand and verify placement (owner does one drag)**

Run:
```bash
mkdir -p ~/.claude/history-panel ~/.vscode/extensions/claude-history
cp -R history-panel/history.mjs history-panel/lib ~/.claude/history-panel/
cp history-panel/vscode-extension/* ~/.vscode/extensions/claude-history/
```
Then ask the owner, in Hebrew, to: Cmd+Shift+P → Reload Window; open the bottom panel; find the **History** tab; drag its tab onto the right half of the terminal area so it sits beside the terminal; drag the border between them to make it narrow, then wider. Expected: the view docks beside the terminal, shows the focused session, switches when another terminal is clicked, turns compact under 340 px, and can be collapsed.
**If VS Code will not dock it beside the terminal:** stop and tell the owner; keep it as its own panel tab.

- [ ] **Step 5: Check `node` is reachable from the extension host**

Open View → Output → "Log (Extension Host)" and look for `ENOENT` from the history view. If present, change both `execFile("node", …)` / `process.execPath…` calls to the absolute path from `command -v node` written into `~/.claude/history-panel/node-path` by the add-on (Task 7 run step) and read with `read(...) || "node"`.

- [ ] **Step 6: Commit**

```bash
git add history-panel/vscode-extension
git commit -m "feat(history-panel): VS Code panel view following the focused terminal"
```

---

### Task 7: Add-on manifest, snippets, README, ship

**Files:**
- Create: `history-panel/addon.json`, `history-panel/settings.json.snippet`, `history-panel/vscode-settings.snippet`
- Modify: `README.md` (one table row)

**Interfaces:**
- Consumes: everything above. Engine manifest fields as used by `tab-status`/`hebrew-guard` (`files[].when: "vscode"`, `claudeSettings`, `vscodeSettings`, `requires`, `ownsCommands`, `run`).

- [ ] **Step 1: Manifest and snippets**

```json
// history-panel/addon.json
{
  "id": "history-panel",
  "order": 12,
  "default": true,
  "requires": ["tab-status", "statusline-gsd"],
  "title": "היסטוריית הודעות ליד הטרמינל",
  "summary": "חלון ב‑VS Code שמראה לכל טרמינל מה ביקשת, מה קרה, כמה עלה וכמה קונטקסט, ושורות טכניות כמו דחיפה, איחוד ופרודקשן.",
  "detect": { "file": "~/.claude/history-panel/history.mjs" },
  "files": [
    { "from": "history.mjs", "to": "~/.claude/history-panel/history.mjs", "mode": "755" },
    { "from": "lib/record.mjs", "to": "~/.claude/history-panel/lib/record.mjs" },
    { "from": "lib/events.mjs", "to": "~/.claude/history-panel/lib/events.mjs" },
    { "from": "lib/summarize.mjs", "to": "~/.claude/history-panel/lib/summarize.mjs" },
    { "from": "vscode-extension/package.json", "to": "~/.vscode/extensions/claude-history/package.json", "when": "vscode" },
    { "from": "vscode-extension/extension.js", "to": "~/.vscode/extensions/claude-history/extension.js", "when": "vscode" },
    { "from": "vscode-extension/view.html", "to": "~/.vscode/extensions/claude-history/view.html", "when": "vscode" }
  ],
  "claudeSettings": [{ "file": "settings.json.snippet" }],
  "vscodeSettings": "vscode-settings.snippet",
  "ownsCommands": "history-panel/history\\.mjs",
  "run": { "cmd": "command -v node > ~/.claude/history-panel/node-path || true", "when": "changed" },
  "group": "טרמינל",
  "details": [
    "חלון \"History\" באזור התחתון של VS Code. גוררים אותו פעם אחת ליד הטרמינל; הוא עוקב אחרי הטרמינל שפתוח מולך.",
    "לכל הודעה ששלחת: כותרת, מה ביקשת ומה קרה (מודל זול מסכם), שעה, מחיר כמו בשורת המצב, ופס שמראה רק את הקונטקסט שההודעה הוסיפה.",
    "שורות טכניות בנוסח קבוע, בלי מודל: שמירה, דחיפה, איחוד, עותק עבודה, שרת מקומי ופורט, פרודקשן, תשובות לשאלות, הכוונה באמצע, עצירה, פקודות וסוכני משנה. לחיצה פותחת את כל הפרטים.",
    "לחיצה על הודעה קופצת אליה בטרמינל; \"פתח את ההודעה המלאה\" פותח אותה מהרשומה גם אם הטרמינל כבר לא זוכר אותה.",
    "הטרמינל זוכר 50,000 שורות במקום 1,000.",
    "צר מ‑340 נקודות: כל הודעה שתי שורות (כותרת, ומתחת פס, מחיר וסמלים)."
  ],
  "howToCheck": "Reload Window, פתח את הלשונית History באזור התחתון, גרור אותה ליד הטרמינל, ושלח הודעה לקלוד: אחרי שהוא מסיים מופיע כרטיס עם סיכום, מחיר ופס קונטקסט."
}
```

(Remove the `// history-panel/addon.json` comment line when writing the file — JSON has no comments.)

```json
{
  "hooks": {
    "Stop": [
      { "hooks": [ { "type": "command", "command": "node \"$HOME/.claude/history-panel/history.mjs\" summarize --hook 2>/dev/null || true", "timeout": 10 } ] }
    ]
  }
}
```
(`history-panel/settings.json.snippet`)

```json
{ "terminal.integrated.scrollback": 50000 }
```
(`history-panel/vscode-settings.snippet`)

Then in `extension.js` replace the two `node` launches with `const NODE = read(path.join(os.homedir(), ".claude", "history-panel", "node-path")) || "node";` and `execFile(NODE, …)`.

- [ ] **Step 2: README row** — insert above the `fable-plan` row:

```markdown
| [**history-panel**](./history-panel) | חלון "History" ב‑VS Code ליד הטרמינל: לכל הודעה ששלחת כותרת, מה ביקשת ומה קרה (מודל זול מסכם), מחיר כמו בשורת המצב ופס שמראה רק את הקונטקסט שההודעה הוסיפה. מתחת לכל הודעה שורות טכניות בנוסח קבוע — שמירה, דחיפה, איחוד, עותק עבודה, שרת מקומי ופורט, פרודקשן, תשובות לשאלות, הכוונה באמצע, עצירה וסוכני משנה — שנפתחות לכל הפרטים. לחיצה קופצת להודעה בטרמינל או פותחת אותה מהרשומה. צר מ‑340 נקודות: תצוגה מצומצמת. |
```

- [ ] **Step 3: Run every test**

Run: `node --test history-panel/test/ && node --test engine/test/engine.test.mjs && node statusline-gsd/gsd-statusline-subagents-selftest.js`
Expected: all pass.

- [ ] **Step 4: Commit and push**

```bash
git add history-panel README.md
git commit -m "feat(history-panel): add-on manifest, Stop hook, scrollback, README"
git fetch -q && git rebase -q origin/master && git push origin master
```
If the push is rejected with a server error, retry up to three times (GitHub hiccups seen today).

- [ ] **Step 5: Install through the updater and verify on the real machine**

Run: `~/.claude/scripts/claude-addons-update.sh --force && ls ~/.claude/history-panel ~/.vscode/extensions/claude-history && grep -n scrollback ~/Library/Application\ Support/Code/User/settings.json`
Expected: files present; scrollback 50000. Then ask the owner to Reload Window and check, in the running VS Code: the History view follows terminals; a new message produces a card whose summary arrives within about a minute; the push row from today's work appears in this session; a technical row expands; a card click jumps; "פתח את ההודעה המלאה" opens the entry.
