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
prev_state() { cat "$state_file" 2>/dev/null; }

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
    p=$(prev_state); echo white > "$state_file"; set_bg 0
    ensure_watcher
    log_line "state: $p → white"
    # Inject a reminder about the tab-name skill into Claude's session context.
    # Only fires if the skill is actually installed.
    if [ -f "$HOME/.claude/skills/tab-name/SKILL.md" ]; then
      cat <<'JSON'
{
  "hookSpecificOutput": {
    "hookEventName": "SessionStart",
    "additionalContext": "[claude-addons] The `tab-name` skill is installed. Per its when_to_use rules: as soon as you can identify the topic in 1-3 words (usually after the user's 1st or 2nd substantive message), pick a name yourself, apply silently with `~/.claude/scripts/tn \"<name>\"`, and add a one-line text-question at the end of your response (e.g. `(Renamed tab to \"auth bug\" — different one?)`). Re-fire on topic shifts. Default project-basename name is a placeholder — replace it."
  }
}
JSON
    fi
    ;;

  red)
    p=$(prev_state); echo red > "$state_file"
    ensure_watcher
    log_line "state: $p → red"
    ;;

  remind-name)
    # Re-inject the tab-name reminder on every UserPromptSubmit, but only
    # while no manual override exists for this TTY. Stops once a name is
    # pinned (by Claude or by `tn`). Fixes the "skill fires only at
    # SessionStart and gets forgotten in long sessions" problem.
    [ -f "$HOME/.claude/skills/tab-name/SKILL.md" ] || exit 0

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
    [ -z "$tty_dev" ] && exit 0

    if [ ! -f "$state_dir/tty.$tty_dev.name" ]; then
      log_line "remind-name: no override for $tty_dev — injecting reminder"
      cat <<'JSON'
{
  "hookSpecificOutput": {
    "hookEventName": "UserPromptSubmit",
    "additionalContext": "[claude-addons] The VS Code tab still shows the default project basename — the `tab-name` skill has not been applied yet. If you can describe what this session is about in 1-3 words, pick a name now and apply it silently with `~/.claude/scripts/tn \"<name>\"`, then add a one-line text-question at the end of your response (e.g. `(Renamed tab to \"auth bug\" — different one?)`). If the topic still isn't clear, skip — this reminder will fire again on the next prompt."
  }
}
JSON
    fi
    ;;

  blue)
    # Claude is waiting on user input (AskUserQuestion).
    p=$(prev_state); echo blue > "$state_file"
    ensure_watcher
    log_line "state: $p → blue (AskUserQuestion)"
    ;;

  green)
    # Claude fires Stop while AskUserQuestion is waiting for the user. Don't
    # let that overwrite blue — only transition to green if we're not waiting.
    p=$(prev_state)
    if [ "$p" = "blue" ]; then
      log_line "state: blue (preserved — Stop fired during AskUserQuestion wait)"
    else
      echo green > "$state_file"
      ensure_watcher
      log_line "state: $p → green bg=$(get_bg)"
    fi
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
