// Codex (ChatGPT plan): the login is ~/.codex/auth.json. Usage comes from the status line's
// Codex reader (the official app-server protocol); a saved account is read through its own
// throw-away Codex home, so the live login is never touched.
import fs from "node:fs";
import path from "node:path";
import { HOME, jwtClaims, readJson, usageReader, writeFileAtomic } from "./store.mjs";

const CODEX_HOME = process.env.CODEX_HOME || path.join(HOME, ".codex");
const LIVE = path.join(CODEX_HOME, "auth.json");
const SPARE_HOME = path.join(HOME, ".claude", "claude-accounts", "codex-home");

export const id = "codex";
export const loginCommand = `"${HOME}/.npm-global/bin/codex" login || command codex login`;

export function live() {
  const auth = readJson(LIVE, null);
  if (auth?.auth_mode !== "chatgpt" || !auth.tokens?.id_token) return null;
  const c = jwtClaims(auth.tokens.id_token);
  if (!c.email) return null;
  const plan = c["https://api.openai.com/auth"]?.chatgpt_plan_type ?? "";
  return { email: c.email, name: c.name ?? "", plan: plan ? plan[0].toUpperCase() + plan.slice(1) : "", secret: JSON.stringify(auth) };
}


export async function usage(secret, active) {
  const r = usageReader();
  if (!r) throw new Error("no usage reader");
  let next = null;
  const prev = process.env.CODEX_HOME;
  if (!active) {
    writeFileAtomic(path.join(SPARE_HOME, "auth.json"), secret);
    process.env.CODEX_HOME = SPARE_HOME;
  }
  try {
    const snap = await r.fetchCodex();
    if (!active) {
      const after = fs.readFileSync(path.join(SPARE_HOME, "auth.json"), "utf8"); // Codex may have refreshed it
      if (after !== secret) next = after;
    }
    if (snap.status !== "ok") throw new Error(snap.reason === "codex-auth" ? "signed out" : snap.reason);
    return { windows: snap.windows.map((w) => ({ label: w.label, pct: w.usedPercent, resets: w.resetsAt ?? 0 })), secret: next };
  } finally {
    if (!active) {
      if (prev === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = prev;
      fs.rmSync(path.join(SPARE_HOME, "auth.json"), { force: true });
    }
  }
}

export function activate(secret) {
  writeFileAtomic(LIVE, secret);
}
