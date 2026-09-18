// The add-ons engine: reads every <addon>/addon.json, the machine's choices,
// and what it installed last time, then makes the machine match — installing
// what is on, removing exactly what it wrote for what is off, and leaving every
// line it did not write alone. All writes of one apply succeed or none do.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execSync } from "node:child_process";

export const SHELL_BEGIN = "# >>> claude-addons (managed — change with `addons`, not by hand) >>>";
export const SHELL_END = "# <<< claude-addons <<<";

export function paths(home = process.env.HOME, repo) {
  const state = path.join(home, ".claude", "addons");
  const vscodeDir = path.join(home, "Library", "Application Support", "Code", "User");
  return {
    home, repo,
    state, config: path.join(state, "config.json"), record: path.join(state, "state.json"),
    lock: path.join(state, "lock"), backups: path.join(state, "backups"),
    zshrc: path.join(home, ".zshrc"),
    claudeMd: path.join(home, ".claude", "CLAUDE.md"),
    profiles: [path.join(home, ".claude"), path.join(home, ".claude-ccx")],
    vscodeDir,
    vscodeSettings: path.join(vscodeDir, "settings.json"),
    vscodeKeybindings: path.join(vscodeDir, "keybindings.json"),
  };
}

const expand = (p, P) => (p.startsWith("~/") ? path.join(P.home, p.slice(2)) : p);
const sha = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
// key order does not matter: other tools rewrite these files in their own order
const canon = (v) => JSON.stringify(v, (k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((key) => [key, x[key]])) : x));
const same = (a, b) => canon(a) === canon(b);
const readText = (f) => { try { return fs.readFileSync(f, "utf8"); } catch { return null; } };

// ---------------------------------------------------------------- manifests

export function loadManifests(repo) {
  const out = [];
  for (const dir of fs.readdirSync(repo).sort()) {
    const file = path.join(repo, dir, "addon.json");
    if (!fs.existsSync(file)) continue;
    const m = JSON.parse(fs.readFileSync(file, "utf8"));
    m.dir = path.join(repo, dir);
    m.order ??= 500;
    m.settings ??= [];
    out.push(m);
  }
  const ids = new Set();
  for (const m of out) {
    if (!m.id || ids.has(m.id)) throw new Error(`addon.json in ${m.dir}: missing or duplicate id`);
    ids.add(m.id);
  }
  return out.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}

function has(cond, P) {
  if (cond === "vscode") return fs.existsSync(P.vscodeDir);
  if (cond === "jq") {
    if (process.env.ADDONS_ASSUME) return process.env.ADDONS_ASSUME.split(",").includes("jq");
    try { execSync("command -v jq", { stdio: "ignore", shell: "/bin/sh" }); return true; } catch { return false; }
  }
  throw new Error(`unknown condition: ${cond}`);
}

function detect(rule, P) {
  if (!rule) return false;
  if (rule.any) return rule.any.some((r) => detect(r, P));
  if (rule.file) return fs.existsSync(expand(rule.file, P));
  if (rule.shellContains) return (readText(P.zshrc) || "").includes(rule.shellContains);
  if (rule.claudeMdContains) return (readText(P.claudeMd) || "").includes(rule.claudeMdContains);
  return false;
}

// ---------------------------------------------------------------- choices

export function loadConfig(P) {
  const text = readText(P.config);
  return text ? JSON.parse(text) : null;
}

// A machine that has never chosen gets its choices from what is on disk, so
// moving to the engine switches nothing on or off by itself.
export function migrateConfig(manifests, P) {
  const cfg = { version: 1, enabled: {}, settings: {} };
  for (const m of manifests) {
    if (m.required) continue;
    cfg.enabled[m.id] = detect(m.detect, P);
    for (const s of m.settings) {
      if (s.detect) (cfg.settings[m.id] ??= {})[s.key] = detect(s.detect, P);
    }
  }
  // nothing installed at all = a fresh machine: every add-on takes its default
  if (!Object.values(cfg.enabled).some(Boolean)) return { version: 1, enabled: {}, settings: {} };
  return cfg;
}

