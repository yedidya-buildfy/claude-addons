// Every test runs against a throwaway HOME — never the real one.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { spawn, execSync } from "node:child_process";
import { paths, loadManifests, migrateConfig, apply, SHELL_BEGIN, stripLegacyShell } from "../lib.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const manifests = loadManifests(repo);
process.env.ADDONS_ASSUME = "jq";

function sandbox({ vscode = true, ccx = true } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "addons-test-"));
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  if (ccx) fs.mkdirSync(path.join(home, ".claude-ccx"));
  if (vscode) fs.mkdirSync(path.join(home, "Library/Application Support/Code/User"), { recursive: true });
  const foreign = { model: "opus", hooks: { Stop: [{ hooks: [{ type: "command", command: "echo someone-else" }] }] } };
  fs.writeFileSync(path.join(home, ".claude/settings.json"), JSON.stringify(foreign, null, 2) + "\n");
  if (ccx) fs.writeFileSync(path.join(home, ".claude-ccx/settings.json"), JSON.stringify({ model: "x" }, null, 2) + "\n");
  fs.writeFileSync(path.join(home, ".zshrc"), 'export EDITOR=vim\n\nalias ll="ls -l"\n');
  return { home, P: paths(home, repo) };
}

const snap = (home) => {
  const out = {};
  const walk = (d) => {
    for (const n of fs.readdirSync(d)) {
      const f = path.join(d, n);
      if (f.includes(path.join(".claude", "addons"))) continue; // the engine's own bookkeeping
      if (n === "ntfy-topic") continue; // kept on purpose: a reinstall keeps the same phone subscription
      if (fs.statSync(f).isDirectory()) walk(f); else out[path.relative(home, f)] = fs.readFileSync(f, "utf8");
    }
  };
  walk(home);
  return out;
};

const all = (on) => ({ version: 1, enabled: Object.fromEntries(manifests.filter((m) => !m.required).map((m) => [m.id, on])), settings: {} });
const go = (P, cfg, extra = {}) => apply({ P, manifests, cfg, run: false, ...extra });

test("everything on then off returns every file byte-identical", () => {
  const { home, P } = sandbox();
  go(P, all(false));             // core only — the baseline every machine has
  const before = snap(home);
  go(P, all(true));
  assert.notDeepEqual(snap(home), before);
  go(P, all(false));
  assert.deepEqual(snap(home), before);
});

test("second apply writes nothing", () => {
  const { P } = sandbox();
  go(P, all(true));
  const r = go(P, all(true));
  assert.deepEqual(r.changes, []);
});

test("other people's settings, hooks and shell lines survive on and off", () => {
  const { home, P } = sandbox();
  go(P, all(true));
  go(P, all(false));
  const s = JSON.parse(fs.readFileSync(path.join(home, ".claude/settings.json"), "utf8"));
  assert.equal(s.model, "opus");
  assert.ok(s.hooks.Stop.some((e) => e.hooks[0].command === "echo someone-else"));
  const z = fs.readFileSync(path.join(home, ".zshrc"), "utf8");
  assert.match(z, /export EDITOR=vim/);
  assert.match(z, /alias ll="ls -l"/);
});

test("ccx profile gets the same hooks as the main one", () => {
  const { home, P } = sandbox();
  go(P, { ...all(false), enabled: { ...all(false).enabled, "agent-locks": true } });
  for (const f of [".claude/settings.json", ".claude-ccx/settings.json"]) {
    assert.match(fs.readFileSync(path.join(home, f), "utf8"), /agent-locks\.mjs/, f);
  }
});

test("shell block keeps the declared order: sticky, then multi-model, then auto-claude last", () => {
  const { home, P } = sandbox();
  const cfg = all(true);
  cfg.settings = { "multi-model": { claudeViaCcx: true } };
  go(P, cfg);
  const z = fs.readFileSync(path.join(home, ".zshrc"), "utf8");
  const i = (s) => z.indexOf(s);
  assert.ok(i("sticky-claude") < i("ccx --as-claude") && i("ccx --as-claude") < i("CLAUDE_AUTOSTARTED"));
  assert.match(z, /claude --dangerously-skip-permissions/);
  assert.equal(z.split(SHELL_BEGIN).length, 2);
});

test("settings render into the shell lines", () => {
  const { home, P } = sandbox();
  const cfg = all(false);
  cfg.enabled["auto-claude"] = true;
  cfg.settings = { "auto-claude": { skipPermissions: false } };
  go(P, cfg);
  const z = fs.readFileSync(path.join(home, ".zshrc"), "utf8");
  assert.match(z, /BUFFER="claude"$/m);
  assert.doesNotMatch(z, /dangerously/);
});

