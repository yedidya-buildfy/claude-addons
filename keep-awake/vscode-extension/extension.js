// Three clickable keep-awake buttons in VS Code's bottom bar. Every window reads and
// flips one shared state (~/.claude/awake/state.json), so all of them show the same thing.
const vscode = require("vscode");
const { execFile } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const AWAKE = path.join(os.homedir(), ".claude", "scripts", "awake");
const DIR = path.join(os.homedir(), ".claude", "awake");
const STATE = path.join(DIR, "state.json");
const ENV = { ...process.env, PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH}` };
const MODES = new Set(["on", "lid", "pin", "off"]);

const BUTTONS = [
  { mode: "on", label: "☕ awake", tip: "ער עם מכסה פתוחה, עד שמכבים" },
  { mode: "lid", label: "💻 lid · till done", tip: "ער גם עם מכסה סגורה, עד 5 דקות בלי שום עבודה (קלוד או משימות רקע)" },
  { mode: "pin", label: "📌 lid · always", tip: "ער גם עם מכסה סגורה, עד שמכבים (12 שעות לכל היותר)" },
];

function flip(mode) {
  if (!MODES.has(mode)) return;
  execFile("node", [AWAKE, mode], { env: ENV }, (err, out) => {
    vscode.window.setStatusBarMessage((err ? "keep-awake: " + err.message : out).trim(), 4000);
    paint();
  });
}

function read() {
  try { return JSON.parse(fs.readFileSync(STATE, "utf8")); } catch { return { mode: "off" }; }
}

let items = [];
function paint() {
  const s = read();
  const stale = Date.now() - (s.at || 0) > 60e3;
  for (const [i, b] of BUTTONS.entries()) {
    const it = items[i], on = s.mode === b.mode;
    let text = b.label;
    if (on && b.mode === "lid" && !s.sawWork) text += " ⏳";
    if (on && b.mode === "pin") {
      const m = Math.floor((Date.now() - s.since) / 60e3);
      text += m >= 60 ? ` ${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}` : ` ${m}m`;
    }
    const broken = on && (stale || s.note === "setup");
    if (broken) text += stale ? " ⚠ no tick" : " ⚠ awake setup";
    it.text = on ? `● ${text}` : text;
    it.color = on ? undefined : new vscode.ThemeColor("disabledForeground");
    // VS Code allows only these two backgrounds on a bottom-bar item.
    it.backgroundColor = !on ? undefined
      : new vscode.ThemeColor(broken || b.mode === "pin" ? "statusBarItem.errorBackground" : "statusBarItem.warningBackground");
    it.tooltip = `${b.tip}\n${on ? "דולק — לחיצה מכבה" : "כבוי — לחיצה מדליקה"}`;
  }
}

exports.activate = (context) => {
  items = BUTTONS.map((b, i) => {
    const it = vscode.window.createStatusBarItem(`keep-awake.${b.mode}`, vscode.StatusBarAlignment.Left, -100 - i);
    it.name = `Keep awake: ${b.label}`;
    it.command = { command: "keepAwake.flip", title: b.label, arguments: [b.mode] };
    it.show();
    return it;
  });
  context.subscriptions.push(...items, vscode.commands.registerCommand("keepAwake.flip", flip));
  // Another terminal or window flips the switch: follow the file. The poll also ages the pin timer.
  try { fs.mkdirSync(DIR, { recursive: true }); const w = fs.watch(DIR, paint); context.subscriptions.push({ dispose: () => w.close() }); } catch {}
  const t = setInterval(paint, 15000);
  context.subscriptions.push({ dispose: () => clearInterval(t) });
  paint();
};
exports.deactivate = () => {};