// engine/defaults.json is pushed to every machine ONCE per version: it overwrites
// that machine's choices a single time, and from then on the machine's own
// choices rule (the version it adopted is recorded in its config).
export function adoptDefaults(manifests, cfg, P) {
  const text = readText(path.join(P.repo, "engine", "defaults.json"));
  if (!text) return false;
  const d = JSON.parse(text);
  if ((cfg.defaultsVersion ?? 0) >= d.version) return false;
  for (const m of manifests) {
    if (m.required || !(m.id in d.enabled)) continue;
    const v = d.enabled[m.id];
    cfg.enabled[m.id] = v === "if-installed" ? detect(m.detect, P) : !!v;
  }
  for (const [id, vals] of Object.entries(d.settings || {})) Object.assign((cfg.settings[id] ??= {}), vals);
  cfg.defaultsVersion = d.version;
  return true;
}

export function resolve(manifests, cfg, P) {
  const enabled = {};
  const values = {};
  for (const m of manifests) {
    enabled[m.id] = m.required ? true : (cfg.enabled[m.id] ?? m.default ?? false);
    values[m.id] = {};
    for (const s of m.settings) {
      values[m.id][s.key] = s.file
        ? (readText(expand(s.file, P)) || "").trim()
        : (cfg.settings?.[m.id]?.[s.key] ?? s.default);
    }
  }
  for (const m of manifests) {
    if (!enabled[m.id]) continue;
    for (const dep of m.requires || []) {
      if (!enabled[dep]) throw new Error(`"${m.id}" needs "${dep}" to be on`);
    }
  }
  return { enabled, values };
}

// ---------------------------------------------------------------- desired state

function render(text, m, values) {
  return text.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    const s = m.settings.find((x) => x.key === key);
    if (!s) throw new Error(`${m.id}: unknown placeholder {{${key}}}`);
    const v = values[key];
    return s.render ? s.render[String(v)] ?? "" : String(v ?? "");
  });
}

function snippetJson(m, file) {
  return JSON.parse(fs.readFileSync(path.join(m.dir, file), "utf8"));
}

function claudeMdText(m) {
  const raw = fs.readFileSync(path.join(m.dir, m.claudeMd.file), "utf8");
  const fenced = raw.match(/^```markdown\n([\s\S]*?)\n```$/m);
  return (fenced ? fenced[1] : raw).trim();
}

function desired(m, values, P) {
  const d = { files: [], dirs: [], claude: [], vscodeSettings: null, vscodeKeybindings: null, shell: null, claudeMd: null };
  for (const f of m.files || []) {
    if (f.when && !has(f.when, P)) continue;
    d.files.push({ to: expand(f.to, P), from: path.join(m.dir, f.from), mode: f.mode ? parseInt(f.mode, 8) : 0o644 });
  }
  d.dirs = (m.dirs || []).map((x) => expand(x, P));
  for (const c of m.claudeSettings || []) {
    if (c.when && !has(c.when, P)) continue;
    d.claude.push(snippetJson(m, c.file));
  }
  if (m.vscodeSettings && has("vscode", P)) d.vscodeSettings = snippetJson(m, m.vscodeSettings);
  if (m.vscodeKeybindings && has("vscode", P)) d.vscodeKeybindings = snippetJson(m, m.vscodeKeybindings);
  if (m.shell) d.shell = render(fs.readFileSync(path.join(m.dir, m.shell), "utf8"), m, values).trimEnd();
  if (m.claudeMd && values[m.claudeMd.setting]) d.claudeMd = claudeMdText(m);
  return d;
}

// ---------------------------------------------------------------- JSON ops
//
// A snippet becomes a list of ops: an array item at a path, or a leaf value at
// a path (with the value it replaced). Removing an add-on undoes exactly its
// ops, so keys and hooks other tools put in the same file are never touched.

function toOps(snippet, base = []) {
  const ops = [];
  if (Array.isArray(snippet)) {
    for (const item of snippet) ops.push({ path: base, item });
    return ops;
  }
  for (const [k, v] of Object.entries(snippet)) {
    const p = [...base, k];
    if (Array.isArray(v)) for (const item of v) ops.push({ path: p, item });
    else if (v && typeof v === "object") ops.push(...toOps(v, p));
    else ops.push({ path: p, value: v });
  }
  return ops;
}

const opKey = (op) => canon([op.path, "item" in op ? ["i", op.item] : ["v", op.value]]);

function getAt(doc, p) {
  let cur = doc;
  for (const k of p) { if (cur == null || typeof cur !== "object") return undefined; cur = cur[k]; }
  return cur;
}