test("a hand-edited file is left in place on removal and reported", () => {
  const { home, P } = sandbox();
  const cfg = all(false); cfg.enabled["phone-alerts"] = true;
  go(P, cfg);
  const f = path.join(home, ".claude/scripts/ntfy.sh");
  fs.appendFileSync(f, "# mine\n");
  cfg.enabled["phone-alerts"] = false;
  const r = go(P, cfg);
  assert.ok(fs.existsSync(f));
  assert.ok(r.notes.some((n) => n.includes("edited by hand")));
});

test("failure midway puts every file back", () => {
  const { home, P } = sandbox();
  go(P, all(false));
  const before = snap(home);
  process.env.ADDONS_FAIL_ON = ".zshrc";
  try { assert.throws(() => go(P, all(true)), /injected failure/); } finally { delete process.env.ADDONS_FAIL_ON; }
  assert.deepEqual(snap(home), before);
});

test("invalid JSON in a settings file is refused and nothing is written", () => {
  const { home, P } = sandbox();
  go(P, all(false));
  fs.writeFileSync(path.join(home, ".claude/settings.json"), "{ broken");
  const before = snap(home);
  assert.throws(() => go(P, all(true)), /not valid JSON/);
  assert.deepEqual(snap(home), before);
});

test("an add-on that needs another is refused without it", () => {
  const { P } = sandbox();
  const cfg = all(false); cfg.enabled["skill-tab-name"] = true;
  assert.throws(() => go(P, cfg), /needs "tab-status"/);
});

test("ntfy topic is generated once, kept private, and survives off/on", () => {
  const { home, P } = sandbox();
  const cfg = all(false); cfg.enabled["phone-alerts"] = true;
  go(P, cfg);
  const f = path.join(home, ".claude/ntfy-topic");
  const topic = fs.readFileSync(f, "utf8");
  assert.match(topic, /^cc-[0-9a-f]{16}$/);
  assert.equal(fs.statSync(f).mode & 0o777, 0o600);
  cfg.enabled["phone-alerts"] = false; go(P, cfg);
  cfg.enabled["phone-alerts"] = true; go(P, cfg);
  assert.equal(fs.readFileSync(f, "utf8"), topic);
});

test("remove-all leaves no trace of the add-ons", () => {
  const { home, P } = sandbox();
  const start = snap(home);
  go(P, all(true));
  go(P, all(false), { removeAll: true });
  assert.deepEqual(snap(home), start);
});

// ---------------------------------------------------------------- migration

const LEGACY_ZSHRC = `export EDITOR=vim

# Override tab name in this terminal. \`tn\` with no args clears it back to auto.
# Thin wrapper around ~/.claude/scripts/tn so you can type \`tn <name>\` interactively.
tn() { "$HOME/.claude/scripts/tn" "$@"; }


# fable-plan (claude-addons): latest Fable plans, Opus/Sonnet executes
alias fplan='ANTHROPIC_DEFAULT_OPUS_MODEL=claude-fable-5-1 claude --model opusplan'
alias fplans='ccx claude-fplan-sonnet[1m]'

# >>> grok installer >>>
export PATH="$HOME/.grok/bin:$PATH"
# <<< grok installer <<<

# claude-addons: run Claude Code behind the sticky-prompt wrapper, so the
# message you sent stays pinned at the top of the VS Code terminal.


# claude-addons: multi-model — put ~/.claude/scripts on PATH so \`ccx\` is callable
case ":$PATH:" in
  *":$HOME/.claude/scripts:"*) ;;
  *) export PATH="$HOME/.claude/scripts:$PATH" ;;
esac

# claude-addons: \`claude\` is plain Claude Code on your Anthropic login, behind
# the sticky-prompt wrapper. Other providers live under \`ccx\` and nowhere else.
alias claude="$HOME/.claude/scripts/sticky-claude"
`;

