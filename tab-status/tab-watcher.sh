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

ticks=0
max_ticks=864000   # ~12h at 50ms
last_state=""
last_name=""

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
  case "$state" in
    white) dot="⚪" ;;
    red)   dot="🔴" ;;
    blue)  dot="🔵" ;;
    green) [ "$bg" -gt 0 ] && dot="🟡" || dot="🟢" ;;
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

  # heartbeat: one line every 120 ticks (~6s at 50ms) — just for liveness check
  if [ "$((ticks % 120))" -eq 0 ]; then
    echo "[$(date '+%H:%M:%S')] heartbeat session=$session tick=$ticks state=$state dot=$dot name='$name' paint_ok=$paint_ok bg=$bg" >> "$log"
  fi

  sleep 0.05
  ticks=$((ticks + 1))
done

echo "[$(date '+%H:%M:%S')] EXIT session=$session reason=max_ticks" >> "$log"
exit 0
