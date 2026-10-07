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
  "For each numbered turn return {n, title, asked, happened}: title at most 28 characters, whole words; asked = what was wanted, one sentence, " +
  "written as the request itself (never start with 'the user asked' or 'המשתמש ביקש' — the list already labels it 'you asked'); " +
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

// Last resort on machines without the gateway: a headless `claude -p` with every hook
// off (no phone alert, no update check, no recursion into our own Stop hook), without the
// parent session's variables, and in its own folder so its record stays out of the project.
export function fallbackArgs(prompt, parentEnv = process.env) {
  const env = Object.fromEntries(Object.entries(parentEnv).filter(([k]) => k !== "CLAUDECODE" && !k.startsWith("CLAUDE_CODE_")));
  env.HISTORY_PANEL_CHILD = "1";
  return { args: ["-p", "--model", "haiku", "--settings", JSON.stringify({ disableAllHooks: true }), prompt], env };
}

function viaClaude(messages) {
  const dir = path.join(os.homedir(), ".claude", "history-panel", "scratch");
  fs.mkdirSync(dir, { recursive: true });
  const { args, env } = fallbackArgs(`${messages[0].content}\n\n${messages[1].content}`);
  return new Promise((resolve, reject) => execFile("claude", args, { cwd: dir, timeout: 90_000, env }, (err, out) => (err ? reject(err) : resolve(out))));
}

export async function askModel(messages) {
  let last;
  for (const m of MODELS) { try { return await viaGateway(m, messages); } catch (e) { last = e; } }
  try { return await viaClaude(messages); } catch (e) { throw last || e; }
}

// At most n characters, cut at the last whole word.
const fit = (s, n) => { const c = [...s]; if (c.length <= n) return s; const cut = c.slice(0, n + 1).join(""); const i = cut.lastIndexOf(" "); return (i > 0 ? cut.slice(0, i) : c.slice(0, n).join("")).trim(); };

export async function summarizeBatch(items, ask = askModel) {
  const body = items.map((e, i) => [`#${i + 1}`, `USER: ${head(e.prompt, MAX_TEXT)}`,
    `ASSISTANT (final words): ${head(e.reply.slice(-2).join("\n"), 2000)}`,
    `ACTIONS: ${e.rows.map((r) => `${r.what} ${r.detail}`).join("; ") || "none"}`].join("\n")).join("\n\n");
  const answer = parseAnswer(await ask([{ role: "system", content: SYSTEM }, { role: "user", content: body }]));
  const out = {};
  for (const a of answer || []) {
    const e = items[(a.n || 0) - 1];
    if (!e || !a.title) continue;
    out[e.uuid] = { title: fit(String(a.title).trim(), 28), asked: String(a.asked || ""), happened: String(a.happened || "") };
  }
  return out;
}

const AGENT_SYSTEM = "In one short sentence, in Hebrew, plain words: what did this helper agent find or do? Reply with only the sentence.";

const STALE = 10 * 60_000;   // a lock untouched this long belongs to a summarizer that died

// One summarizer per session: the lock is created only if absent (atomic), touched after
// every batch, and removed only by its owner.
function takeLock(lock) {
  for (let i = 0; i < 2; i++) {
    try { fs.writeFileSync(lock, String(process.pid), { flag: "wx" }); return true; } catch (e) {
      if (e.code !== "EEXIST") return false;
      try { if (Date.now() - fs.statSync(lock).mtimeMs < STALE) return false; fs.rmSync(lock, { force: true }); } catch { return false; }
    }
  }
  return false;
}

export async function run(id, { load, readCache, CACHE, ask = askModel, finished = false }) {
  fs.mkdirSync(CACHE, { recursive: true });
  const lock = path.join(CACHE, `${id}.lock`);
  if (!takeLock(lock)) return;
  const mine = { entries: {}, ai: {}, failed: {} };
  const touch = () => { try { const t = new Date(); fs.utimesSync(lock, t, t); } catch {} };
  const save = () => {
    const now = readCache(id);   // someone may have written since we started: merge, never overwrite
    for (const k of ["entries", "ai"]) now[k] = { ...now[k], ...mine[k] };
    now.failed = { ...now.failed, ...mine.failed };
    for (const u of Object.keys(now.entries)) delete now.failed[u];
    const tmp = path.join(CACHE, `${id}.json.${process.pid}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(now));
    fs.renameSync(tmp, path.join(CACHE, `${id}.json`));
  };
  try {
    const s = load(id, { finished });
    if (!s) return;
    const cache = readCache(id);
    const todo = s.entries.filter((e) => !e.running && !cache.entries[e.uuid] && Date.now() - (cache.failed[e.uuid] || 0) > 120_000);
    for (let i = 0; i < todo.length; i += BATCH) {
      const batch = todo.slice(i, i + BATCH);
      let got = {};
      try { got = await summarizeBatch(batch, ask); } catch {}
      for (const e of batch) { if (got[e.uuid]) mine.entries[e.uuid] = got[e.uuid]; else mine.failed[e.uuid] = Date.now(); }
      save();
      touch();
    }
    for (const r of s.entries.flatMap((e) => e.rows).filter((r) => r.aiKey && !cache.ai[r.aiKey])) {
      const facts = r.more.map(([a, b]) => `${a}: ${b}`).join("\n") + (r.result ? `\n\nIts final words:\n${r.result}` : "");
      try { mine.ai[r.aiKey] = (await ask([{ role: "system", content: AGENT_SYSTEM }, { role: "user", content: facts }])).trim().slice(0, 200); } catch {}
      touch();
    }
    save();
  } finally {
    try { if (fs.readFileSync(lock, "utf8") === String(process.pid)) fs.rmSync(lock, { force: true }); } catch {}
  }
}
