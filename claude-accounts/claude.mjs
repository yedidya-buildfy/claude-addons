// Claude Code: the login sits in the Keychain item Claude Code reads, the identity in ~/.claude.json.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HOME, readItem, readJson, writeItem, writeJson } from "./store.mjs";

const LIVE = "Claude Code-credentials";
const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"; // Claude Code's public OAuth client
const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const CONFIG = path.join(HOME, ".claude.json");
// the status line's usage cache; dropped on a switch so it shows the new account right away
const STATUS_CACHE = path.join(HOME, ".claude", "cache", "claude-usage.json");

export const id = "claude";
// opens the browser itself and waits for the approval there; no terminal needed
export const login = ["claude", "auth", "login", "--claudeai"];

/** "default_claude_max_20x" → "Max 20x"; falls back to the subscription name. */
export function planName(oauth) {
  const m = /max_(\d+x)/.exec(oauth?.rateLimitTier ?? "");
  if (m) return `Max ${m[1]}`;
  const s = oauth?.subscriptionType ?? "";
  return s ? s[0].toUpperCase() + s.slice(1) : "";
}

/** Claude Code's stored login with another account's OAuth swapped in; MCP logins etc. stay. */
export function withAccount(liveBlob, oauth) {
  return { ...liveBlob, claudeAiOauth: oauth };
}

function liveBlob() {
  return JSON.parse(readItem(LIVE) ?? "null");
}

export function live() {
  const blob = liveBlob();
  const account = readJson(CONFIG, {}).oauthAccount;
  if (!blob?.claudeAiOauth || !account?.emailAddress) return null;
  const secret = JSON.stringify({ oauth: blob.claudeAiOauth, account });
  return { email: account.emailAddress, name: account.displayName ?? "", plan: planName(blob.claudeAiOauth), secret };
}

async function refreshed(slot) {
  if (slot.oauth.expiresAt > Date.now() + 120e3) return null;
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
  return {
    ...slot,
    oauth: { ...slot.oauth, accessToken: t.access_token, refreshToken: t.refresh_token ?? slot.oauth.refreshToken, expiresAt: Date.now() + t.expires_in * 1000 },
  };
}

const CACHE_FRESH_MS = 5 * 60e3;

function statusCache() {
  try {
    const at = fs.statSync(STATUS_CACHE).mtimeMs;
    return { ...windowsOf(JSON.parse(fs.readFileSync(STATUS_CACHE, "utf8"))), at };
  } catch {
    return null;
  }
}

const windowsOf = (u) => ({ windows: [windowOf("5h", u.five_hour), windowOf("wk", u.seven_day)].filter(Boolean) });

const windowOf = (label, w) => (w && typeof w.utilization === "number" ? { label, pct: w.utilization, resets: Math.floor(Date.parse(w.resets_at) / 1000) || 0 } : null);

/** Plan usage; for a saved account also the refreshed login to store (refresh tokens are single-use). */
export async function usage(secret, active) {
  let slot = JSON.parse(secret);
  // the signed-in account: the status line already fetches its usage, and the endpoint rate-limits
  const cached = active ? statusCache() : null;
  if (cached && Date.now() - cached.at < CACHE_FRESH_MS) return cached;
  // the signed-in account's token belongs to Claude Code: read it, never refresh it ourselves
  const next = active ? null : await refreshed(slot);
  if (next) slot = next;
  const res = await fetch(USAGE_URL, {
    headers: { authorization: `Bearer ${slot.oauth.accessToken}`, "anthropic-beta": "oauth-2025-04-20" },
    signal: AbortSignal.timeout(15e3),
  });
  if (!res.ok && cached) return cached;
  if (!res.ok) throw new Error(res.status === 429 ? "busy, try later" : `usage ${res.status}`);
  return { ...windowsOf(await res.json()), secret: next && JSON.stringify(next) };
}

export function activate(secret) {
  const slot = JSON.parse(secret);
  writeItem(LIVE, os.userInfo().username, JSON.stringify(withAccount(liveBlob() ?? {}, slot.oauth)));
  const config = readJson(CONFIG, null);
  if (!config) throw new Error(`cannot read ${CONFIG}`);
  writeJson(CONFIG, { ...config, oauthAccount: slot.account }, fs.statSync(CONFIG).mode & 0o777);
  fs.rmSync(STATUS_CACHE, { force: true });
}
