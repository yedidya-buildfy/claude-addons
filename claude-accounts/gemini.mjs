// Gemini (Google AI plan, through the Antigravity CLI): the login is one token file. Usage is known
// only while that account is signed in — the status line's reader catches it from the CLI's own
// callback — so a saved account shows the last numbers seen while it was signed in.
import fs from "node:fs";
import path from "node:path";
import { HOME, jwtClaims, readJson, usageReader, writeFileAtomic } from "./store.mjs";

const LIVE = path.join(HOME, ".gemini", "antigravity-cli", "antigravity-oauth-token");
// the two windows that limit everyday Gemini use; other buckets are per-model extras
const MAIN = { "5h": "gemini-5h", wk: "gemini-weekly" };

export const id = "gemini";
// the Antigravity CLI signs in only inside a terminal
export const loginInTerminal = `"${HOME}/.local/bin/agy"`;

export function live() {
  const tok = readJson(LIVE, null);
  const email = jwtClaims(tok?.id_token ?? "").email;
  return email ? { email, name: "", plan: "", secret: JSON.stringify(tok) } : null;
}


/** The 5h and weekly windows out of the reader's buckets: the main Gemini ones when present. */
export function pickWindows(windows) {
  return ["5h", "wk"].flatMap((label) => {
    const w = windows.find((x) => x.id === MAIN[label]) ?? windows.find((x) => x.label === label);
    return w ? [{ label, pct: w.usedPercent, resets: w.resetsAt ?? 0 }] : [];
  });
}

export async function usage(_secret, active, email) {
  if (!active) throw new Error("not signed in");
  const r = usageReader();
  if (!r) throw new Error("no usage reader");
  await r.fetchGoogle(); // starts the CLI briefly when the numbers are old (at most every 15 min)
  const snap = r.readProviderSnapshot(path.join(HOME, ".claude"), "google");
  if (snap?.status !== "ok" || !String(snap.account ?? "").endsWith(email)) throw new Error("waiting for Antigravity");
  // may be hours old when the CLI was not opened lately; `at` lets the view say so
  return { windows: pickWindows(snap.windows), at: snap.fetchedAt, plan: String(snap.account).split(" · ")[0].replace(/^Google AI /, "") };
}

export function activate(secret) {
  writeFileAtomic(LIVE, secret);
}

/** The CLI asks for a sign-in only when it has no token; the current one is already saved. */
export function prepareLogin() {
  fs.rmSync(LIVE, { force: true });
}
