#!/usr/bin/env node
// One check: the right-click menu offers our rename, and it renames the clicked
// terminal — falling back to the active one only when nothing was passed.
const path = require("path");
const Module = require("module");
const assert = require("assert");

const manifest = require(path.join(__dirname, "package.json"));
const menu = (manifest.contributes.menus || {})["terminal/title/context"] || [];
assert.ok(
  menu.some((item) => item.command === "claudeTab.rename"),
  "the tab's right-click menu must offer claudeTab.rename",
);

const reads = [];
// No pid means no tty, so rename() takes its fallback without calling ps.
const fakeTerminal = (label) => ({
  sendText() {},
  get processId() {
    reads.push(label);
    return Promise.resolve(undefined);
  },
});

const registered = {};
const stub = {
  window: { activeTerminal: fakeTerminal("active") },
  commands: {
    registerCommand: (id, fn) => ((registered[id] = fn), { dispose() {} }),
    executeCommand: () => Promise.resolve(),
  },
};
const load = Module._load;
Module._load = (request, ...rest) => (request === "vscode" ? stub : load(request, ...rest));

process.env.CLAUDE_TAB_WATCH_MS = "3600000";
const context = { subscriptions: [] };
require(path.join(__dirname, "extension.js")).activate(context);

(async () => {
  await registered["claudeTab.rename"](fakeTerminal("clicked"));  // right-click menu
  await registered["claudeTab.rename"]();                          // Enter / F2 / palette
  assert.deepStrictEqual(reads, ["clicked", "active"]);

  for (const item of context.subscriptions) item.dispose();
  console.log("PASS: menu entry present, renames the clicked terminal, falls back to the active one");
})();
