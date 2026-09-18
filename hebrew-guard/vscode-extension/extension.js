// The terminal must draw with the GPU for Hebrew to read correctly, but after
// the Mac sleeps that drawing sometimes comes back garbled (black blocks, stray
// letters). The cure is Reload Window — terminals and the Claude sessions in
// them keep running across it. This notices the sleep (a timer that fell far
// behind the clock) and reloads the next time the window has focus, with a few
// seconds to cancel.
const vscode = require("vscode");

const TICK = 30 * 1000;
const SLEPT = 5 * 60 * 1000; // a gap this long means the machine was asleep
const GRACE = 5000;

function activate(context) {
  let last = Date.now();
  let pending = false;
  let asking = false;

  const reload = () => vscode.commands.executeCommand("workbench.action.reloadWindow");

  const maybeReload = async () => {
    if (!pending || asking || !vscode.window.state.focused || !vscode.window.terminals.length) return;
    asking = true;
    const cancel = "לא עכשיו";
    const choice = await Promise.race([
      vscode.window.showInformationMessage("המחשב התעורר משינה — טוען מחדש את החלון כדי לתקן את ציור הטרמינל. הסשנים ממשיכים לרוץ.", cancel),
      new Promise((ok) => setTimeout(() => ok("timeout"), GRACE)),
    ]);
    pending = false;
    asking = false;
    if (choice !== cancel) reload();
  };

  const timer = setInterval(() => {
    const now = Date.now();
    if (now - last > SLEPT) pending = true;
    last = now;
    maybeReload();
  }, TICK);

  context.subscriptions.push(
    { dispose: () => clearInterval(timer) },
    vscode.window.onDidChangeWindowState(() => maybeReload()),
    vscode.commands.registerCommand("claudeTerminalGuard.reload", reload),
  );
}

module.exports = { activate, deactivate() {} };
