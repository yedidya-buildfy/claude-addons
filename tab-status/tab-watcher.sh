#!/bin/bash
# Long-running paint loop for one Claude session. Spawned by tab.sh on
# SessionStart. Reads state every 300ms and writes OSC to the TTY — overwrites
# Claude Code's own competing title writes. Exits cleanly when its state file
# is removed (by tab.sh session-end) or if the claude parent process disappears.

session="$1"
tty_dev="$2"
state_dir="$HOME/.claude/terminal-state"
log="$state_dir/watcher.log"

state_file="$state_dir/$session.state"
bg_file="$state_dir/$session.bg"
bg_hint_file="$state_dir/$session.bg_hint"
name_file="$state_dir/$session.name"
plan_wait_file="$state_dir/$session.plan_wait"

# Reverse pointer so `tn` can resolve THIS tty → the live session, regardless of
# TTY-number reuse across VS Code windows. Rewritten by each session's watcher;
# removed on exit. (Old scheme keyed names by tty.$tty_dev.name, which leaked
# stale names onto recycled TTY numbers — see tn.)
session_map="$state_dir/tty.$tty_dev.session"
echo "$session" > "$session_map"
# Must exit on TERM/INT — a bare trap without exit resumes the loop, so the
# watcher would survive `kill` (tab.sh session-end uses SIGTERM) and orphan.
cleanup() { rm -f "$session_map"; }
trap cleanup EXIT
trap 'cleanup; exit 0' TERM INT

echo "[$(date '+%H:%M:%S')] START session=$session tty=$tty_dev watcher_pid=$$" >> "$log"

# Count live background Bash-tool shells for this session. A backgrounded Bash
# tool call runs as a zsh child of the `claude` process on our TTY, executing a
# shell-snapshot eval. Foreground Bash shells have already exited by the time
# Claude is idle (green), so any that survive are `run_in_background:true`
# shells. This is fully self-healing: Claude Code emits no "background shell
# finished" hook, but when the shell exits its process is gone, so the count
# drops on its own with no decrement event to wire up.
claude_pid=""
count_bg_shells() {
  # (Re)discover the claude PID on this TTY if we don't have a live one.
  if [ -z "$claude_pid" ] || ! kill -0 "$claude_pid" 2>/dev/null; then
    claude_pid=$(ps -o pid=,tty=,comm= -t "$tty_dev" 2>/dev/null | awk '$3 ~ /claude/ {print $1; exit}')
  fi
  [ -z "$claude_pid" ] && { echo 0; return; }
  local n=0 c cmd
  for c in $(pgrep -P "$claude_pid" 2>/dev/null); do
    cmd=$(ps -o command= -p "$c" 2>/dev/null)
    case "$cmd" in *shell-snapshots*) n=$((n + 1)) ;; esac
  done
  echo "$n"
}

transcript_file=""
find_transcript() {
  if [ -n "$transcript_file" ] && [ -f "$transcript_file" ]; then
    echo "$transcript_file"
    return
  fi
  transcript_file=$(find "$HOME/.claude/projects" -type f -name "$session.jsonl" -print -quit 2>/dev/null)
  echo "$transcript_file"
}

# Claude Code records the exact pending background-agent count in the main
# session transcript as system/turn_duration.pendingBackgroundAgentCount. That
# record can lag behind a fresh bg-inc hook, so keep .bg as a launch hint until
# a newer turn_duration record catches up.
#
# The same scan also reads the latest `permission-mode` record, which is how we
# know plan mode is on — that covers the user toggling it with shift+tab, which
# fires no hook at all. Prints "<bg count> <1|0 plan mode>".
read_transcript_state() {
  local transcript
  transcript=$(find_transcript)
  python3 - "$transcript" "$bg_file" "$bg_hint_file" <<'PY' 2>/dev/null
import datetime
import json
import os
import sys

transcript, bg_file, hint_file = sys.argv[1:4]

def read_int(path):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return max(0, int((f.read() or "0").strip() or "0"))
    except Exception:
        return 0

def parse_ts(value):
    if not value:
        return 0.0
    try:
        return datetime.datetime.fromisoformat(
            value.replace("Z", "+00:00")
        ).timestamp()
    except Exception:
        return 0.0

hint = read_int(bg_file)
try:
    hint_time = os.path.getmtime(hint_file)
except Exception:
    hint_time = 0.0

plan = 0

def emit(bg):
    print(f"{bg} {plan}")
    raise SystemExit

if not transcript or not os.path.exists(transcript):
    emit(hint)

try:
    with open(transcript, "rb") as f:
        size = os.path.getsize(transcript)
        f.seek(max(0, size - 256 * 1024))
        lines = f.read().decode("utf-8", "ignore").splitlines()
except Exception:
    emit(hint)

count = None
record_time = 0.0
for line in reversed(lines):
    try:
        obj = json.loads(line)
    except Exception:
        continue
    if plan == 0 and obj.get("type") == "permission-mode":
        plan = 1 if obj.get("permissionMode") == "plan" else -1
    if count is None and obj.get("type") == "system" and obj.get("subtype") == "turn_duration":
        try:
            count = max(0, int(obj.get("pendingBackgroundAgentCount", 0) or 0))
        except Exception:
            count = 0
        record_time = parse_ts(obj.get("timestamp"))
    if count is not None and plan != 0:
        break
plan = 1 if plan == 1 else 0

if count is None:
    emit(hint)

if hint > 0 and (record_time == 0.0 or record_time < hint_time):
    emit(max(hint, count))

try:
    with open(bg_file, "w", encoding="utf-8") as f:
        f.write(f"{count}\n")
except Exception:
    pass
if count == 0:
    try:
        os.unlink(hint_file)
    except FileNotFoundError:
        pass
    except Exception:
        pass
emit(count)
PY
}

