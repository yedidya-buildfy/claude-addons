// Reads Claude Code's own session logs and turns new replies into weighted
// usage buckets. Incremental: remembers how far each file was read.
import fs from "node:fs";
import path from "node:path";

// $/MTok list prices: input, output, cache write (5 min), cache read.
// ponytail: prefix table, first match wins — add a row when a new model family ships; unknown → Sonnet 5.
export const PRICES = [
  ["claude-fable", 10, 50, 12.5, 0.25],
  ["claude-mythos", 10, 50, 12.5, 0.25],
  ["claude-opus-5-5", 4, 20, 5, 0.2],
  ["claude-opus", 5, 25, 6.25, 0.5],
  ["claude-sonnet-5", 2, 10, 2.5, 0.2],
  ["claude-sonnet", 3, 15, 3.75, 0.3],
  ["claude-haiku", 1, 5, 1.25, 0.1],
];

export function weight(model, u) {
  const p = PRICES.find(([pre]) => model.startsWith(pre)) ?? PRICES[4];
  return ((u.input_tokens || 0) * p[1] + (u.output_tokens || 0) * p[2]
    + (u.cache_creation_input_tokens || 0) * p[3] + (u.cache_read_input_tokens || 0) * p[4]) / 1e6;
}

// Only Claude replies use the plan; ccx provider agents (gpt-*, claude-gemini-*, …) do not.
const CLAUDE = /^claude-(opus|sonnet|haiku|fable|mythos)/;

export const family = (model) => (/fable|mythos/.test(model) ? "f" : /opus/.test(model) ? "o" : /haiku/.test(model) ? "h" : "s");

// Calendar day in the plan's time zone (every machine on a plan counts days by one clock); no zone = this machine's.
const fmt = new Map();
export const dayKey = (d, tz) => {
  if (!fmt.has(tz)) fmt.set(tz, new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }));
  return fmt.get(tz).format(d);
};
// the day `n` days before a YYYY-MM-DD key — pure calendar arithmetic, no clocks or DST involved
export const daysBefore = (key, n) => { const [y, m, d] = key.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d - n)).toISOString().slice(0, 10); };
export const hourKey = (d) => d.toISOString().slice(0, 13); // UTC — compared against the plan's UTC reset times

// Every .jsonl under the folder, once per real file (the ccx profile symlinks the same folder).
function logFiles(root, sinceMs) {
  const out = new Set();
  const walk = (dir, depth) => {
    if (depth > 6) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      let st;
      try { st = fs.statSync(p); } catch { continue; }
      if (st.isDirectory()) walk(p, depth + 1);
      else if (e.name.endsWith(".jsonl") && st.mtimeMs >= sinceMs) out.add(fs.realpathSync(p));
    }
  };
  walk(root, 0);
  return [...out];
}

// Complete lines from `from` to the end of the file, and the offset after the last newline.
// ponytail: reads the whole new tail into memory — fine for session logs (tens of MB), not for GB files.
function readNew(file, from) {
  const fd = fs.openSync(file, "r");
  try {
    const size = fs.fstatSync(fd).size;
    if (size < from) from = 0; // file was rewritten
    const buf = Buffer.alloc(size - from);
    fs.readSync(fd, buf, 0, buf.length, from);
    const end = buf.lastIndexOf(10);
    if (end < 0) return { lines: [], offset: from };
    return { lines: buf.subarray(0, end).toString("utf8").split("\n"), offset: from + end + 1 };
  } finally {
    fs.closeSync(fd);
  }
}

export function collect({ projectsDir, offsets, dev, now = Date.now(), tz }) {
  const since = now - 32 * 86400e3;
  const files = logFiles(projectsDir, since);
  let added = false;
  for (const file of files) {
    const st = offsets[file] ?? { offset: 0, recent: {} };
    if (Array.isArray(st.recent)) st.recent = {}; // state written by the first version
    const { lines, offset } = readNew(file, st.offset);
    for (const text of lines) {
      if (!text.includes('"usage"')) continue;
      let d;
      try { d = JSON.parse(text); } catch { continue; }
      const m = d.message;
      if (!m?.usage || !CLAUDE.test(m.model) || !d.timestamp) continue;
      const t = new Date(d.timestamp);
      if (!(t.getTime() >= since)) continue;
      // The same reply is logged once per content block, and the output count
      // grows between those lines — count the largest, never twice.
      const key = `${m.id}:${d.requestId}`, full = weight(m.model, m.usage), seen = st.recent[key] ?? 0;
      if (full <= seen) continue;
      delete st.recent[key];
      st.recent[key] = full;
      const keys = Object.keys(st.recent);
      if (keys.length > 200) delete st.recent[keys[0]];
      const w = full - seen;
      const day = (dev.days[dayKey(t, tz)] ??= { w: 0, f: 0, o: 0, s: 0, h: 0 });
      day.w += w;
      day[family(m.model)] += w;
      dev.hours[hourKey(t)] = (dev.hours[hourKey(t)] ?? 0) + w;
      added = true;
    }
    if (offset !== st.offset) st.at = now;
    st.offset = offset;
    offsets[file] = st;
  }
  const live = new Set(files);
  for (const f of Object.keys(offsets)) if (!live.has(f)) delete offsets[f];
  return added;
}
