#!/usr/bin/env node
// keep-awake: one switch, shared by every terminal, that keeps the Mac awake with the lid closed.
//
//   awake on     ☕  stay awake (lid open) until `awake off`, Claude working or not
//   awake lid    💻  stay awake even with the lid closed, until 5 min with no work at all
//                    (no Claude session working and no background job busy on the CPU)
//   awake pin    📌  stay awake with the lid closed until `awake off` (safety caps still apply)
//   awake off        back to normal sleep
//   awake            show the current state
//   awake setup      one-time: allow exactly `pmset -a disablesleep 0|1` without a password
//   awake tick       run by the background job every 15s (and after every toggle)
//
// Single source of truth: ~/.claude/awake/state.json. Only `tick` touches the power setting.
// "Claude is working" is read from the OS, not from hooks: while a session works, Claude Code
// itself keeps a `caffeinate -i -t 300` child alive. So a crashed terminal cannot hold the Mac awake.
// ☕ is a short `caffeinate -i -t 30` renewed by every tick: stop ticking and it lapses on its own.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';

const DIR = path.join(os.homedir(), '.claude', 'awake');
const STATE = path.join(DIR, 'state.json');
const LOG = path.join(DIR, 'awake.log');
const SUDOERS = '/etc/sudoers.d/claude-awake';
// "We turned sleep off" lives in its own file, not in state.json: two ticks racing on state.json
// used to drop that fact, and then nothing ever turned sleep back on.
const HELD = path.join(DIR, 'held');

export const LIMITS = {
  maxMs: 12 * 3600e3, // lid modes never outlive this — a forgotten pin must not cook the Mac in a bag
  batteryFloor: 20,   // % on battery: below it, back to normal sleep
  quietMs: 5 * 60e3,  // lid mode ends after this long with no work from anyone, not on one gap
  busyCpu: 30,        // % CPU: a background job (not an app, not Claude itself) above it counts as work
};

export const blank = () => ({ mode: 'off', since: 0, sawWork: false, lastWork: 0, held: false, working: 0, busy: 0, note: '', at: 0 });

// Pure: the next state from the current one and what the OS shows right now.
// obs = { now, working, busy, onBattery, pct }
export function step(s, obs) {
  const n = { ...s, working: obs.working, busy: obs.busy, at: obs.now };
  const off = (note) => Object.assign(n, { mode: 'off', since: 0, sawWork: false, lastWork: 0, note });
  if (n.mode === 'off') return n;
  if (n.mode === 'on') return n; // lid open, in plain sight: no caps, stays until turned off
  if (obs.onBattery && obs.pct != null && obs.pct < LIMITS.batteryFloor) return off(`battery ${obs.pct}%`);
  if (obs.now - n.since > LIMITS.maxMs) return off('12h cap');
  if (n.mode === 'lid') {
    if (obs.working > 0 || obs.busy > 0) Object.assign(n, { sawWork: true, lastWork: obs.now });
    else if (n.sawWork && obs.now - n.lastWork >= LIMITS.quietMs) return off('done');
  }
  return n;
}

// Pure: what a toggle does. Same mode again = off.
export function toggle(s, mode, now) {
  if (mode === 'off' || s.mode === mode) return { ...s, mode: 'off', since: 0, sawWork: false, lastWork: 0, note: 'manual' };
  return { ...s, mode, since: now, sawWork: false, lastWork: 0, note: '' };
}

