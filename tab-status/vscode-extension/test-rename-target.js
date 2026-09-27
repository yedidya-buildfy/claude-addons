#!/usr/bin/env node
// One check: the right-click menu renames the tab that was clicked, not the
// active one, and the menu entry is actually contributed.
const Module = require("module");
const assert = require("assert");
const pkg = require("./package.json");

const menu = pkg.contributes.menus["terminal/title/context"];
assert.ok(menu.some((item) => item.command === "claudeTab.rename"), "rename is in the tab menu");

const asked = [];
function fakeTerminal(label) {
  return {
    sendText() {},
    get processId() {
      asked.push(label);
      return Promise.resolve(undefined);  // no pid: rename falls back without touching ps
    },
  };
}
const commands = {};
const stub = {
  window: { activeTerminal: fakeTerminal("active") },
  commands: {
    registerCommand: (id, fn) => ((commands[id] = fn), { dispose() {} }),
    executeCommand: () => undefined,
  },
};
const load = Module._load;
Module._load = (request, ...rest) => (request === "vscode" ? stub : load(request, ...rest));
process.env.CLAUDE_TAB_WATCH_MS = "3600000";
require("./extension.js").activate({ subscriptions: [] });

(async () => {
  await commands["claudeTab.rename"](fakeTerminal("clicked"));
  await commands["claudeTab.rename"]();
  assert.deepStrictEqual(asked, ["clicked", "active"]);
  console.log("ok - rename targets the clicked tab, else the active one");
  process.exit(0);
})();
