#!/usr/bin/env node
// `addons` — the one entry point for installing, updating, switching and
// removing claude-addons. With no arguments it opens the settings page.

import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import { execSync, execFile, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { paths, loadManifests, loadConfig, migrateConfig, adoptDefaults, apply, status, withLock } from "./lib.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const P = paths(process.env.HOME, repo);
const manifests = loadManifests(repo);
const config = () => {
  const cfg = loadConfig(P) ?? migrateConfig(manifests, P);
  adoptDefaults(manifests, cfg, P);
  return cfg;
};

const HELP = `addons                      open the settings page in the browser
addons apply [--dry-run]    make this machine match the saved choices
addons status               what is on, and whether anything drifted
addons on|off <id>          switch one add-on, then apply
addons set <id> <key> <v>   change one setting, then apply
addons remove-all           remove every add-on (what uninstall.sh does)

ids: ${manifests.filter((m) => !m.required).map((m) => m.id).join(", ")}`;

function report(r, dryRun) {
  if (!r.changes.length && !r.ran.length) console.log(dryRun ? "nothing would change" : "already up to date — nothing changed");
  for (const c of r.changes) console.log(`${dryRun ? "would " : ""}${c.action.padEnd(6)} ${c.file.replace(P.home, "~")}${c.note ? `  (${c.note})` : ""}`);
  for (const x of r.ran) console.log(`${x.planned ? "would run" : x.ok ? "ran" : "FAILED"} ${x.id}${x.error ? `: ${x.error}` : ""}`);
  for (const n of r.notes) console.log(`note: ${n}`);
  if (r.backup) console.log(`backup of everything changed: ${r.backup.replace(P.home, "~")}`);
}

function run(cfg, dryRun = false) {
  const r = withLock(P, () => apply({ P, manifests, cfg, dryRun }));
  report(r, dryRun);
  if (r.ran.some((x) => !x.ok)) process.exitCode = 1;
  return r;
}

function known(id) {
  const m = manifests.find((x) => x.id === id);
  if (!m) throw new Error(`no add-on called "${id}" — see: addons help`);
  if (m.required) throw new Error(`"${id}" is always on`);
  return m;
}

function main([cmd, ...args]) {
  const dry = args.includes("--dry-run");
  switch (cmd) {
    case undefined: case "page": return serve();
    case "apply": return run(config(), dry);
    case "status": {
      for (const s of status(manifests, config(), P)) {
        const drift = [...s.missing.map((f) => `missing ${f}`), ...s.edited.map((f) => `edited ${f}`)].join("; ");
        console.log(`${s.on ? "on " : "off"} ${s.id.padEnd(28)} ${s.title}${s.required ? " (always)" : ""}${drift ? `  ⚠ ${drift.replaceAll(P.home, "~")}` : ""}`);
      }
      return;
    }
    case "on": case "off": {
      const cfg = config();
      for (const id of args.filter((a) => !a.startsWith("--"))) { known(id); cfg.enabled[id] = cmd === "on"; }
      return run(cfg, dry);
    }
    case "set": {
      const [id, key, ...rest] = args;
      const m = known(id);
      const s = m.settings.find((x) => x.key === key);
      if (!s) throw new Error(`"${id}" has no setting "${key}" (has: ${m.settings.map((x) => x.key).join(", ") || "none"})`);
      const cfg = config();
      const raw = rest.join(" ");
      (cfg.settings[id] ??= {})[key] = s.type === "bool" ? ["1", "true", "on", "yes"].includes(raw) : raw;
      return run(cfg, dry);
    }
    case "remove-all": {
      const cfg = config();
      for (const m of manifests) if (!m.required) cfg.enabled[m.id] = false;
      const r = withLock(P, () => apply({ P, manifests, cfg, dryRun: dry, removeAll: true }));
      return report(r, dry);
    }
    case "help": case "-h": case "--help": return console.log(HELP);
    default: throw new Error(`unknown command "${cmd}"\n\n${HELP}`);
  }
}

// ---------------------------------------------------------------- the page

function serve() {
  const token = crypto.randomBytes(16).toString("hex");
  const page = fs.readFileSync(path.join(repo, "engine", "page.html"), "utf8");
  let idle;
  const bump = () => { clearTimeout(idle); idle = setTimeout(() => { console.log("closed after 30 minutes idle"); process.exit(0); }, 30 * 60 * 1000); };
  // live panels run a helper per open tab; whenever this server stops, they stop with it
  const helpers = new Set();
  process.on("exit", () => { for (const h of helpers) h.kill(); });
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(sig, () => process.exit(0));

  const state = () => {
    const cfg = config();
    const st = Object.fromEntries(status(manifests, cfg, P).map((s) => [s.id, s]));
    return manifests.map((m) => ({
      id: m.id, title: m.title, summary: m.summary, required: !!m.required, requires: m.requires || [],
      group: m.group || "אחר", details: m.details || [], howToCheck: m.howToCheck || "", touches: touches(m),
      legend: m.legend || [], kinds: kinds(m), docs: docs(m).map(({ id, label }) => ({ id, label })),
      files: (m.files || []).map((f, i) => ({ i, to: f.to, installed: fs.existsSync(f.to.replace("~", P.home)) })),
      on: st[m.id].on, drift: [...st[m.id].missing, ...st[m.id].edited].map((f) => f.replace(P.home, "~")),
      settings: m.settings.map((s) => ({
        key: s.key, label: s.label, type: s.type,
        value: s.file ? (fs.existsSync(s.file.replace("~", P.home)) ? fs.readFileSync(s.file.replace("~", P.home), "utf8").trim() : "") : (cfg.settings?.[m.id]?.[s.key] ?? s.default),
      })),
      actions: (m.actions || []).map((a) => ({ id: a.id, label: a.label })),
      panel: !!m.panel && st[m.id].on,
    }));
  };

  // what switching this add-on on writes, in words
  const touches = (m) => [
    ...(m.files || []).map((f) => `קובץ ${f.to}`),
    ...(m.claudeSettings ? ["הוקים בהגדרות של קלוד (גם בפרופיל של ccx)"] : []),
    ...(m.shell ? ["שורות בקובץ ההפעלה של הטרמינל (~/.zshrc), בתוך האזור המנוהל"] : []),
    ...(m.vscodeSettings || m.vscodeKeybindings ? ["הגדרות וקיצורי מקלדת של VS Code"] : []),
    ...(m.claudeMd ? ["תזכורת בקובץ ההוראות הכללי של קלוד (רק אם סימנת)"] : []),
    ...(m.run ? [`מריץ את ההתקנה של התוסף (${m.run.when === "always" ? "בכל עדכון" : "רק כשהוא השתנה"})`] : []),
  ];

  // what kind of thing this add-on is, in words
  const kinds = (m) => {
    const k = [];
    if ((m.files || []).some((f) => f.to.includes("/skills/"))) k.push("סקיל");
    if (m.claudeSettings?.length) k.push(m.id === "statusline-gsd" ? "שורת מצב" : "הוקים בקלוד");
    if (m.shell) k.push("פקודות בטרמינל");
    if ((m.files || []).some((f) => f.to.includes(".vscode/extensions"))) k.push("תוסף VS Code");
    if (m.run?.when === "changed") k.push("תוכנה נפרדת");
    return k;
  };
  // readable documents: the add-on's README, and the text of each skill it installs
  const docs = (m) => {
    const out = [];
    if (fs.existsSync(path.join(m.dir, "README.md"))) out.push({ id: "readme", label: "תיעוד מלא", file: path.join(m.dir, "README.md") });
    for (const f of m.files || []) {
      if (f.to.includes("/skills/") && f.from.endsWith(".md")) out.push({ id: `skill:${f.from}`, label: "תוכן הסקיל (מה קלוד קורא)", file: path.join(m.dir, f.from) });
    }
    return out;
  };

  const body = (req) => new Promise((ok, bad) => {
    let s = ""; req.on("data", (c) => { s += c; if (s.length > 1e6) req.destroy(); });
    req.on("end", () => { try { ok(s ? JSON.parse(s) : {}); } catch (e) { bad(e); } });
  });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    const send = (code, data, type = "application/json") => {
      res.writeHead(code, { "content-type": type, "cache-control": "no-store", "x-frame-options": "DENY" });
      res.end(type === "application/json" ? JSON.stringify(data) : data);
    };
    // Only this machine, only with the token, only under our own host name —
    // another site open in the browser can neither read nor switch anything.
    const host = req.headers.host || "";
    if (url.searchParams.get("t") !== token || !/^127\.0\.0\.1:\d+$/.test(host)) return send(403, { error: "forbidden" });
    bump();
    try {
      if (req.method === "GET" && url.pathname === "/") return send(200, page.replace("__TOKEN__", token), "text/html; charset=utf-8");
      if (req.method === "GET" && url.pathname === "/api/state") return send(200, state());
      if (req.method === "POST" && url.pathname === "/api/apply") {
        const b = await body(req);
        const cfg = config();
        for (const m of manifests) {
          if (!m.required && typeof b.enabled?.[m.id] === "boolean") cfg.enabled[m.id] = b.enabled[m.id];
          for (const s of m.settings) {
            const v = b.settings?.[m.id]?.[s.key];
            if (v === undefined) continue;
            if (s.type === "bool" ? typeof v !== "boolean" : typeof v !== "string" || v.length > 200) throw new Error(`bad value for ${m.id}.${s.key}`);
            (cfg.settings[m.id] ??= {})[s.key] = v;
          }
        }
        const r = withLock(P, () => apply({ P, manifests, cfg, dryRun: !!b.dryRun }));
        return send(200, {
          changes: r.changes.map((c) => ({ ...c, file: c.file.replace(P.home, "~") })),
          ran: r.ran, notes: r.notes.map((n) => n.replaceAll(P.home, "~")), backup: r.backup?.replace(P.home, "~"),
          state: b.dryRun ? undefined : state(),
        });
      }
      if (req.method === "GET" && url.pathname === "/api/doc") {
        const m = manifests.find((x) => x.id === url.searchParams.get("addon"));
        const d = m && docs(m).find((x) => x.id === url.searchParams.get("doc"));
        if (!d) return send(404, { error: "no such document" });
        return send(200, { text: fs.readFileSync(d.file, "utf8"), path: d.file.replace(P.home, "~") });
      }
      // open a document or an installed file in the editor; only paths the manifest names
      if (req.method === "POST" && url.pathname === "/api/open") {
        const b = await body(req);
        const m = manifests.find((x) => x.id === b.addon);
        let file = null;
        if (m && typeof b.doc === "string") file = docs(m).find((x) => x.id === b.doc)?.file;
        if (m && Number.isInteger(b.file)) file = m.files?.[b.file]?.to.replace("~", P.home);
        if (!file || !fs.existsSync(file)) return send(404, { error: "הקובץ לא נמצא" });
        let editor = "open";
        try { execSync("command -v code", { stdio: "ignore", shell: "/bin/sh" }); editor = "code"; } catch {}
        spawn(editor, editor === "open" ? ["-t", file] : [file], { stdio: "ignore", detached: true }).unref();
        return send(200, { ok: true });
      }
      if (req.method === "POST" && url.pathname === "/api/action") {
        const b = await body(req);
        const m = manifests.find((x) => x.id === b.addon);
        const a = m?.actions?.find((x) => x.id === b.action);
        if (!a) return send(404, { error: "no such action" });
        execSync(a.cmd.replace(/~\//g, P.home + "/"), { shell: "/bin/bash", stdio: "pipe", timeout: 20000 });
        return send(200, { ok: true });
      }
      // an add-on's own live table (usage-by-device): its script prints JSON; only declared calls run
      if (url.pathname.startsWith("/api/panel")) {
        const b = req.method === "POST" ? await body(req) : {};
        const m = manifests.find((x) => x.id === (b.addon ?? url.searchParams.get("addon")));
        if (!m?.panel) return send(404, { error: "no such panel" });
        const script = m.panel.script.replace("~", P.home);
        const runScript = (args) => new Promise((ok) => execFile(process.execPath, [script, ...args], { timeout: 30000 }, (err, out, errOut) => ok({ err, out, errOut })));
        if (req.method === "GET" && url.pathname === "/api/panel") {
          const r = await runScript(["json"]);
          if (r.err) return send(400, { error: (r.errOut || r.err.message).trim() });
          return send(200, JSON.parse(r.out));
        }
        if (req.method === "POST" && url.pathname === "/api/panel/call") {
          if (!m.panel.calls.includes(b.cmd)) return send(404, { error: "no such call" });
          if (!Array.isArray(b.args) || b.args.length > 3 || b.args.some((a) => typeof a !== "string" || a.length > 60)) throw new Error("bad arguments");
          const r = await runScript([b.cmd, ...b.args]);
          if (r.err) return send(400, { error: (r.errOut || r.err.message).trim() });
          return send(200, { ok: true });
        }
        if (req.method === "GET" && url.pathname === "/api/panel/stream") {
          res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
          const child = spawn(process.execPath, [script, "watch"], { stdio: ["ignore", "pipe", "ignore"] });
          helpers.add(child);
          child.on("exit", () => { helpers.delete(child); res.end(); });
          child.stdout.setEncoding("utf8"); // a Hebrew name split across two reads must not break
          let buf = "";
          child.stdout.on("data", (c) => {
            buf += c;
            for (let i; (i = buf.indexOf("\n")) >= 0; buf = buf.slice(i + 1)) res.write(`data: ${buf.slice(0, i)}\n\n`);
            bump();
          });
          req.on("close", () => child.kill());
          return;
        }
        return send(404, { error: "not found" });
      }
      return send(404, { error: "not found" });
    } catch (e) {
      return send(400, { error: e.message.replaceAll(P.home, "~") });
    }
  });

  server.listen(0, "127.0.0.1", () => {
    const url = `http://127.0.0.1:${server.address().port}/?t=${token}`;
    console.log(`add-ons page: ${url}\n(Ctrl-C to close)`);
    if (!process.env.ADDONS_NO_OPEN) spawn("open", [url], { stdio: "ignore", detached: true }).unref();
    bump();
  });
  return server;
}

export { serve };

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); } catch (e) { console.error(`addons: ${e.message}`); process.exit(1); }
}