ticks=0
max_ticks=2160000  # ~12h at 20ms
last_state=""
last_name=""
last_dot=""
bg=0
bg_last_check=-1000
bgsh=0
bgsh_last_check=-1000
planmode=0

while [ "$ticks" -lt "$max_ticks" ]; do
  # clean shutdown signal from SessionEnd
  if [ ! -f "$state_file" ]; then
    echo "[$(date '+%H:%M:%S')] EXIT session=$session reason=state_file_gone ticks=$ticks" >> "$log"
    exit 0
  fi

  # terminal closed (TTY device removed by kernel when last fd closed)
  if [ ! -e "/dev/$tty_dev" ]; then
    echo "[$(date '+%H:%M:%S')] EXIT session=$session reason=tty_gone ticks=$ticks" >> "$log"
    rm -f "$state_file" "$bg_file" "$name_file" "$state_dir/$session.watcher_pid"
    exit 0
  fi

  state=$(cat "$state_file" 2>/dev/null)

  # Poll the transcript at ~3 Hz. It is cheap and, unlike hook inc/dec, it
  # tracks the exact count Claude uses for "Waiting for N background agents".
  if [ "$((ticks - bg_last_check))" -ge 15 ]; then
    read -r bg planmode <<< "$(read_transcript_state)"
    case "$bg" in ''|*[!0-9]*) bg=0 ;; esac
    case "$planmode" in ''|*[!0-9]*) planmode=0 ;; esac
    bg_last_check=$ticks
  fi

  # Background Bash shells only change the dot once Claude is idle (green).
  # Poll the process tree at ~3 Hz — cheap next to the 50 Hz paint loop — and
  # skip it entirely while working, where the dot is red/blue regardless.
  if [ "$state" = "green" ]; then
    if [ "$((ticks - bgsh_last_check))" -ge 15 ]; then
      bgsh=$(count_bg_shells)
      bgsh_last_check=$ticks
    fi
  else
    bgsh=0
  fi

  # Compose the badge from concurrent activities instead of collapsing to one.
  # foreground state (always) + background agents (always — bg is an exact
  # counter, accurate even while red) + background shells (idle-only — can't
  # cheaply tell bg from fg shells while working, so bgsh is 0 unless green).
  case "$state" in
    white) base="⚪" ;;
    red)   base="🔴" ;;
    blue)  base="🔵" ;;
    green) base="🟢" ;;
    *)     base="🟢" ;;
  esac
  # Plan mode gets its own colours so "thinking up a plan" and "plan is on the
  # table, waiting for a yes/no" don't both look like ordinary work (red).
  # 🟠 wins over 🟣 — the decision prompt is the thing the user must act on.
  if [ -f "$plan_wait_file" ]; then
    base="🟠"
  elif [ "$planmode" -gt 0 ] && [ "$state" != "green" ]; then
    base="🟣"
  fi
  # Space-separate badges: VS Code's tab title renders two ADJACENT emoji as
  # tofu (◇), but each emoji alone renders fine. So join with spaces.
  dot="$base"
  [ "$bg"   -gt 0 ] && dot="$dot 🟡"   # background agents running
  [ "$bgsh" -gt 0 ] && dot="$dot 🟤"   # background Bash shells running

  if [ -f "$name_file" ]; then
    name=$(cat "$name_file")
  else
    name="claude"
  fi

  # Log on actual changes — these are the events worth seeing in the trace.
  if [ "$state" != "$last_state" ]; then
    echo "[$(date '+%H:%M:%S')] state_change session=$session: '$last_state' → '$state' (dot=$dot)" >> "$log"
    last_state="$state"
  fi
  if [ "$name" != "$last_name" ]; then
    echo "[$(date '+%H:%M:%S')] name_change session=$session: '$last_name' → '$name'" >> "$log"
    last_name="$name"
  fi
  if [ "$dot" != "$last_dot" ]; then
    echo "[$(date '+%H:%M:%S')] dot_change session=$session: '$last_dot' → '$dot' (state=$state bg=$bg bgsh=$bgsh plan=$planmode wait=$([ -f "$plan_wait_file" ] && echo 1 || echo 0))" >> "$log"
    last_dot="$dot"
  fi

  if [ -w "/dev/$tty_dev" ]; then
    printf '\033]0;%s %s\a' "$dot" "$name" > "/dev/$tty_dev" 2>/dev/null
    paint_ok=1
  else
    paint_ok=0
  fi

  # heartbeat: one line every 300 ticks (~6s at 20ms) — just for liveness check
  if [ "$((ticks % 300))" -eq 0 ]; then
    echo "[$(date '+%H:%M:%S')] heartbeat session=$session tick=$ticks state=$state dot=$dot name='$name' paint_ok=$paint_ok bg=$bg bgsh=$bgsh" >> "$log"
  fi

  sleep 0.02
  ticks=$((ticks + 1))
done

echo "[$(date '+%H:%M:%S')] EXIT session=$session reason=max_ticks" >> "$log"
exit 0
