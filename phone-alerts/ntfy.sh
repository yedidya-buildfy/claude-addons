#!/bin/sh
# Push a Claude Code event to the ntfy app on your phone.
#
#   ntfy.sh --setup              mint a private topic and print how to subscribe
#   ntfy.sh need|ask|plan|done   (hook JSON on stdin) — called by hooks
#
# Topic resolution: $CLAUDE_NTFY_TOPIC, else ~/.claude/ntfy-topic.
# With neither, this exits quietly — nothing is sent to anyone else's phone.

topic_file="$HOME/.claude/ntfy-topic"
SERVER="${CLAUDE_NTFY_SERVER:-https://ntfy.sh}"
GAP="${CLAUDE_NTFY_GAP:-5}"        # seconds between any two pushes
state="${TMPDIR:-/tmp}"
lock="$state/ntfy-cc.lock"
last_file="$state/ntfy-cc.last"

if [ "$1" = "--setup" ]; then
  if [ -s "$topic_file" ]; then
    t=$(cat "$topic_file"); echo "Topic already set: $t"
  else
    t="cc-$(head -c 8 /dev/urandom | od -An -tx1 | tr -d ' \n')"
    printf '%s' "$t" > "$topic_file"; chmod 600 "$topic_file"
    echo "New topic: $t"
  fi
  cat <<TXT

Anyone who knows the topic can read your notifications, so keep it private
and never commit it. To receive them:

  1. Install the ntfy app (iOS / Android), or open $SERVER/$t in a browser.
  2. Subscribe to the topic:  $t
  3. Test:  echo '{}' | "$0" ask

TXT
  exit 0
fi

TOPIC="${CLAUDE_NTFY_TOPIC:-$(cat "$topic_file" 2>/dev/null)}"
[ -n "$TOPIC" ] || exit 0   # not configured — stay silent

in=$(cat)
cwd=$(printf '%s' "$in" | jq -r '.cwd // ""')
sid=$(printf '%s' "$in" | jq -r '.session_id // "x"')
proj=$(printf '%s' "$cwd" | sed 's|/*$||; s|.*/||')

# A background agent runs in a worktree named after its own id. Nobody wants to
# read that, so climb to the repo the worktree belongs to.
case "$proj" in
  agent-*)
    g=$(cd "$cwd" 2>/dev/null && git rev-parse --path-format=absolute --git-common-dir 2>/dev/null)
    if [ -n "$g" ]; then proj=$(basename "$(dirname "$g")"); else proj=""; fi ;;
esac
[ -n "$proj" ] || proj="claude"

# Tab name, as set by tn/tab.sh. Append it unless it is just the folder name.
tab=$(head -1 "$HOME/.claude/terminal-state/$sid.name" 2>/dev/null)
label="$proj"
if [ -n "$tab" ] && [ "$tab" != "$proj" ]; then label="$proj · $tab"; fi

# One prompt can trip two hooks at once (Notification + PreToolUse). Drop the
# second one rather than queue it.
stamp="$state/ntfy-cc-$sid"
now=$(date +%s)
if [ -f "$stamp" ] && [ $((now - $(cat "$stamp"))) -lt "$GAP" ]; then exit 0; fi
printf '%s' "$now" > "$stamp"

case "$1" in
  need) title="❓ $label"; prio=4
        msg=$(printf '%s' "$in" | jq -r '.message // "מחכה לתשובה שלך"') ;;
  ask)  title="❓ $label"; prio=4; msg="שאלה מחכה לך" ;;
  plan) title="📋 $label"; prio=4; msg="תוכנית מוכנה לאישור" ;;
  done) title="✅ $label"; prio=3
        sleep 1  # let the final reply land in the transcript first
        tp=$(printf '%s' "$in" | jq -r '.transcript_path // ""')
        msg=$(tail -n 400 "$tp" 2>/dev/null | jq -rs '
          [ .[] | select(.type == "assistant")
                | [.message.content[]? | select(.type == "text") | .text]
                | join(" ") | gsub("\\s+"; " ")
                | select(length > 0) ] | last | .[0:180]' 2>/dev/null)
        [ -n "$msg" ] && [ "$msg" != "null" ] || msg="סיים לעבוד" ;;
  *)    exit 0 ;;
esac

# Serialise across every session so simultaneous pushes arrive one after the
# other, GAP seconds apart, instead of landing on the phone as one clump.
tries=0
while ! mkdir "$lock" 2>/dev/null; do
  held=$(cat "$lock/ts" 2>/dev/null)
  # No timestamp yet means the holder just won the race, not that it died.
  case "$held" in ''|*[!0-9]*) held=$(date +%s) ;; esac
  if [ $(($(date +%s) - held)) -gt 60 ]; then rm -rf "$lock"; continue; fi
  tries=$((tries + 1))
  if [ "$tries" -gt 300 ]; then exit 0; fi   # ~60s queued; give up quietly
  sleep 0.2
done
date +%s > "$lock/ts"
trap 'rm -rf "$lock"' EXIT INT TERM HUP

wait=$((GAP - ($(date +%s) - $(cat "$last_file" 2>/dev/null || echo 0))))
if [ "$wait" -gt 0 ]; then sleep "$wait"; fi

jq -nc --arg t "$TOPIC" --arg ti "$title" --arg m "$msg" --argjson p "$prio" \
  '{topic:$t,title:$ti,message:$m,priority:$p}' \
| curl -fsS -m 10 -d @- "$SERVER" >/dev/null 2>&1 || true
date +%s > "$last_file"
