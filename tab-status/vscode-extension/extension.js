// VS Code's own rename pins a static title, and a pinned title makes the editor
// ignore every title escape sequence for that terminal forever — which is the
// channel the status dot is painted on. So we never let the rename reach VS
// Code: this command asks for the name and hands it to `tn`, which owns the
// name file the watcher paints from. The dot keeps updating either way.
const vscode = require("vscode");
const { execFile, execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const SCRIPTS = path.join(os.homedir(), ".claude", "scripts");
const STATE = path.join(os.homedir(), ".claude", "terminal-state");
const LOG = path.join(STATE, "rename-debug.log");
const SAFE = /^[A-Za-z0-9_-]+$/;
const SPLIT_REQUESTS = path.join(STATE, "split-requests");

function log(line) {
  // ponytail: unbounded debug log, kept while the tty resolution is under watch.
  try {
    fs.appendFileSync(LOG, new Date().toISOString() + " " + line + "\n");
  } catch {
    // never let logging break a rename
  }
}

function read(file) {
  try {
    return fs.readFileSync(file, "utf8").trim();
  } catch {
    return "";
  }
}

function ps(args) {
  try {
    return execFileSync("ps", args, { encoding: "utf8", timeout: 2000 });
  } catch {
    return "";
  }
}

function ttyOf(pid) {
  const tty = ps(["-o", "tty=", "-p", String(pid)]).trim();
  return SAFE.test(tty) ? tty : "";
}

// A wrapper such as sticky-claude runs claude inside a second pty, so the shell
// VS Code reports and the terminal the session actually paints on are different
// devices. Search the whole subtree and prefer the tty that owns a session.
function sessionTty(shellPid) {
  const children = new Map();
  const ttys = new Map([[shellPid, ttyOf(shellPid)]]);
  for (const row of ps(["-eo", "pid=,ppid=,tty="]).split("\n")) {
    const [pid, parent, tty] = row.trim().split(/\s+/);
    if (!/^\d+$/.test(pid) || !/^\d+$/.test(parent)) continue;
    children.set(parent, (children.get(parent) || []).concat(pid));
    ttys.set(Number(pid), SAFE.test(tty) ? tty : "");
  }
  const seen = new Set();
  const found = [];
  const queue = [String(shellPid)];
  while (queue.length) {
    const pid = queue.shift();
    if (seen.has(pid)) continue;
    seen.add(pid);
    const tty = ttys.get(Number(pid));
    if (tty && !found.includes(tty)) found.push(tty);
    queue.push(...(children.get(pid) || []));
  }
  const owned = found.find((tty) => {
    const session = read(path.join(STATE, `tty.${tty}.session`));
    return SAFE.test(session) && fs.existsSync(path.join(STATE, `${session}.state`));
  });
  log(`pid=${shellPid} ttys=[${found}] chosen=${owned || found[0] || ""}`);
  return owned || found[0] || "";
}

// Same lookup order as tn: a live session owns the name, else the bare terminal.
function currentName(tty) {
  const session = read(path.join(STATE, `tty.${tty}.session`));
  if (SAFE.test(session) && fs.existsSync(path.join(STATE, `${session}.state`))) {
    return read(path.join(STATE, `${session}.name`));
  }
  return read(path.join(STATE, `tty.${tty}.name`));
}

async function rename() {
  const terminal = vscode.window.activeTerminal;
  if (!terminal) {
    return;
  }
  const pid = await terminal.processId;
  const tty = pid ? sessionTty(pid) : "";
  if (!tty) {
    // A task or extension-owned terminal has no pty and no dot to protect.
    log(`pid=${pid} no tty; falling back to the built-in rename`);
    return vscode.commands.executeCommand("workbench.action.terminal.renameActiveTab");
  }
  const value = currentName(tty);
  const name = await vscode.window.showInputBox({
    value,
    valueSelection: [0, value.length],
    prompt: "Tab name — leave empty to hand it back to automatic naming",
  });
  if (name === undefined) {
    return;
  }
  execFile(path.join(SCRIPTS, "tn"), ["--tty", tty, name], (error, stdout, stderr) => {
    const message = (stderr || "").trim();
    log(`tn --tty ${tty} ${JSON.stringify(name)} -> code=${error ? error.code : 0} out=${(stdout || "").trim()} err=${message}`);
    if (error) {
      vscode.window.showWarningMessage(message || `Renaming the tab failed (${error.code}).`);
    }
  });
}

// install.sh copies this file on every update run, so an update lands while the
// window still runs the old code. Compare content, not timestamps: a copy of an
// identical file must not nag.
function watchForUpdates(context) {
  const self = path.join(__dirname, "extension.js");
  const installed = read(self);
  const interval = Number(process.env.CLAUDE_TAB_WATCH_MS) || 60000;
  fs.watchFile(self, { interval }, () => {
    const current = read(self);
    if (!current || current === installed) {
      return;
    }
    fs.unwatchFile(self);
    log("update detected; offering a window reload");
    vscode.window.showInformationMessage(
      "Claude tab tools updated. Reload the window to pick up the new version.",
      "Reload Window",
    ).then((choice) => {
      if (choice) {
        vscode.commands.executeCommand("workbench.action.reloadWindow");
      }
    });
  });
  context.subscriptions.push({ dispose: () => fs.unwatchFile(self) });
}

// `ccx council --split` needs a keyboard, which a command Claude runs never has.
// It drops {pid, cwd, command} into SPLIT_REQUESTS; the window whose terminal is
// an ancestor of that pid splits that terminal and runs the command there. Every
// window watches, only the owner acts, and the rename makes the claim atomic.
function ancestors(pid) {
  const parent = new Map();
  for (const row of ps(["-eo", "pid=,ppid="]).split("\n")) {
    const [p, pp] = row.trim().split(/\s+/);
    if (p) parent.set(p, pp);
  }
  const out = new Set();
  for (let cur = String(pid); cur && cur !== "0" && cur !== "1" && !out.has(cur); cur = parent.get(cur)) {
    out.add(cur);
  }
  return out;
}

async function ownerOf(pid) {
  const up = ancestors(pid);
  for (const terminal of vscode.window.terminals) {
    const shell = await terminal.processId;
    if (shell && up.has(String(shell))) return terminal;
  }
  return null;
}

async function splitRequest(name) {
  if (!name || !name.endsWith(".json")) return;
  const file = path.join(SPLIT_REQUESTS, name);
  let request;
  try {
    request = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return;
  }
  const owner = await ownerOf(request.pid);
  if (!owner) return;
  try {
    fs.renameSync(file, file + ".taken");   // another window may have won the race
  } catch {
    return;
  }
  fs.rmSync(file + ".taken", { force: true });
  // Run the command as the pane's own process (`zsh -ic`), never typed into a
  // shell: auto-claude skips `-c` shells, so Claude can't start here and swallow it.
  const pane = vscode.window.createTerminal({
    name: request.name || "council",
    cwd: request.cwd,
    shellPath: process.env.SHELL || "/bin/zsh",
    shellArgs: ["-ic", `${request.command}; printf '\\npress Enter to close '; read _`],
    env: { CLAUDE_AUTOSTART_OFF: "1" },
    location: { parentTerminal: owner },
  });
  pane.show(false);
  log(`split pid=${request.pid} -> ${request.command}`);
}

function watchSplitRequests(context) {
  try {
    fs.mkdirSync(SPLIT_REQUESTS, { recursive: true });
    const watcher = fs.watch(SPLIT_REQUESTS, (_event, name) => splitRequest(name));
    context.subscriptions.push({ dispose: () => watcher.close() });
  } catch (e) {
    log(`split watcher failed: ${e.message}`);
  }
}

function activate(context) {
  context.subscriptions.push(vscode.commands.registerCommand("claudeTab.rename", rename));
  watchForUpdates(context);
  watchSplitRequests(context);
}

module.exports = { activate, deactivate() {} };
