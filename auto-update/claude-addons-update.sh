#!/bin/bash
# claude-addons-update.sh — checks for updates to claude-addons and applies them.
# Can run automatically in the background (throttled) or manually (forced).

set -eo pipefail

FORCE=0
QUIET=0
for arg in "$@"; do
  case "$arg" in
    -f|--force) FORCE=1 ;;
    -q|--quiet) QUIET=1 ;;
  esac
done

CLAUDE_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
REPO_FILE="$CLAUDE_DIR/addons-repo-path"
CACHE_DIR="$HOME/.claude/cache"
STAMP_FILE="$CACHE_DIR/addons-update-last"   # last try
OK_FILE="$CACHE_DIR/addons-update-ok"         # last check that reached the repo and left this machine up to date
LOG_FILE="$CACHE_DIR/addons-update.log"

mkdir -p "$CACHE_DIR"

log() {
  local msg="[$(date '+%Y-%m-%d %H:%M:%S')] $1"
  echo "$msg" >> "$LOG_FILE"
  if [ "$QUIET" = 0 ]; then
    printf '%s\n' "$1"
  fi
}

err() {
  local msg="[$(date '+%Y-%m-%d %H:%M:%S')] ERROR: $1"
  echo "$msg" >> "$LOG_FILE"
  if [ "$QUIET" = 0 ]; then
    printf '\033[31m%s\033[0m\n' "$1" >&2
  fi
}

# Background runs (hourly timer, terminal, session start) only go when the schedule
# says so: once a day at 11:00, one more try for each day without a successful
# check, up to every hour. A skipped run is logged, so the log always explains
# why an update did not happen yet. No node or no rule file → go, never block.
DUE="$HOME/.claude/scripts/claude-addons-due.mjs"
if [ "$FORCE" = 0 ] && [ -f "$DUE" ] && command -v node >/dev/null 2>&1; then
  ok_ms=$(( $(stat -f %m "$OK_FILE" 2>/dev/null || echo 0) * 1000 ))
  try_ms=$(( $(stat -f %m "$STAMP_FILE" 2>/dev/null || echo 0) * 1000 ))
  if ! why=$(node "$DUE" "$ok_ms" "$try_ms"); then
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] skipped: $why" >> "$LOG_FILE"
    exit 0
  fi
  log "checking ($why)"
fi
# Every try counts, found or not, so a failing machine moves to its next slot
touch "$STAMP_FILE"

# Locate git repository
REPO=""
if [ -f "$REPO_FILE" ]; then
  REPO="$(cat "$REPO_FILE" 2>/dev/null | tr -d '\r\n' || true)"
fi
if [ -z "$REPO" ] || [ ! -d "$REPO/.git" ]; then
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  if [ -d "$SCRIPT_DIR/../.git" ]; then
    REPO="$(cd "$SCRIPT_DIR/.." && pwd)"
  fi
fi
if [ -z "$REPO" ] || [ ! -d "$REPO/.git" ]; then
  for candidate in "$HOME/.claude-addons" "$HOME/claude-addons" "$HOME/Desktop/claude-addons"; do
    if [ -d "$candidate/.git" ]; then
      REPO="$candidate"
      break
    fi
  done
fi

if [ -z "$REPO" ] || [ ! -d "$REPO/.git" ]; then
  err "repository path not found. Run ./install.sh from your clone once."
  exit 0
fi

# Ensure we're in the repo
cd "$REPO"

# Check if repo has a valid remote
REMOTE_URL="$(git remote get-url origin 2>/dev/null || true)"
if [ -z "$REMOTE_URL" ]; then
  err "git origin remote not configured in $REPO"
  exit 0
fi

# Check for local uncommitted changes
if ! git diff --quiet 2>/dev/null || ! git diff --cached --quiet 2>/dev/null; then
  log "local uncommitted changes in $REPO — skipping auto-update to avoid conflicts"
  exit 0
fi

# Determine default branch (master or main)
DEFAULT_BRANCH="$(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's@^refs/remotes/origin/@@' || true)"
[ -n "$DEFAULT_BRANCH" ] || DEFAULT_BRANCH="master"

# Fetch remote quietly with timeout protection
if ! git fetch origin "$DEFAULT_BRANCH" --quiet 2>> "$LOG_FILE"; then
  log "could not reach remote repository (offline or rate limited) — will try again later"
  exit 0
fi

LOCAL_REV="$(git rev-parse HEAD 2>/dev/null || true)"
REMOTE_REV="$(git rev-parse "origin/$DEFAULT_BRANCH" 2>/dev/null || true)"

if [ "$LOCAL_REV" = "$REMOTE_REV" ]; then
  log "claude-addons is already up to date ($LOCAL_REV)."
  touch "$OK_FILE"
  exit 0
fi

log "updating claude-addons: $LOCAL_REV -> $REMOTE_REV..."

# Fast-forward pull
if ! git pull --ff-only origin "$DEFAULT_BRANCH" >> "$LOG_FILE" 2>&1; then
  err "failed to fast-forward $DEFAULT_BRANCH. Check $LOG_FILE"
  exit 0
fi

# Make this machine match its saved choices with the new version
log "applying add-ons..."
if "$REPO/install.sh" --update >> "$LOG_FILE" 2>&1; then touch "$OK_FILE"; else err "applying add-ons failed — see $LOG_FILE, or run: addons status"; fi

# If ccx-rewrite was running, restart it to pick up new code
REWRITE_PID="$HOME/.cli-proxy-api/ccx-rewrite.pid"
if [ -f "$REWRITE_PID" ]; then
  PID="$(cat "$REWRITE_PID" 2>/dev/null | tr -d '\r\n' || true)"
  if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
    if [ -x "$CLAUDE_DIR/scripts/ccx" ]; then
      log "restarting ccx proxy..."
      "$CLAUDE_DIR/scripts/ccx" --restart >> "$LOG_FILE" 2>&1 || true
    fi
  fi
fi

log "claude-addons successfully updated to $(git rev-parse --short HEAD)."