function ensureParent(doc, p) {
  let cur = doc;
  for (const k of p.slice(0, -1)) {
    if (cur[k] == null || typeof cur[k] !== "object" || Array.isArray(cur[k])) cur[k] = {};
    cur = cur[k];
  }
  return cur;
}

// Drop containers along the path that the removal left empty.
function prune(doc, p) {
  for (let i = p.length; i > 0; i--) {
    const parent = getAt(doc, p.slice(0, i - 1));
    if (!parent || typeof parent !== "object") return;
    const v = parent[p[i - 1]];
    if (v === undefined) continue;
    const empty = Array.isArray(v) ? v.length === 0 : v && typeof v === "object" && Object.keys(v).length === 0;
    if (!empty) return;
    delete parent[p[i - 1]];
  }
}

function addOp(doc, op, prev) {
  if ("item" in op) {
    let arr = op.path.length ? getAt(doc, op.path) : doc;
    if (!Array.isArray(arr)) { ensureParent(doc, op.path)[op.path.at(-1)] = arr = []; }
    if (!arr.some((x) => same(x, op.item))) arr.push(clone(op.item));
    return { path: op.path, item: op.item };
  }
  const cur = getAt(doc, op.path);
  if (prev) { // ours already; keep the value it originally replaced
    ensureParent(doc, op.path)[op.path.at(-1)] = op.value;
    return prev;
  }
  const rec = { path: op.path, value: op.value, hadPrior: cur !== undefined, prior: clone(cur) };
  if (same(cur, op.value)) rec.hadPrior = false; // already there: treat as ours, removal deletes it
  ensureParent(doc, op.path)[op.path.at(-1)] = op.value;
  return rec;
}

function removeOp(doc, rec) {
  if ("item" in rec) {
    const arr = rec.path.length ? getAt(doc, rec.path) : doc;
    if (!Array.isArray(arr)) return;
    const i = arr.findIndex((x) => same(x, rec.item));
    if (i >= 0) arr.splice(i, 1);
  } else {
    if (!same(getAt(doc, rec.path), rec.value)) return; // someone changed it since: theirs now
    const parent = getAt(doc, rec.path.slice(0, -1));
    if (rec.hadPrior) parent[rec.path.at(-1)] = rec.prior;
    else delete parent[rec.path.at(-1)];
  }
  if (rec.path.length) prune(doc, rec.path);
}

// Hooks an add-on wrote under an older snippet (before the engine kept a record)
// are recognised by their command and removed unless still wanted.
function stripOwned(doc, regexes, keep) {
  if (!regexes.length || !doc.hooks) return;
  for (const event of Object.keys(doc.hooks)) {
    const entries = doc.hooks[event];
    if (!Array.isArray(entries)) continue;
    doc.hooks[event] = entries.map((entry) => {
      if (keep.has(canon(entry)) || !Array.isArray(entry.hooks)) return entry;
      const hooks = entry.hooks.filter((h) => !regexes.some((r) => r.test(h.command || "")));
      return hooks.length === entry.hooks.length ? entry : { ...entry, hooks };
    }).filter((entry) => !Array.isArray(entry.hooks) || entry.hooks.length);
    if (!doc.hooks[event].length) delete doc.hooks[event];
  }
  if (!Object.keys(doc.hooks).length) delete doc.hooks;
}

function parseJson(file, text) {
  const stripped = text.replace(/^\s*\/\/.*$/gm, "");
  if (!stripped.trim()) return null;
  try { return JSON.parse(stripped); } catch (e) {
    throw new Error(`${file} is not valid JSON (${e.message}) — fix it by hand, nothing was changed`);
  }
}

// ---------------------------------------------------------------- shell + CLAUDE.md

// The tn function the very first tab-status installer wrote, removed by exact text.
const LEGACY_TN = `tn() {
  local state_dir="$HOME/.claude/terminal-state"
  mkdir -p "$state_dir"
  local tty_dev=$(ps -o tty= -p $$ 2>/dev/null | tr -d ' ')
  [ -n "$tty_dev" ] && [ "$tty_dev" != "??" ] || { echo "tn: no TTY" >&2; return 1; }
  if [ -z "$1" ]; then
    rm -f "$state_dir/tty.$tty_dev.name"
    printf '\\033]0;\\a'
  else
    echo "$1" > "$state_dir/tty.$tty_dev.name"
    printf '\\033]0;🟢 %s\\a' "$1"
  fi
}`;

