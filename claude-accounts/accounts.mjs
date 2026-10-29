#!/usr/bin/env node
// Several Claude subscriptions on one Mac: remembers each login, reads each one's plan usage,
// and switches which one Claude Code uses. The notch monitor's AI view is a thin face over this.
//
//   accounts.mjs list          JSON: every remembered account + usage + which one to use
//   accounts.mjs use <email>   new Claude Code sessions run on that account
//
// A new account is picked up by itself: sign in to it in Claude Code (/login) and the next `list`
// remembers it. Logins live in the macOS Keychain (one item per account), never in a file.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const LIVE = "Claude Code-credentials"; // the item Claude Code itself reads
const STORE = "claude-accounts"; // ours: one item per email
const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"; // Claude Code's public OAuth client
const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const HOME = os.homedir();
const CONFIG = path.join(HOME, ".claude.json");
const INDEX = path.join(HOME, ".claude", "claude-accounts", "index.json");
// the status line's usage cache; dropped on a switch so it shows the new account right away
const STATUS_CACHE = path.join(HOME, ".claude", "cache", "claude-usage.json");

// ---- pure rules (tested) ----

/** "default_claude_max_20x" → "Max 20x"; falls back to the subscription name. */
export function planName(oauth) {
  const m = /max_(\d+x)/.exec(oauth?.rateLimitTier ?? "");
  if (m) return `Max ${m[1]}`;
  const s = oauth?.subscriptionType ?? "";
  return s ? s[0].toUpperCase() + s.slice(1) : "";
}

/** The account with the most room left: lowest of its busier window; a full window rules it out. */
export function recommend(accounts) {
  let best = null;
  for (const a of accounts) {
    if (!a.five || !a.week || a.error) continue;
    const load = Math.max(a.five.pct, a.week.pct);
    if (load >= 100) continue;
    if (!best || load < best.load || (load === best.load && a.active)) best = { email: a.email, load };
  }
  return best?.email ?? null;
}

/** Claude Code's stored login with another account's OAuth swapped in; MCP logins etc. stay. */
export function withAccount(liveBlob, oauth) {
  return { ...liveBlob, claudeAiOauth: oauth };
}

// resets = unix seconds, so the notch view needs no date parser
const windowOf = (w) => (w && typeof w.utilization === "number" ? { pct: w.utilization, resets: Math.floor(Date.parse(w.resets_at) / 1000) || 0 } : null);

// ---- keychain ----

function readItem(service, account) {
  try {
    const args = ["find-generic-password", "-s", service, "-w"];
    if (account) args.splice(1, 0, "-a", account);
    return execFileSync("security", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

// Through `security -i` on stdin, like Claude Code does, so the secret never shows in the process list.
function writeItem(service, account, text) {
  const hex = Buffer.from(text, "utf8").toString("hex");
  const quote = (s) => `"${s.replace(/["\\]/g, "\\$&")}"`;
  const out = execFileSync("security", ["-i"], {
    input: `add-generic-password -U -a ${quote(account)} -s ${quote(service)} -X ${hex}\n`,
    encoding: "utf8",
  });
  if (/error/i.test(out)) throw new Error(`keychain write failed for ${service}`);
}

// ---- files ----

const readJson = (file, fallback) => {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
};

function writeJson(file, value, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode });
  fs.renameSync(tmp, file);
}

// ---- accounts ----

function live() {
  const blob = JSON.parse(readItem(LIVE) ?? "null");
  const account = readJson(CONFIG, {}).oauthAccount;
  return blob?.claudeAiOauth && account?.emailAddress ? { blob, account } : null;
}

const loadSlot = (email) => JSON.parse(readItem(STORE, email) ?? "null");

function saveSlot(email, slot) {
  writeItem(STORE, email, JSON.stringify(slot));
  const index = readJson(INDEX, []);
  if (!index.includes(email)) writeJson(INDEX, [...index, email]);
}

/** Remembers whatever Claude Code is signed in to now (it may have refreshed the token since). */
function remember() {
  const l = live();
  if (l) saveSlot(l.account.emailAddress, { oauth: l.blob.claudeAiOauth, account: l.account });
  return l;
}

async function refreshed(email, slot) {
  if (slot.oauth.expiresAt > Date.now() + 120e3) return slot;
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: slot.oauth.refreshToken,
      client_id: CLIENT_ID,
      scope: (slot.oauth.scopes ?? []).join(" "),
    }),
    signal: AbortSignal.timeout(15e3),
  });
  if (!res.ok) throw new Error(res.status === 400 || res.status === 401 ? "signed out" : `refresh ${res.status}`);
  const t = await res.json();
  const oauth = {
    ...slot.oauth,
    accessToken: t.access_token,
    refreshToken: t.refresh_token ?? slot.oauth.refreshToken,
    expiresAt: Date.now() + t.expires_in * 1000,
  };
  const next = { ...slot, oauth };
  saveSlot(email, next); // refresh tokens are single-use: store the new one before anything else
  return next;
}

async function usage(token) {
  const res = await fetch(USAGE_URL, {
    headers: { authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20" },
    signal: AbortSignal.timeout(15e3),
  });
  if (!res.ok) throw new Error(`usage ${res.status}`);
  return res.json();
}

async function list() {
  const l = remember();
  const active = l?.account.emailAddress ?? null;
  const accounts = await Promise.all(readJson(INDEX, []).map(async (email) => {
    let slot = loadSlot(email);
    const row = { email, name: slot?.account?.displayName ?? "", plan: planName(slot?.oauth), active: email === active, five: null, week: null, error: null };
    if (!slot) return { ...row, error: "signed out" };
    try {
      // the signed-in account's token belongs to Claude Code: read it, never refresh it ourselves
      if (!row.active) slot = await refreshed(email, slot);
      const u = await usage(slot.oauth.accessToken);
      return { ...row, five: windowOf(u.five_hour), week: windowOf(u.seven_day) };
    } catch (e) {
      return { ...row, error: e.message };
    }
  }));
  return { accounts, recommended: recommend(accounts) };
}

function use(email) {
  const l = remember();
  if (l?.account.emailAddress === email) return;
  const slot = loadSlot(email);
  if (!slot) throw new Error(`no saved login for ${email}`);
  writeItem(LIVE, os.userInfo().username, JSON.stringify(withAccount(l?.blob ?? {}, slot.oauth)));
  const config = readJson(CONFIG, null);
  if (!config) throw new Error(`cannot read ${CONFIG}`);
  writeJson(CONFIG, { ...config, oauthAccount: slot.account }, fs.statSync(CONFIG).mode & 0o777);
  fs.rmSync(STATUS_CACHE, { force: true });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [cmd, arg] = process.argv.slice(2);
  try {
    if (cmd === "list") console.log(JSON.stringify(await list()));
    else if (cmd === "use" && arg) use(arg);
    else throw new Error("usage: accounts.mjs list | use <email>");
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
