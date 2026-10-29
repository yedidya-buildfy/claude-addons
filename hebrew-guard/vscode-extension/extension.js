// The terminal must draw with the GPU for Hebrew to read correctly, but after
// the Mac sleeps that drawing sometimes comes back garbled (black blocks, stray
// letters). The cure is Reload Window — terminals and the Claude sessions in
// them keep running across it. It is a command to run by hand: reloading by
// itself on every wake was turned off at the owner's request (29.10.2026).
const vscode = require("vscode");

function activate(context) {
  context.subscriptions.push(
    vscode.commands.registerCommand("claudeTerminalGuard.reload", () => vscode.commands.executeCommand("workbench.action.reloadWindow")),
  );
}

module.exports = { activate, deactivate() {} };
