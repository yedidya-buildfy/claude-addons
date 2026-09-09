#!/usr/bin/env node
// Who is holding which file, when several Claude sessions share one folder.
//
// Plain code, no model in the loop: Claude Code runs this before every file
// write and before every push/deploy command, and again the moment a session
// goes quiet. It only WARNS — nothing is ever blocked — because a false alarm
// that stops work is worse than a warning that is read and dismissed.
//
//   node agent-locks.mjs claim    # PreToolUse on Edit|Write|…  (stdin: hook JSON)
//   node agent-locks.mjs deploy   # PreToolUse on Bash push/deploy commands
//   node agent-locks.mjs release  # Stop / SessionEnd — drop this session's claims
//   node agent-locks.mjs list     # for a human: who holds what right now
//   node agent-locks.mjs clear    # for a human: forget everything
//
// A claim is keyed by the file's ABSOLUTE path, which is what makes this
// self-scoping: two sessions in one checkout collide and are warned; a session
// working in its own worktree has different paths, so it is never warned and
// never mentioned. That asymmetry is the whole design — the quiet way to work
// is to have your own copy.
//
// The store is one small file per held path under ~/.claude/agent-locks.
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const STORE = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "agent-locks");
// A session that has not touched a file for this long is presumed gone (crash,
// closed tab); its claim stops being mentioned. Stop/SessionEnd normally
// releases first, so this is only the backstop.
const STALE_MS = 15 * 60 * 1000;
const DEPLOY_KEY = "_deploy";
/** Commands that put something somewhere other people can see. */
const SHIPS =
  /(^|[\s;&|(])(git\s+push|npm\s+run\s+deploy|yarn\s+deploy|pnpm\s+deploy|(npx\s+)?convex\s+(deploy|dev\s+--once)|(npx\s+)?vercel\s+(deploy|--prod)|fly\s+deploy|wrangler\s+(deploy|publish))\b/;

const now = () => Date.now();
const keyOf = (path) => createHash("sha1").update(path).digest("hex").slice(0, 16);
const fileOf = (key) => join(STORE, `${key}.json`);

function readLock(key) {
  try {
    return JSON.parse(readFileSync(fileOf(key), "utf8"));
  } catch {
    return null;
  }
}

function writeLock(key, lock) {
  mkdirSync(STORE, { recursive: true });
  writeFileSync(fileOf(key), JSON.stringify(lock));
}

function locks() {
  try {
    return readdirSync(STORE).filter((n) => n.endsWith(".json"));
  } catch {
    return [];
  }
}

const live = (lock) => !!lock && now() - (lock.seen ?? 0) < STALE_MS;
const mine = (lock, session) => !!lock && lock.session === session;

const ago = (t) => {
  const m = Math.round((now() - t) / 60000);
  return m < 1 ? "פחות מדקה" : m === 1 ? "דקה" : `${m} דקות`;
};

/** Hook input arrives as one JSON object on stdin. */
async function stdinJson() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    return {};
  }
}

/** Claude Code shows this and hands it to the model; anything else is silence. */
function warn(text) {
  process.stdout.write(
    JSON.stringify({
      systemMessage: text,
      hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: text },
    }),
  );
}

/** The name a person would recognise: the tab's, else a slice of the session id. */
const labelOf = (session) =>
  process.env.CLAUDE_AGENT_LABEL || process.env.CLAUDE_TAB_NAME || session.slice(0, 8);

const argv = process.argv[2] ?? "list";

if (argv === "claim" || argv === "deploy") {
  const input = await stdinJson();
  const session = input.session_id ?? "unknown";
  const label = labelOf(session);

  if (argv === "claim") {
    const raw = input.tool_input?.file_path ?? input.tool_input?.notebook_path;
    if (!raw) process.exit(0);
    const path = resolve(raw);

    const key = keyOf(path);
    const held = readLock(key);
    if (live(held) && !mine(held, session)) {
      warn(
        `שים לב: ${path} נמצא בעריכה של סשן אחר (${held.label}), מאז לפני ` +
          `${ago(held.started)}. אפשר להמשיך, אבל עדיף לעבוד בעותק עבודה משלך או ` +
          `לשאול את המשתמש מה קורה — שני סשנים באותו קובץ הם איך שעבודה נעלמת.`,
      );
    }
    // Claim it either way: my own touch is a fact whatever anybody else is doing.
    writeLock(key, {
      path,
      session,
      label,
      started: mine(held, session) ? held.started : now(),
      seen: now(),
    });
    process.exit(0);
  }

  // deploy: one global claim, so two sessions never push or deploy at once.
  //
  // The command is matched HERE rather than by the hook's own `if` filter: not
  // every Claude Code build honours that filter, and one that ignores it turns
  // every `ls` into a deploy claim. Plain code, checked in one place.
  const command = input.tool_input?.command ?? "";
  if (!SHIPS.test(command)) process.exit(0);
  const held = readLock(DEPLOY_KEY);
  if (live(held) && !mine(held, session)) {
    warn(
      `שים לב: סשן אחר (${held.label}) התחיל דחיפה/העלאה לפני ${ago(held.started)} ` +
        `ועדיין באמצע. שתי העלאות במקביל דורסות אחת את השנייה — כדאי לחכות שיסיים.`,
    );
  }
  writeLock(DEPLOY_KEY, {
    path: DEPLOY_KEY,
    command,
    session,
    label,
    started: mine(held, session) ? held.started : now(),
    seen: now(),
  });
  process.exit(0);
}

if (argv === "release") {
  const input = await stdinJson();
  const session = input.session_id ?? "unknown";
  for (const name of locks()) {
    const lock = readLock(name.replace(/\.json$/, ""));
    if (lock && lock.session === session) rmSync(join(STORE, name), { force: true });
  }
  process.exit(0);
}

if (argv === "clear") {
  rmSync(STORE, { recursive: true, force: true });
  console.log("all claims forgotten");
  process.exit(0);
}

// list
let any = false;
for (const name of locks()) {
  const lock = readLock(name.replace(/\.json$/, ""));
  if (!live(lock)) continue;
  any = true;
  const what = lock.path === DEPLOY_KEY ? `PUSH/DEPLOY (${lock.command})` : lock.path;
  console.log(`${lock.label}\t${ago(lock.started)}\t${what}`);
}
if (!any) console.log("nobody is holding anything");