// Every code line an add-on ever appended to ~/.zshrc before the engine.
const LEGACY_LINES = [
  /^alias claude=".*\/\.claude\/scripts\/(sticky-claude|ccx --as-claude --)"$/,
  /^alias fplans?=/,
  /^tn\(\) \{ "\$HOME\/\.claude\/scripts\/tn" "\$@"; \}$/,
  /^case ":\$PATH:" in$/, /^\*":\$HOME\/\.claude\/scripts:"\*\) ;;$/,
  /^\*\) export PATH="\$HOME\/\.claude\/scripts:\$PATH" ;;$/, /^esac$/,
  /^if \[\[ -o interactive && -t 0 && -t 1 && -z "\$ZSH_EXECUTION_STRING" \\$/,
  /^&& -z "\$CLAUDECODE" && -z "\$CLAUDE_AUTOSTARTED" && -z "\$CLAUDE_AUTOSTART_OFF" \\$/,
  /^&& -z "\$VSCODE_RESOLVING_ENVIRONMENT" && -z "\$SSH_CONNECTION" \]\]; then$/,
  /^export CLAUDE_AUTOSTARTED=1$/, /^claude --dangerously-skip-permissions$/, /^fi$/,
];

// Before the engine, each add-on appended its own paragraph to ~/.zshrc. A
// paragraph is removed only when every command in it is one of ours; its
// comments go with it. A paragraph mixing in anything else is left alone.
export function stripLegacyShell(text) {
  const removed = [];
  if (text.includes(LEGACY_TN)) { text = text.replace(LEGACY_TN + "\n", "").replace(LEGACY_TN, ""); removed.push(LEGACY_TN); }
  const lines = text.split("\n");
  const out = [];
  for (let i = 0; i < lines.length;) {
    if (!lines[i].trim()) { out.push(lines[i++]); continue; }
    let j = i;
    while (j < lines.length && lines[j].trim()) j++;
    const para = lines.slice(i, j);
    const code = para.filter((l) => !l.trim().startsWith("#"));
    const allOurs = code.every((l) => LEGACY_LINES.some((r) => r.test(l.trim())));
    const marked = para.some((l) => /^#.*claude-addons/.test(l));
    if (allOurs && (code.length > 0 || marked)) {
      removed.push(para.join("\n"));
      // drop the gap before it too, so no double gap is left behind
      while (out.length && !out.at(-1).trim() && (j >= lines.length || !lines[j].trim())) out.pop();
    } else out.push(...para);
    i = j;
  }
  return { text: out.join("\n"), removed };
}

export function shellBlock(parts) {
  return [SHELL_BEGIN, ...parts.map((p) => p.trim()).filter(Boolean).flatMap((p) => [p, ""]).slice(0, -1), SHELL_END].join("\n");
}

function withShellBlock(text, block) {
  const a = text.indexOf(SHELL_BEGIN);
  const b = text.indexOf(SHELL_END);
  if (a >= 0 && b > a) {
    if (block == null) return { text: (text.slice(0, a).replace(/\n+$/, "\n") + text.slice(b + SHELL_END.length).replace(/^\n+/, "")), removed: [] };
    return { text: text.slice(0, a) + block + text.slice(b + SHELL_END.length), removed: [] };
  }
  const { text: clean, removed } = stripLegacyShell(text);
  if (block == null) return { text: clean, removed };
  return { text: clean.replace(/\n*$/, "") + (clean.trim() ? "\n\n" : "") + block + "\n", removed };
}

const mdBegin = (id) => `<!-- claude-addons:${id} -->`;
const mdEnd = (id) => `<!-- /claude-addons:${id} -->`;

function withMdBlock(text, id, body) {
  const a = text.indexOf(mdBegin(id));
  const b = text.indexOf(mdEnd(id));
  if (a >= 0 && b > a) {
    const before = text.slice(0, a), after = text.slice(b + mdEnd(id).length);
    if (body == null) return (before.replace(/\n+$/, "\n") + after.replace(/^\n+/, "\n")).replace(/^\n/, "");
    return before + `${mdBegin(id)}\n${body}\n${mdEnd(id)}` + after;
  }
  if (body == null) return text;
  const wrapped = `${mdBegin(id)}\n${body}\n${mdEnd(id)}`;
  if (text.includes(body)) return text.replace(body, wrapped); // written before the engine: adopt it
  return text.replace(/\n*$/, "") + (text.trim() ? "\n\n" : "") + wrapped + "\n";
}

// ---------------------------------------------------------------- transaction

class Tx {
  constructor(P, dryRun) {
    this.P = P; this.dryRun = dryRun; this.orig = new Map(); this.changes = [];
    this.stamp = new Date().toISOString().replace(/[:.]/g, "-");
  }
  remember(file) {
    if (this.orig.has(file)) return;
    const exists = fs.existsSync(file);
    this.orig.set(file, exists ? { data: fs.readFileSync(file), mode: fs.statSync(file).mode & 0o777 } : null);
  }
  write(file, data, mode, note) {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const cur = fs.existsSync(file) ? fs.readFileSync(file) : null;
    const curMode = cur ? fs.statSync(file).mode & 0o777 : null;
    if (cur && cur.equals(buf) && (mode == null || curMode === mode)) return false;
    this.changes.push({ action: cur ? "update" : "create", file, note });
    if (this.dryRun) return true;
    this.remember(file);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.addons-tmp-${process.pid}`;
    fs.writeFileSync(tmp, buf, { mode: mode ?? curMode ?? 0o644 });
    fs.chmodSync(tmp, mode ?? curMode ?? 0o644);
    if (process.env.ADDONS_FAIL_ON && file.endsWith(process.env.ADDONS_FAIL_ON)) {
      fs.rmSync(tmp); throw new Error(`injected failure writing ${file}`);
    }
    fs.renameSync(tmp, file);
    return true;
  }
  remove(file, note) {
    if (!fs.existsSync(file)) return;
    this.changes.push({ action: "remove", file, note });
    if (this.dryRun) return;
    this.remember(file);
    fs.rmSync(file);
    const dir = path.dirname(file);
    const keep = [this.P.home, path.join(this.P.home, ".claude"), path.join(this.P.home, ".claude", "scripts"), path.join(this.P.home, ".claude", "skills"), path.join(this.P.home, ".vscode", "extensions")];
    if (!keep.includes(dir)) { try { fs.rmdirSync(dir); } catch {} }
  }
  // Every file this apply touched, as it was before, kept for manual recovery.
  saveBackup() {
    if (this.dryRun || !this.orig.size) return null;
    const dir = path.join(this.P.backups, this.stamp);
    if (![...this.orig.values()].some(Boolean)) return null; // only new files: nothing to keep
    for (const [file, o] of this.orig) {
      if (!o) continue;
      const dest = path.join(dir, path.relative(this.P.home, file));
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, o.data, { mode: 0o600 });
    }
    const all = fs.readdirSync(this.P.backups).sort();
    for (const old of all.slice(0, Math.max(0, all.length - 10))) fs.rmSync(path.join(this.P.backups, old), { recursive: true, force: true });
    return dir;
  }
  rollback() {
    for (const [file, o] of this.orig) {
      try {
        if (o) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, o.data); fs.chmodSync(file, o.mode); }
        else fs.rmSync(file, { force: true });
      } catch {}
    }
  }
}

// ---------------------------------------------------------------- lock

function sleep(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

export function withLock(P, fn, waitMs = 30000) {
  fs.mkdirSync(P.state, { recursive: true });
  const deadline = Date.now() + waitMs;
  for (;;) {
    try { fs.writeFileSync(P.lock, String(process.pid), { flag: "wx" }); break; } catch (e) {
      if (e.code !== "EEXIST") throw e;
      const pid = Number(readText(P.lock));
      let alive = false;
      try { process.kill(pid, 0); alive = pid > 0; } catch {}
      if (!alive) { fs.rmSync(P.lock, { force: true }); continue; }
      if (Date.now() > deadline) throw new Error(`another add-ons change is running (pid ${pid}) — try again in a moment`);
      sleep(200);
    }
  }
  try { return fn(); } finally { fs.rmSync(P.lock, { force: true }); }
}

// ---------------------------------------------------------------- apply

function dirHash(dir) {
  const h = crypto.createHash("sha256");
  const walk = (d) => {
    for (const name of fs.readdirSync(d).sort()) {
      if (name === "__pycache__" || name.startsWith(".")) continue;
      const f = path.join(d, name);
      if (fs.statSync(f).isDirectory()) walk(f);
      else h.update(name).update(fs.readFileSync(f));
    }
  };
  walk(dir);
  return h.digest("hex");
}

export function apply({ P, manifests, cfg, dryRun = false, run = !process.env.ADDONS_NO_RUN, removeAll = false }) {
  const record = JSON.parse(readText(P.record) || '{"addons":{}}');
  const { enabled, values } = resolve(manifests, cfg, P);
  if (removeAll) for (const id of Object.keys(enabled)) enabled[id] = false;
  const tx = new Tx(P, dryRun);
  const notes = [];
  const next = { addons: {} }; // what this apply leaves installed, per add-on
  const byId = Object.fromEntries(manifests.map((m) => [m.id, m]));
  const want = {};
  for (const m of manifests) if (enabled[m.id]) want[m.id] = desired(m, values[m.id], P);

  try {
    // file-backed settings (e.g. the ntfy topic) live in their own file
    for (const m of manifests) {
      for (const s of m.settings) {
        if (!s.file) continue;
        let v = cfg.settings?.[m.id]?.[s.key];
        if (v == null && enabled[m.id] && s.generate === "ntfy" && !values[m.id][s.key]) {
          v = "cc-" + crypto.randomBytes(8).toString("hex");
        }
        if (v != null && v !== values[m.id][s.key]) tx.write(expand(s.file, P), String(v), 0o600, `${m.id}: ${s.key}`);
        if (cfg.settings?.[m.id]) delete cfg.settings[m.id][s.key]; // its file is the only copy
      }
    }

    // files
    const ids = new Set([...Object.keys(record.addons), ...Object.keys(want)]);
    for (const id of ids) {
      const prev = record.addons[id]?.files || {};
      const files = {};
      const wanted = new Set((want[id]?.files || []).map((f) => f.to));
      for (const [file, hash] of Object.entries(prev)) {
        if (wanted.has(file) || !fs.existsSync(file)) continue;
        if (sha(fs.readFileSync(file)) === hash) tx.remove(file, id);
        else notes.push(`${id}: left ${file} in place — it was edited by hand`);
      }
      for (const f of want[id]?.files || []) {
        const data = fs.readFileSync(f.from);
        const cur = fs.existsSync(f.to) ? sha(fs.readFileSync(f.to)) : null;
        if (cur && prev[f.to] && cur !== prev[f.to] && cur !== sha(data)) {
          notes.push(`${id}: ${f.to} had local edits — replaced, the old copy is in the backup`);
        }
        tx.write(f.to, data, f.mode, id);
        files[f.to] = sha(data);
      }
      for (const d of want[id]?.dirs || []) if (!dryRun) fs.mkdirSync(d, { recursive: true });
      if (want[id] || Object.keys(files).length) next.addons[id] = { files };
    }

    // JSON targets
    const targets = [];
    for (const profile of P.profiles) {
      if (profile !== P.profiles[0] && !fs.existsSync(profile)) continue;
      targets.push({ file: path.join(profile, "settings.json"), key: "claude", indent: 2, claude: true });
    }
    if (fs.existsSync(P.vscodeDir)) {
      targets.push({ file: P.vscodeSettings, key: "vscodeSettings", indent: 4 });
      targets.push({ file: P.vscodeKeybindings, key: "vscodeKeybindings", indent: 4, array: true });
    }
    for (const t of targets) {
      const text = readText(t.file);
      const before = text == null ? null : parseJson(t.file, text);
      const doc = clone(before) ?? (t.array ? [] : {});
      const snippets = (id) => {
        const s = want[id]?.[t.key];
        return s == null ? [] : Array.isArray(s) && t.key === "claude" ? s : [s];
      };
      const desiredOps = Object.fromEntries(Object.keys(want).map((id) => [id, snippets(id).flatMap((s) => toOps(s))]));
      // 1. undo recorded ops that are no longer wanted
      for (const [id, a] of Object.entries(record.addons)) {
        const keep = new Set((desiredOps[id] || []).map(opKey));
        for (const rec of a.json?.[t.file] || []) if (!keep.has(opKey(rec))) removeOp(doc, rec);
      }
      // 2. hooks from before the engine kept a record
      if (t.claude) {
        const regexes = manifests.filter((m) => m.ownsCommands).map((m) => new RegExp(m.ownsCommands));
        const keep = new Set(Object.values(desiredOps).flat().filter((o) => "item" in o).map((o) => canon(o.item)));
        stripOwned(doc, regexes, keep);
      }
      // 3. add what is wanted
      for (const [id, ops] of Object.entries(desiredOps)) {
        if (!ops.length) continue;
        const prevRecs = new Map((record.addons[id]?.json?.[t.file] || []).map((r) => [opKey(r), r]));
        const recs = ops.map((op) => addOp(doc, op, prevRecs.get(opKey(op))));
        ((next.addons[id] ??= { files: {} }).json ??= {})[t.file] = recs;
      }
      // a settings file the engine created is deleted again once nothing is left in it
      const empty = t.array ? doc.length === 0 : Object.keys(doc).length === 0;
      const created = record.created?.includes(t.file) || (before == null && !empty);
      if (created && empty) tx.remove(t.file, t.key);
      else if (!same(doc, before) && !(before == null && empty)) tx.write(t.file, JSON.stringify(doc, null, t.indent) + "\n", null, t.key);
      if (created && !empty) (next.created ??= []).push(t.file);
    }

    // ~/.zshrc: one managed block, in declared order
    const zsh = readText(P.zshrc) || "";
    const parts = manifests.filter((m) => want[m.id]?.shell).map((m) => want[m.id].shell);
    const block = parts.length ? shellBlock(parts) : null;
    const { text: zshNext, removed } = withShellBlock(zsh, block);
    for (const r of removed) notes.push(`moved into the managed block: "${r.split("\n")[0]}…"`);
    tx.write(P.zshrc, zshNext, null, "shell");

    // ~/.claude/CLAUDE.md: one marked block per add-on that asks for one
    const mdIds = manifests.filter((m) => m.claudeMd).map((m) => m.id);
    const mdText = readText(P.claudeMd);
    if (mdText != null || mdIds.some((id) => want[id]?.claudeMd)) {
      let md = mdText || "";
      for (const id of mdIds) md = withMdBlock(md, id, want[id]?.claudeMd ?? null);
      tx.write(P.claudeMd, md, null, "CLAUDE.md");
    }
  } catch (e) {
    tx.rollback();
    throw e;
  }

  const backup = tx.saveBackup();

  // run steps (after the files are in place; cannot be rolled back)
  const ran = [];
  for (const m of manifests) {
    const n = (next.addons[m.id] ??= { files: {} });
    const prevHash = record.addons[m.id]?.runHash;
    if (!enabled[m.id] || !m.run) continue;
    const hash = dirHash(m.dir);
    if (m.run.when === "changed" && hash === prevHash) { n.runHash = prevHash; continue; }
    if (dryRun || !run) { if (dryRun) ran.push({ id: m.id, ok: true, planned: true }); n.runHash = prevHash; continue; }
    try {
      execSync(m.run.cmd.replace(/~\//g, P.home + "/"), { cwd: m.dir, stdio: "pipe", shell: "/bin/bash", timeout: 600000, env: { ...process.env, HOME: P.home } });
      n.runHash = hash;
      ran.push({ id: m.id, ok: true });
    } catch (e) {
      n.runHash = prevHash; // try again next time
      ran.push({ id: m.id, ok: false, error: String(e.stderr || e.message).trim().split("\n").slice(-3).join(" ") });
    }
  }
  for (const id of Object.keys(next.addons)) {
    const a = next.addons[id];
    if (!Object.keys(a.files).length && !a.json && !a.runHash) delete next.addons[id];
  }

  if (!dryRun) {
    fs.mkdirSync(P.state, { recursive: true });
    if (removeAll) fs.rmSync(path.join(P.home, ".claude", "addons-repo-path"), { force: true });
    fs.writeFileSync(P.record, JSON.stringify(next, null, 2) + "\n");
    fs.writeFileSync(P.config, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
  }
  return { changes: tx.changes, notes, ran, backup, enabled, byId };
}

// what `addons status` shows: choice vs. what is really on disk
export function status(manifests, cfg, P) {
  const { enabled } = resolve(manifests, cfg, P);
  const record = JSON.parse(readText(P.record) || '{"addons":{}}');
  return manifests.map((m) => {
    const files = Object.entries(record.addons[m.id]?.files || {});
    const missing = files.filter(([f]) => !fs.existsSync(f)).map(([f]) => f);
    const edited = files.filter(([f, h]) => fs.existsSync(f) && sha(fs.readFileSync(f)) !== h).map(([f]) => f);
    return { id: m.id, title: m.title, on: enabled[m.id], required: !!m.required, installed: !!record.addons[m.id], missing, edited };
  });
}
