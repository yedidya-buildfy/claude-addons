#!/bin/bash
# Claude Code tab status — hook handler. Updates per-session state files. A
# detached watcher (~/.claude/scripts/tab-watcher.sh) owns all painting; this
# script only writes state. The watcher is spawned on SessionStart AND on any
# subsequent hook if it died (self-healing) so a stale-cleanup or crash
# doesn't permanently break a live session.

state_dir="$HOME/.claude/terminal-state"
mkdir -p "$state_dir"
log="$state_dir/hooks.log"
action="$1"
input=$(cat)

log_line() { echo "[$(date '+%H:%M:%S')] action=$action pid=$$ ppid=$PPID $*" >> "$log"; }

session=$(echo "$input" | python3 -c 'import sys,json
try: print(json.load(sys.stdin).get("session_id",""))
except: pass' 2>/dev/null)
if [ -z "$session" ]; then
  log_line "no session_id — exiting"
  exit 0
fi

state_file="$state_dir/$session.state"
bg_file="$state_dir/$session.bg"
name_file="$state_dir/$session.name"

get_bg() { cat "$bg_file" 2>/dev/null || echo 0; }
set_bg() { echo "$1" > "$bg_file"; }

# Spawn the watcher if there isn't a live one for this session already.
# Safe to call from any action — that's how the system self-heals if a watcher
# was killed externally or never spawned (e.g. SessionStart hook didn't fire
# because hooks weren't loaded yet when the user started Claude).
ensure_watcher() {
  wpid=$(cat "$state_dir/$session.watcher_pid" 2>/dev/null)
  if [ -n "$wpid" ] && kill -0 "$wpid" 2>/dev/null; then
    return 0
  fi

  pid=$$; tty_dev=""
  for _ in 1 2 3 4 5 6 7 8; do
    t=$(ps -o tty= -p "$pid" 2>/dev/null | tr -d ' ')
    if [ -n "$t" ] && [ "$t" != "??" ]; then
      tty_dev="$t"
      break
    fi
    pid=$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')
    [ -z "$pid" ] && break
  done

  if [ -z "$tty_dev" ]; then
    log_line "ensure_watcher: no TTY"
    return 1
  fi

  [ -f "$name_file" ] || basename "${CLAUDE_PROJECT_DIR:-$PWD}" > "$name_file"

  ( "$HOME/.claude/scripts/tab-watcher.sh" "$session" "$tty_dev" ) </dev/null >/dev/null 2>&1 &
  echo "$!" > "$state_dir/$session.watcher_pid"
  disown 2>/dev/null
  log_line "spawned watcher pid=$! tty=$tty_dev"
}

case "$action" in
  white)
    echo white > "$state_file"
    set_bg 0
    ensure_watcher
    log_line "state=white"
    ;;

  red)
    echo red > "$state_file"
    ensure_watcher
    log_line "state=red"
    ;;

  green)
    echo green > "$state_file"
    ensure_watcher
    log_line "state=green bg=$(get_bg)"
    ;;

  bg-inc)
    is_bg=$(echo "$input" | python3 -c 'import sys,json
try: print(str(json.load(sys.stdin).get("tool_input",{}).get("run_in_background",False)).lower())
except: pass' 2>/dev/null)
    if [ "$is_bg" = "true" ]; then
      set_bg $(( $(get_bg) + 1 ))
      ensure_watcher
      log_line "bg++ now=$(get_bg)"
    fi
    ;;

  bg-dec)
    cur=$(get_bg)
    [ "$cur" -gt 0 ] && set_bg $((cur - 1))
    ensure_watcher
    log_line "bg-- now=$(get_bg)"
    ;;

  session-end)
    wpid=$(cat "$state_dir/$session.watcher_pid" 2>/dev/null)
    if [ -n "$wpid" ]; then
      kill "$wpid" 2>/dev/null
      log_line "killed watcher pid=$wpid"
    fi
    rm -f "$state_file" "$bg_file" "$name_file" "$state_dir/$session.watcher_pid"
    log_line "cleaned up session"
    ;;

  *)
    log_line "unknown action — ignoring"
    ;;
esac

exit 0
