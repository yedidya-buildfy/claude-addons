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
  let cur = null, model = null, lastCall = null, carry = null;
  const nextPrompt = (i) => { for (let j = i + 1; j < lines.length; j++) { const t = promptText(lines[j]); if (t) return t; } return null; };

  for (let i = 0; i < lines.length; i++) {
    const d = lines[i];
    const text = promptText(d);
    if (text !== null) {
      const start = carry ?? (cur ? cur.ctx[1] : 0);
      carry = null;
      cur = { uuid: d.uuid, at: d.timestamp, prompt: text, reply: [], cost: 0, tokens: { read: 0, fresh: 0, written: 0 }, ctx: [start, start], rows: [], running: true };
      entries.push(cur);
      continue;
    }
    if (d.type === "system" && d.subtype === "compact_boundary") {
      if (cur) cur.rows.push(rowFromCompact(d));
      carry = d.compactMetadata?.postTokens ?? null;    // the next entry starts from the compacted size
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
  const times = lines.map((d) => d.timestamp).filter(Boolean);
  return { entries, first: times[0] || null, last: times.at(-1) || null, model };
}
