// Where remembered logins live: the secret part in the macOS Keychain (one item per account),
// the harmless part (who, which plan, last usage seen) in a small index file.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

export const HOME = os.homedir();
const SERVICE = "claude-accounts";
const INDEX = path.join(HOME, ".claude", "claude-accounts", "index.json");

export function readItem(service, account) {
  try {
    const args = ["find-generic-password", "-s", service, "-w"];
    if (account) args.splice(1, 0, "-a", account);
    return execFileSync("security", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

// Same as Claude Code: through `security -i` on stdin so the secret stays out of the process list,
// and as an argument (visible for a moment) only when it is longer than that prompt accepts.
// Errors never carry the payload: `security` echoes it back.
const STDIN_MAX = 4000;
export function writeItem(service, account, text) {
  const hex = Buffer.from(text, "utf8").toString("hex");
  const quote = (s) => `"${s.replace(/["\\]/g, "\\$&")}"`;
  const line = `add-generic-password -U -a ${quote(account)} -s ${quote(service)} -X ${hex}`;
  try {
    const out = line.length <= STDIN_MAX
      ? execFileSync("security", ["-i"], { input: `${line}\n`, encoding: "utf8", stdio: ["pipe", "pipe", "ignore"] })
      : execFileSync("security", ["add-generic-password", "-U", "-a", account, "-s", service, "-X", hex], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    if (/error|unknown command/i.test(out)) throw new Error();
  } catch {
    throw new Error(`could not save the login for ${account} in the Keychain`);
  }
}

export const readJson = (file, fallback) => {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
};

export function writeFileAtomic(file, text, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, { mode });
  fs.renameSync(tmp, file);
}

export const writeJson = (file, value, mode) => writeFileAtomic(file, JSON.stringify(value, null, 2), mode);

// Claude logins were saved under the bare email before other providers existed.
const slotKey = (provider, email) => (provider === "claude" ? email : `${provider}:${email}`);

/** Index rows: { provider, email, name, plan, last: { windows, at } }. Old format = list of Claude emails. */
export function loadIndex() {
  return readJson(INDEX, []).map((r) => (typeof r === "string" ? { provider: "claude", email: r } : r));
}

export function updateIndex(provider, email, fields) {
  const index = loadIndex();
  const i = index.findIndex((r) => r.provider === provider && r.email === email);
  const row = { ...(index[i] ?? { provider, email }), ...fields };
  if (i < 0) index.push(row); else index[i] = row;
  writeJson(INDEX, index);
}

export const loadSecret = (provider, email) => readItem(SERVICE, slotKey(provider, email));

/** Saves a login; skips the keychain write when nothing changed. */
export function saveSecret(provider, email, text, fields = {}) {
  if (loadSecret(provider, email) !== text) writeItem(SERVICE, slotKey(provider, email), text);
  updateIndex(provider, email, fields);
}

/** The middle part of a JWT, decoded; {} when it is not one. */
export function jwtClaims(jwt) {
  try { return JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString("utf8")); } catch { return {}; }
}

// ponytail: the status line add-on owns the Codex and Gemini usage readers; without it those rows show "no usage reader"
export function usageReader() {
  try { return createRequire(import.meta.url)(path.join(HOME, ".claude", "provider-usage.js")); } catch { return null; }
}
