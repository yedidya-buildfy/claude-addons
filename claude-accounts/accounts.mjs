#!/usr/bin/env node
// Every AI subscription on this Mac (Claude, Codex, Gemini): remembers each login, reads each
// one's plan usage, and switches which account each tool uses. The notch monitor's AI view is a
// thin face over this.
//
//   accounts.mjs list                     JSON: every remembered account, its plan, price and usage
//   accounts.mjs use <provider> <email>   that tool's new sessions run on that account
//   accounts.mjs add <provider>           opens a Terminal to sign in to one more account
//
// A login made any other way is picked up too: the next `list` remembers whatever each tool is
// signed in to. Secrets live in the macOS Keychain (see store.mjs), never in a file of ours.
import { execFileSync } from "node:child_process";
import * as claude from "./claude.mjs";
import * as codex from "./codex.mjs";
import * as gemini from "./gemini.mjs";
import { HOME, loadIndex, loadSecret, saveSecret, updateIndex } from "./store.mjs";

const PROVIDERS = [claude, codex, gemini];
const byId = Object.fromEntries(PROVIDERS.map((p) => [p.id, p]));

// launchd (the notch app) gives no shell PATH; the tools' own CLIs live here
process.env.PATH = [`${HOME}/.local/bin`, `${HOME}/.npm-global/bin`, "/opt/homebrew/bin", "/usr/local/bin", process.env.PATH].join(":");

// ---- pure rules (tested) ----

// ponytail: monthly list prices in USD, by plan name as each tool reports it; add a row when a plan appears
export const PRICES = {
  claude: { Pro: 20, "Max 5x": 100, "Max 20x": 200 },
  codex: { Free: 0, Plus: 20, Pro: 200, Team: 30, Business: 30 },
  gemini: { Pro: 20, Ultra: 250 },
};
export const priceOf = (provider, plan) => PRICES[provider]?.[plan] ?? null;

/** Per tool, the account with the most room left: lowest busier window; a full window rules it out. */
export function recommend(rows) {
  const best = {};
  for (const r of rows) {
    if (r.error || !r.windows.length) continue;
    const load = Math.max(...r.windows.map((w) => w.pct));
    if (load >= 100) continue;
    const b = best[r.provider];
    if (!b || load < b.load || (load === b.load && r.active)) best[r.provider] = { email: r.email, load };
  }
  return Object.fromEntries(Object.entries(best).map(([k, v]) => [k, v.email]));
}

// ---- actions ----

/** Remembers whatever each tool is signed in to now; returns provider → active email. */
function rememberAll() {
  const active = {};
  for (const p of PROVIDERS) {
    const l = p.live();
    if (!l) continue;
    active[p.id] = l.email;
    const fields = Object.fromEntries(Object.entries({ name: l.name, plan: l.plan }).filter(([, v]) => v));
    saveSecret(p.id, l.email, l.secret, fields);
  }
  return active;
}

async function row(r, active) {
  const p = byId[r.provider];
  const out = { provider: r.provider, email: r.email, name: r.name ?? "", plan: r.plan ?? "", active: active[r.provider] === r.email, windows: [], at: 0, error: null };
  const secret = loadSecret(r.provider, r.email);
  if (!secret) return { ...out, error: "signed out" };
  try {
    const u = await p.usage(secret, out.active, r.email);
    if (u.secret) saveSecret(r.provider, r.email, u.secret); // refresh tokens are single-use: store it first
    const plan = u.plan || out.plan;
    const at = u.at ?? Date.now();
    updateIndex(r.provider, r.email, { plan, last: { windows: u.windows, at } });
    return { ...out, plan, windows: u.windows, at };
  } catch (e) {
    // keep showing the last numbers seen, with their age
    return { ...out, windows: r.last?.windows ?? [], at: r.last?.at ?? 0, error: e.message };
  }
}

async function list() {
  const active = rememberAll();
  const rows = [];
  // one at a time: the Codex reader is pointed at a saved login through the environment
  for (const r of loadIndex()) if (byId[r.provider]) rows.push(await row(r, active));
  const best = recommend(rows);
  const order = (r) => PROVIDERS.indexOf(byId[r.provider]) * 2 + (r.active ? 0 : 1);
  return rows
    .sort((a, b) => order(a) - order(b))
    .map((r) => ({ ...r, price: priceOf(r.provider, r.plan), best: best[r.provider] === r.email }));
}

function use(provider, email) {
  const p = byId[provider];
  if (!p) throw new Error(`unknown tool ${provider}`);
  const active = rememberAll();
  if (active[provider] === email) return;
  const secret = loadSecret(provider, email);
  if (!secret) throw new Error(`no saved login for ${email}`);
  p.activate(secret);
}

function add(provider) {
  const p = byId[provider];
  if (!p) throw new Error(`unknown tool ${provider}`);
  rememberAll(); // the current login is safe before a new one replaces it
  p.prepareLogin?.();
  const script = p.loginCommand.replace(/[\\"]/g, "\\$&");
  execFileSync("osascript", ["-e", `tell application "Terminal" to do script "${script}"`, "-e", 'tell application "Terminal" to activate']);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [cmd, a, b] = process.argv.slice(2);
  try {
    if (cmd === "list") console.log(JSON.stringify({ accounts: await list() }));
    else if (cmd === "use" && a && b) use(a, b);
    else if (cmd === "add" && a) add(a);
    else throw new Error("usage: accounts.mjs list | use <provider> <email> | add <provider>");
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
