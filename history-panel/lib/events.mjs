// history-panel/lib/events.mjs
// Technical rows: facts read from what Claude ran and what came back. Never a model.
import path from "node:path";

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


// A git subcommand as a real command word: start of the command or after && ; | (,
// optionally `git -C <dir>`. Quoted text (echo 'git push', grep "git push") does not match.
const gitCmd = (cmd, sub) => new RegExp(`(?:^|&&|;|\\|\\||\\(|\\bdo\\b)\\s*(?:[A-Z_]+=\\S+\\s+)*git(?:\\s+-C\\s+(\\S+))?\\s+${sub}(?![\\w-])`).exec(cmd);
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
