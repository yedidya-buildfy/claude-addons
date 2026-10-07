#!/usr/bin/env node
// history-panel CLI. build <session>: the panel's JSON. entry <session> <n>: one
// entry as Markdown. summarize <session> | --hook: fill missing summaries (Task 5).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { readLines, parseSession, promptText } from "./lib/record.mjs";

const HOME = os.homedir();
// Sessions live under the config folder in use: ~/.claude, a CLAUDE_CONFIG_DIR, or ccx's own.
const PROJECTS = process.env.HISTORY_PROJECTS ? [process.env.HISTORY_PROJECTS]
  : [...new Set([process.env.CLAUDE_CONFIG_DIR, path.join(HOME, ".claude"), path.join(HOME, ".claude-ccx")].filter(Boolean).map((d) => path.join(d, "projects")))];
const STATE = process.env.HISTORY_STATE || path.join(HOME, ".claude", "terminal-state");
export const CACHE = process.env.HISTORY_CACHE || path.join(HOME, ".claude", "history-panel", "cache");
const STATUSLINE = path.resolve(process.env.HISTORY_STATUSLINE || path.join(HOME, ".claude", "gsd-statusline.js"));
const SAFE = /^[\w-]{1,80}$/;

const { usageCost } = createRequire(import.meta.url)(STATUSLINE);
const price = (model, u) => usageCost(model, u);

export function findRecord(id) {
  if (!SAFE.test(id)) return null;
  for (const root of PROJECTS) {
    for (const dir of fs.existsSync(root) ? fs.readdirSync(root) : []) {
      const f = path.join(root, dir, `${id}.jsonl`);
      if (fs.existsSync(f)) return f;
    }
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

function load(id, { finished = false } = {}) {
  const record = findRecord(id);
  if (!record) return null;
  const { lines, bad } = readLines(record);
  const subagentDir = path.join(path.dirname(record), id, "subagents");
  return { record, bad, ...parseSession(lines, { price, subagentDir, finished }) };
}

export function build(id) {
  const s = load(id);
  if (!s) return { pending: true, empty: "עוד לא נשלחה הודעה בשיחה הזו" };
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
  const busy = fs.existsSync(path.join(CACHE, `${id}.lock`));
  if (missing && !busy && !process.env.HISTORY_NO_SPAWN) spawn(process.execPath, [new URL(import.meta.url).pathname, "summarize", id], { detached: true, stdio: "ignore" }).unref();
  const last = s.entries.at(-1);
  return {
    name: (fs.existsSync(path.join(STATE, `${id}.name`)) && fs.readFileSync(path.join(STATE, `${id}.name`), "utf8").trim()) || id.slice(0, 8),
    minutes: s.first && s.last ? Math.round((Date.parse(s.last) - Date.parse(s.first)) / 60000) : 0,
    cost: Math.round(s.entries.reduce((a, e) => a + e.cost, 0) * 100) / 100,
    ctxPct: last ? Math.round((last.ctx[1] / window) * 100) : 0, window, bad: s.bad, record: s.record, turns,
  };
}

// A new session holding the conversation up to the end of message n: Claude resumes it
// remembering everything until then and nothing after. The original is not touched.
export function fork(id, n) {
  const record = findRecord(id);
  if (!record) return { error: "לא נמצאה רשומה לשיחה הזו" };
  const raw = fs.readFileSync(record, "utf8").split("\n").filter((l) => l.trim());
  const keep = [];
  let seen = 0, cwd = null;
  for (const l of raw) {
    let d;
    try { d = JSON.parse(l); } catch { continue; }
    if (promptText(d) !== null && ++seen > n) break;
    if (d.type === "last-prompt" || d.type === "summary") continue;   // they point at messages the copy may not have
    cwd = d.cwd || cwd;
    keep.push(d);
  }
  if (!Number.isInteger(n) || n < 1 || seen < n) return { error: "אין הודעה כזו בשיחה" };
  const fresh = randomUUID();
  const out = path.join(path.dirname(record), `${fresh}.jsonl`);
  fs.writeFileSync(out, keep.map((d) => JSON.stringify("sessionId" in d ? { ...d, sessionId: fresh } : d)).join("\n") + "\n", { flag: "wx" });
  return { id: fresh, record: out, cwd };
}

export function entryMarkdown(id, n) {
  const s = load(id);
  const e = s?.entries[n - 1];
  if (!e) return "לא נמצאה ההודעה הזו.";
  const rows = e.rows.map((r) => `- ${r.fail ? "✕ " : ""}${r.what} · ${r.detail}\n${r.more.map(([a, b]) => `  - ${a}: ${b}`).join("\n")}`).join("\n");
  return `# #${n} · ${hhmm(e.at)}\n\n## ביקשת\n\n${e.prompt}\n\n## התשובה\n\n${e.reply.join("\n\n") || "—"}\n\n## פעולות\n\n${rows || "—"}\n`;
}

const [cmd, id, arg] = process.argv.slice(2);
if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  if (cmd === "build") process.stdout.write(JSON.stringify(build(id)));
  else if (cmd === "entry") process.stdout.write(entryMarkdown(id, Number(arg)));
  else if (cmd === "fork") process.stdout.write(JSON.stringify(fork(id, Number(arg))));
  else if (cmd === "summarize") {
    if (process.env.HISTORY_PANEL_CHILD) process.exit(0);         // our own `claude -p` fallback
    if (id === "--hook") {                                          // Stop hook: return at once, work detached
      const input = JSON.parse(fs.readFileSync(0, "utf8") || "{}");
      if (SAFE.test(input.session_id || "")) spawn(process.execPath, [new URL(import.meta.url).pathname, "summarize", input.session_id, "--finished"], { detached: true, stdio: "ignore" }).unref();
      process.exit(0);
    }
    const { run } = await import("./lib/summarize.mjs");
    await run(id, { load, readCache, CACHE, finished: arg === "--finished" });
  }
  else { process.stderr.write("usage: history.mjs build|entry|fork|summarize <session> [n]\n"); process.exit(2); }
}
