// Shows the focused terminal's Claude session history in a panel view.
// All rules live in ~/.claude/history-panel/history.mjs; this file only finds
// the session, runs it, and passes clicks back.
const vscode = require("vscode");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile, execFileSync } = require("child_process");

const HOME = os.homedir();
const STATE = path.join(HOME, ".claude", "terminal-state");
const CLI = path.join(HOME, ".claude", "history-panel", "history.mjs");
const STICKY = path.join(HOME, ".claude", "scripts", "sticky-claude");
const SAFE = /^[\w./-]{1,80}$/;
const read = (f) => { try { return fs.readFileSync(f, "utf8").trim(); } catch { return ""; } };
// A GUI-launched VS Code may not have node on PATH; the add-on records where it is.
const recorded = read(path.join(HOME, ".claude", "history-panel", "node-path"));
const NODE = recorded && fs.existsSync(recorded) ? recorded : "node";   // a node upgrade can move it
const ps = (args) => { try { return execFileSync("ps", args, { encoding: "utf8" }); } catch { return ""; } };

// Mirror of tab-status's sessionTty: the shell's process subtree may paint on a
// second pty (sticky-claude); the tty that owns a live session wins.
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
  constructor() { this.view = null; this.session = null; this.record = null; this.watcher = null; this.timer = null; this.busy = false; this.again = false; }

  resolveWebviewView(view) {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = fs.readFileSync(path.join(__dirname, "view.html"), "utf8");
    view.webview.onDidReceiveMessage((m) => this.onMessage(m));
    view.onDidChangeVisibility(() => view.visible && this.follow(true));
    this.font();
    this.follow(true);
  }

  async follow(force = false) {
    if (!this.view || !this.view.visible) return;   // hidden or never opened: no process scans
    const term = vscode.window.activeTerminal;
    const pid = term && (await term.processId);
    const id = pid ? sessionOf(pid) : null;
    if (id === this.session && !force) return;
    if (id !== this.session) this.unwatch();
    this.session = id;
    this.refresh();
  }

  unwatch() {
    if (this.watcher) this.watcher.close();
    this.watcher = null;
    this.record = null;
  }

  refresh() {
    if (!this.view || !this.view.visible) return;
    if (!this.session) return this.post({ empty: "אין שיחה של קלוד בטרמינל הזה" });
    if (this.busy) { this.again = true; return; }
    this.busy = true;
    const id = this.session;
    execFile(NODE, [CLI, "build", id], { maxBuffer: 64 << 20, timeout: 20000 }, (err, out) => {
      this.busy = false;
      if (id !== this.session) return this.refresh();
      let data;
      try { data = JSON.parse(out); } catch { data = { error: err ? `ההיסטוריה לא נטענה: ${String(err.message).split("\n")[0]}` : "ההיסטוריה לא נטענה" }; }
      this.post(data);
      // A new session writes its record only at the first prompt: look again shortly.
      if (data.pending || (!data.record && data.error)) { clearTimeout(this.timer); this.timer = setTimeout(() => this.refresh(), 3000); }
      if (data.record && data.record !== this.record) {
        this.unwatch();
        this.record = data.record;
        try { this.watcher = fs.watch(data.record, () => { clearTimeout(this.timer); this.timer = setTimeout(() => this.refresh(), 500); }); } catch {}
      }
      // Summaries land in the cache a little after a turn ends; look again once they could be there.
      if (data.turns && data.turns.some((t) => !t.summarized && !t.running)) { clearTimeout(this.timer); this.timer = setTimeout(() => this.refresh(), 15000); }
      if (this.again) { this.again = false; this.refresh(); }
    });
  }

  post(data) {
    if (!this.view) return;
    this.view.webview.postMessage({ type: "data", data });
    // The view's title line carries the session's totals, like the status line.
    this.view.description = data.turns ? `${data.name} · $${Number(data.cost).toFixed(2)} · ${data.minutes}m · ${data.ctxPct}%` : "";
  }

  // Text the size of the terminal, where Claude Code's own text is.
  font() {
    const size = vscode.workspace.getConfiguration("terminal.integrated").get("fontSize") || vscode.workspace.getConfiguration("editor").get("fontSize") || 12;
    if (this.view) this.view.webview.postMessage({ type: "font", size });
  }

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
    execFile(NODE, [CLI, "entry", this.session, String(n)], { maxBuffer: 16 << 20 }, async (err, md) => {
      const doc = await vscode.workspace.openTextDocument({ content: err ? "ההודעה לא נטענה." : md, language: "markdown" });
      vscode.window.showTextDocument(doc, { preview: true, viewColumn: vscode.ViewColumn.Active });
    });
  }
}

// Once per machine: offer to put History next to the terminal. VS Code lets an extension
// move its view into the terminal's area but not choose its side, and a forced move could
// undo where the person already dragged it, so it asks instead of moving on its own.
async function offerPlacement(ctx) {
  if (ctx.globalState.get("claudeHistory.placed")) return;
  await ctx.globalState.update("claudeHistory.placed", true);
  const yes = "ליד הטרמינל";
  const pick = await vscode.window.showInformationMessage("לשים את חלון ההיסטוריה ליד הטרמינל?", yes, "לא עכשיו");
  if (pick !== yes) return;
  try {
    await vscode.commands.executeCommand("vscode.moveViews", { viewIds: ["claudeHistory.view"], destinationId: "workbench.panel.terminal" });
  } catch {
    vscode.window.showInformationMessage("גרור את הלשונית History אל אזור הטרמינל.");
  }
}

function activate(ctx) {
  const view = new HistoryView();
  ctx.subscriptions.push(
    vscode.window.registerWebviewViewProvider("claudeHistory.view", view, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.window.onDidChangeActiveTerminal(() => view.follow()),
    vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration("terminal.integrated.fontSize") && view.font()),
    { dispose: () => view.unwatch() },
  );
  offerPlacement(ctx);
  const tick = setInterval(() => view.follow(), 3000);    // a session can start in an already-focused terminal
  ctx.subscriptions.push({ dispose: () => clearInterval(tick) });
}

module.exports = { activate, deactivate() {} };