test("legacy ~/.zshrc: our paragraphs become one block, everything else stays", () => {
  const { text, removed } = stripLegacyShell(LEGACY_ZSHRC);
  assert.equal(removed.length, 5);
  assert.match(text, /export EDITOR=vim/);
  assert.match(text, /grok installer >>>\nexport PATH="\$HOME\/\.grok\/bin:\$PATH"\n# <<< grok/);
  assert.doesNotMatch(text, /fplan|sticky-claude|tn\(\)/);
});

test("migration keeps what was installed and switches nothing else on", () => {
  const { home, P } = sandbox();
  fs.writeFileSync(path.join(home, ".zshrc"), LEGACY_ZSHRC);
  fs.mkdirSync(path.join(home, ".claude/scripts"), { recursive: true });
  for (const f of ["tab.sh", "sticky-claude", "agent-locks.mjs", "ccx"]) fs.writeFileSync(path.join(home, ".claude/scripts", f), "old\n");
  // hooks written by the old installer, one of them with a stale command
  const s = JSON.parse(fs.readFileSync(path.join(home, ".claude/settings.json"), "utf8"));
  s.hooks.SessionStart = [{ hooks: [{ type: "command", command: "$HOME/.claude/scripts/tab.sh start" }] }];
  fs.writeFileSync(path.join(home, ".claude/settings.json"), JSON.stringify(s, null, 2));

  const cfg = migrateConfig(manifests, P);
  assert.equal(cfg.enabled["tab-status"], true);
  assert.equal(cfg.enabled["fable-plan"], true);
  assert.equal(cfg.enabled["multi-model"], true);
  assert.equal(cfg.settings["multi-model"].claudeViaCcx, false); // this machine had sticky, not ccx, as `claude`
  assert.equal(cfg.enabled["phone-alerts"], false);
  assert.equal(cfg.enabled["auto-claude"], false);

  go(P, cfg);
  const z = fs.readFileSync(path.join(home, ".zshrc"), "utf8");
  assert.equal(z.split(SHELL_BEGIN).length, 2);
  assert.equal((z.match(/alias claude=/g) || []).length, 1);
  assert.match(z, /alias fplan=/);
  assert.match(z, /grok installer/);
  const after = JSON.parse(fs.readFileSync(path.join(home, ".claude/settings.json"), "utf8"));
  const cmds = JSON.stringify(after.hooks);
  assert.doesNotMatch(cmds, /tab\.sh start/);  // stale hook replaced
  assert.match(cmds, /tab\.sh white/);
  assert.match(cmds, /someone-else/);
  assert.deepEqual(go(P, cfg).changes, []);
});

// ---------------------------------------------------------------- the page

test("page server refuses requests without the token or from another host name", async () => {
  const { home } = sandbox();
  const child = spawn(process.execPath, [path.join(repo, "engine/addons.mjs")], { env: { ...process.env, HOME: home, ADDONS_NO_OPEN: "1" } });
  const url = await new Promise((ok, bad) => {
    child.stdout.on("data", (d) => { const m = String(d).match(/http:\/\/\S+/); if (m) ok(m[0]); });
    child.on("exit", () => bad(new Error("server exited")));
  });
  const get = (u, headers = {}) => new Promise((ok) => http.get(u, { headers }, (r) => { r.resume(); ok(r.statusCode); }));
  try {
    const noToken = url.replace(/\?t=.*/, "");
    assert.equal(await get(noToken), 403);
    assert.equal(await get(url.replace("/?", "/api/state?"), { host: "evil.example:80" }), 403);
    assert.equal(await get(url), 200);
    assert.equal(await get(url.replace("/?", "/api/state?")), 200);
  } finally { child.kill(); }
});

test("a user's line touching an old add-on paragraph is never removed", () => {
  const z = '# my notes\nexport FOO=1\nalias claude="$HOME/.claude/scripts/sticky-claude"\n\n# keep\nalias fplan=\'x\'\n';
  const { text } = stripLegacyShell(z);
  assert.match(text, /export FOO=1/);           // mixed paragraph: left whole
  assert.match(text, /sticky-claude/);
  assert.doesNotMatch(text, /fplan/);            // pure add-on paragraph: removed
});

test("shared defaults are adopted once, then the machine's own choices rule", async () => {
  const { adoptDefaults } = await import("../lib.mjs");
  const { P } = sandbox();
  const cfg = { version: 1, enabled: { "auto-claude": false, "phone-alerts": true }, settings: {} };
  assert.equal(adoptDefaults(manifests, cfg, P), true);
  assert.equal(cfg.enabled["auto-claude"], true);
  assert.equal(cfg.enabled["phone-alerts"], false);
  assert.equal(cfg.enabled["multi-model"], false);          // "if-installed": ccx is not on this machine
  cfg.enabled["auto-claude"] = false;                        // the owner switches it off
  assert.equal(adoptDefaults(manifests, cfg, P), false);
  assert.equal(cfg.enabled["auto-claude"], false);           // and it stays off
});

test("panel routes: only declared calls run, arguments are checked", async () => {
  const { home, P } = sandbox();
  go(P, { ...all(false), enabled: { ...all(false).enabled, "usage-by-device": true } });
  const child = spawn(process.execPath, [path.join(repo, "engine/addons.mjs")], { env: { ...process.env, HOME: home, ADDONS_NO_OPEN: "1" } });
  const url = await new Promise((ok, bad) => {
    child.stdout.on("data", (d) => { const m = String(d).match(/http:\/\/127\.0\.0\.1:\d+\/\?t=\w+/); if (m) ok(m[0]); });
    child.on("exit", () => bad(new Error("server exited")));
  });
  try {
  const u = new URL(url), t = u.searchParams.get("t"), base = u.origin;
  const post = (b) => fetch(`${base}/api/panel/call?t=${t}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
  assert.equal((await post({ addon: "usage-by-device", cmd: "sync", args: [] })).status, 404);
  assert.equal((await post({ addon: "phone-alerts", cmd: "rename", args: [] })).status, 404);
  assert.equal((await post({ addon: "usage-by-device", cmd: "retention", args: [{}] })).status, 400);
  assert.equal((await post({ addon: "usage-by-device", cmd: "retention", args: ["500"] })).status, 400);
  const state = await (await fetch(`${base}/api/state?t=${t}`)).json();
  assert.equal(state.find((a) => a.id === "usage-by-device").panel, true);
  assert.equal(state.find((a) => a.id === "phone-alerts").panel, false);
  } finally { child.kill(); } // a failed assertion must not leave the page server running
});

test("stopping the page server stops the live panel's helper too", async () => {
  const { home, P } = sandbox();
  go(P, { ...all(false), enabled: { ...all(false).enabled, "usage-by-device": true } });
  fs.writeFileSync(path.join(home, ".claude/usage-by-device/server"), "http://127.0.0.1:9");
  fs.writeFileSync(path.join(home, ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: "a", organizationUuid: "o" } })); // logged in → the helper keeps running
  const child = spawn(process.execPath, [path.join(repo, "engine/addons.mjs")], { env: { ...process.env, HOME: home, ADDONS_NO_OPEN: "1" } });
  const url = await new Promise((ok, bad) => {
    child.stdout.on("data", (d) => { const m = String(d).match(/http:\/\/127\.0\.0\.1:\d+\/\?t=\w+/); if (m) ok(m[0]); });
    child.on("exit", () => bad(new Error("server exited")));
  });
  const u = new URL(url);
  const ctl = new AbortController();
  const r = await fetch(`${u.origin}/api/panel/stream?t=${u.searchParams.get("t")}&addon=usage-by-device`, { signal: ctl.signal });
  const reader = r.body.getReader();
  for (let seen = ""; (seen.match(/data:/g) || []).length < 2;) { const { value, done } = await reader.read(); if (done) throw new Error("stream ended early"); seen += new TextDecoder().decode(value); } // printed, synced, now idle in its retry loop
  const helpers = () => { try { return execSync(`pgrep -f "${home}/.claude/usage-by-device/ubd.mjs watch"`, { encoding: "utf8" }).trim(); } catch { return ""; } };
  assert.notEqual(helpers(), "");
  child.kill("SIGTERM");
  await new Promise((ok) => child.on("exit", ok));
  await new Promise((ok) => setTimeout(ok, 300)); // the page server stops its helper itself, not via the helper's own watchdog
  ctl.abort();
  assert.equal(helpers(), "");
});

test("panel routes answer only while the add-on is on", async () => {
  const { home, P } = sandbox();
  go(P, { ...all(false), enabled: { ...all(false).enabled, "usage-by-device": true } });
  go(P, all(false)); // switched off again; its script may still be on disk
  fs.mkdirSync(path.join(home, ".claude/usage-by-device"), { recursive: true });
  fs.copyFileSync(path.join(repo, "usage-by-device/ubd.mjs"), path.join(home, ".claude/usage-by-device/ubd.mjs"));
  const child = spawn(process.execPath, [path.join(repo, "engine/addons.mjs")], { env: { ...process.env, HOME: home, ADDONS_NO_OPEN: "1" } });
  const url = await new Promise((ok, bad) => {
    child.stdout.on("data", (d) => { const m = String(d).match(/http:\/\/127\.0\.0\.1:\d+\/\?t=\w+/); if (m) ok(m[0]); });
    child.on("exit", () => bad(new Error("server exited")));
  });
  try {
    const u = new URL(url);
    assert.equal((await fetch(`${u.origin}/api/panel?t=${u.searchParams.get("t")}&addon=usage-by-device`)).status, 404);
  } finally { child.kill(); }
});
