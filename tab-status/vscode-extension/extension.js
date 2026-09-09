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
const SAFE = /^[A-Za-z0-9_-]+$/;

function read(file) {
  try {
    return fs.readFileSync(file, "utf8").trim();
  } catch {
    return "";
  }
}

function ttyOf(pid) {
  try {
    const tty = execFileSync("ps", ["-o", "tty=", "-p", String(pid)],
                             { encoding: "utf8", timeout: 2000 }).trim();
    return SAFE.test(tty) ? tty : "";
  } catch {
    return "";
  }
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
  const tty = pid ? ttyOf(pid) : "";
  if (!tty) {
    // A task or extension-owned terminal has no pty and no dot to protect.
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
    if (error && message) {
      vscode.window.showWarningMessage(message);
    }
  });
}

function activate(context) {
  context.subscriptions.push(vscode.commands.registerCommand("claudeTab.rename", rename));
}

module.exports = { activate, deactivate() {} };
