#!/usr/bin/env node
// One check: an identical re-copy stays quiet, a real change offers a reload.
const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");
const assert = require("assert");

const messages = [];
const commands = [];
const stub = {
  window: { showInformationMessage: (text) => (messages.push(text), Promise.resolve(undefined)) },
  commands: { registerCommand: () => ({ dispose() {} }), executeCommand: (id) => commands.push(id) },
};
const load = Module._load;
Module._load = (request, ...rest) => (request === "vscode" ? stub : load(request, ...rest));

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tab-rename-"));
const target = path.join(dir, "extension.js");
const source = fs.readFileSync(path.join(__dirname, "extension.js"), "utf8");
fs.writeFileSync(target, source);
process.env.CLAUDE_TAB_WATCH_MS = "50";

const context = { subscriptions: [] };
require(target).activate(context);

const wait = (ms) => new Promise((done) => setTimeout(done, ms));
(async () => {
  fs.writeFileSync(target, source);  // install.sh recopying an unchanged file
  await wait(300);
  assert.deepStrictEqual(messages, [], "an identical copy must not prompt");

  fs.writeFileSync(target, source + "\n// newer build\n");
  await wait(300);
  assert.strictEqual(messages.length, 1, "a changed file must offer a reload");
  assert.match(messages[0], /Reload the window/);

  for (const item of context.subscriptions) item.dispose();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log("PASS: quiet on re-copy, prompts on a real update");
})();