const read = () => { try { return { ...blank(), ...JSON.parse(fs.readFileSync(STATE, 'utf8')) }; } catch { return blank(); } };
function write(s) {
  fs.mkdirSync(DIR, { recursive: true });
  const tmp = `${STATE}.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(s));
  fs.renameSync(tmp, STATE); // ponytail: no lock — tick and a toggle racing within ms loses one write; next tick repairs
}
const log = (msg) => { try { fs.appendFileSync(LOG, `${new Date().toISOString()} ${msg}\n`); } catch {} };
const sh = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

// A background job = my own process outside apps and the system, busy on the CPU (research
// workers, builds, tests). Claude itself is left out: its idle screen draws CPU too.
export function isBusyJob([, , cpu, user, c], me) {
  if (user !== me || +cpu < LIMITS.busyCpu) return false;
  if (c.includes('.app/') || /^\/(System|usr\/(libexec|sbin))\//.test(c)) return false;
  return path.basename(c) !== 'claude';
}

function observe() {
  const procs = sh('/bin/ps', ['-axo', 'pid=,ppid=,pcpu=,user=,comm='])
    .trim().split('\n').map((l) => /^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(\S+)\s+(.*)$/.exec(l)?.slice(1)).filter(Boolean);
  const comm = new Map(procs.map(([pid, , , , c]) => [pid, path.basename(c)]));
  const working = procs.filter(([, ppid, , , c]) => path.basename(c) === 'caffeinate' && comm.get(ppid) === 'claude').length;
  const me = os.userInfo().username;
  const busy = procs.filter((p) => isBusyJob(p, me)).length;
  const batt = sh('/usr/bin/pmset', ['-g', 'batt']);
  const pct = /(\d+)%/.exec(batt);
  return { now: Date.now(), working, busy, onBattery: /Battery Power/.test(batt), pct: pct ? +pct[1] : null };
}

const sleepDisabled = () => /SleepDisabled\s+1/.test(sh('/usr/bin/pmset', ['-g']));
const held = () => fs.existsSync(HELD);
function setDisable(on) {
  try { sh('/usr/bin/sudo', ['-n', '/usr/bin/pmset', '-a', 'disablesleep', on ? '1' : '0']); }
  catch { return false; }
  if (on) fs.writeFileSync(HELD, ''); else fs.rmSync(HELD, { force: true });
  return true;
}
const notify = (text) => { try { sh('/usr/bin/osascript', ['-e', `display notification ${JSON.stringify(text)} with title "מחשב ער"`]); } catch {} };

export function tick() {
  const before = read();
  const s = step(before, observe());
  const want = s.mode === 'lid' || s.mode === 'pin';
  if (s.mode === 'on') spawn('/usr/bin/caffeinate', ['-i', '-t', '30'], { detached: true, stdio: 'ignore' }).unref();
  const is = sleepDisabled();
  // Only undo a setting we made ourselves; a manual `pmset disablesleep 1` is left alone.
  if (want && !is) s.note = setDisable(true) ? '' : 'setup';
  else if (want) { if (s.note === 'setup') s.note = ''; if (!held()) fs.writeFileSync(HELD, ''); }
  else if (is && held()) setDisable(false);
  else if (!is) fs.rmSync(HELD, { force: true });
  s.held = held();
  if (before.mode !== 'off' && s.mode === 'off' && s.note !== 'manual') {
    log(`auto off: ${s.note}`);
    notify(`חזרה לשינה רגילה: ${NOTES[s.note] || s.note.replace('battery', 'סוללה')}`);
  }
  write(s);
  return s;
}

function setup() {
  const user = os.userInfo().username;
  if (!/^[a-z_][a-z0-9_.-]*$/i.test(user)) throw new Error(`unexpected user name: ${user}`);
  const tmp = path.join(os.tmpdir(), `claude-awake-sudoers-${process.pid}`);
  fs.writeFileSync(tmp, `${user} ALL=(root) NOPASSWD: /usr/bin/pmset -a disablesleep 0, /usr/bin/pmset -a disablesleep 1\n`);
  // One macOS password dialog, asked for. visudo checks the file before it goes live.
  const script = `/usr/sbin/visudo -cf ${tmp} && /usr/bin/install -m 440 -o root -g wheel ${tmp} ${SUDOERS}`;
  try { sh('/usr/bin/osascript', ['-e', `do shell script ${JSON.stringify(script)} with administrator privileges`]); }
  finally { fs.rmSync(tmp, { force: true }); }
}

const WORDS = { on: '☕ ער (המכסה פתוח), עד שמכבים', lid: '💻 ער גם עם מכסה סגורה, עד 5 דקות בלי שום עבודה (קלוד או משימות רקע)', pin: '📌 ער גם עם מכסה סגורה, עד שמכבים', off: 'שינה רגילה' };
const NOTES = { done: '5 דקות בלי עבודה', '12h cap': 'עברו 12 שעות', manual: '' };
function describe(s) {
  let line = WORDS[s.mode];
  if (s.mode === 'lid' && !s.sawWork) line += ' (מחכה שתתחיל עבודה)';
  if (s.note === 'setup') line += ' — לא פעיל עדיין: הרץ פעם אחת awake setup (מבקש את סיסמת המק)';
  if (s.mode === 'off' && s.note && s.note !== 'manual') line += ` (כבה לבד: ${NOTES[s.note] || s.note.replace('battery', 'סוללה')})`;
  return line;
}

function run(arg) {
  if (arg === 'tick') return tick();
  if (arg === 'setup') { setup(); return tick(); }
  if (['on', 'lid', 'pin', 'off'].includes(arg)) { write(toggle(read(), arg, Date.now())); return tick(); }
  if (!arg || arg === 'status') return tick();
  throw new Error(`שימוש: awake on | lid | pin | off | setup`);
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('/awake')) {
  const arg = process.argv[2];
  try {
    if (arg === 'tick') tick();
    else console.log(describe(run(arg)));
  } catch (e) { console.error(e.message); process.exitCode = 1; }
}
