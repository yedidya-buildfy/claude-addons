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
name_file="$state_dir/$session.name"
tty_override="$state_dir/tty.$tty_dev.name"

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

ticks=0
max_ticks=2160000  # ~12h at 20ms
last_state=""
last_name=""
bgsh=0
bgsh_last_check=-1000

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
  bg=$(cat "$bg_file" 2>/dev/null || echo 0)

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

  case "$state" in
    white) dot="⚪" ;;
    red)   dot="🔴" ;;
    blue)  dot="🔵" ;;
    green)
      if [ "$bg" -gt 0 ]; then    dot="🟡"   # background agents still running
      elif [ "$bgsh" -gt 0 ]; then dot="🩵"  # background Bash shells still running (cyan)
      else                         dot="🟢"  # truly idle
      fi
      ;;
    *)     dot="🟢" ;;
  esac

  if [ -f "$tty_override" ]; then
    name=$(cat "$tty_override")
  elif [ -f "$name_file" ]; then
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
