#!/bin/bash
# Standalone, idempotent installer for global `ccx` on macOS.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DRY_RUN=0
YES=0
SKIP_LOGIN=0
BACKUP_DIR=""

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --yes) YES=1 ;;
    --skip-login) SKIP_LOGIN=1 ;;
    *) printf 'Unknown option: %s\n' "$arg" >&2; exit 2 ;;
  esac
done

[ "$(uname -s)" = Darwin ] || { printf 'ccx installer supports macOS only.\n' >&2; exit 2; }

confirm_install() {
  local answer
  [ "$YES" = 1 ] && return 0
  read -r -p "$1 [y/N] " answer </dev/tty
  case "$answer" in y|Y|yes|YES) return 0 ;; *) return 1 ;; esac
}

confirm_user() {
  local answer
  read -r -p "$1 [y/N] " answer </dev/tty
  case "$answer" in y|Y|yes|YES) return 0 ;; *) return 1 ;; esac
}

if ! command -v brew >/dev/null 2>&1; then
  printf 'Homebrew is required. Official installer:\n'
  printf '  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"\n'
  [ "$DRY_RUN" = 1 ] && exit 0
  confirm_install 'Install Homebrew now?' || exit 1
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  if [ -x /opt/homebrew/bin/brew ]; then eval "$(/opt/homebrew/bin/brew shellenv)"; fi
  if [ -x /usr/local/bin/brew ]; then eval "$(/usr/local/bin/brew shellenv)"; fi
fi

PREFIX="$(brew --prefix)"
PROXY_CONFIG="$PREFIX/etc/cliproxyapi.conf"
CLAUDE_SCRIPTS="$HOME/.claude/scripts"
CCX_DIR="$HOME/.claude-ccx"
AUTH_DIR="$HOME/.cli-proxy-api"
LOCAL_KEY="$AUTH_DIR/local-key"
CCX_COMMAND="$PREFIX/bin/ccx"

if ! brew list --versions cliproxyapi >/dev/null 2>&1; then
  if [ "$DRY_RUN" = 1 ]; then printf 'Would install cliproxyapi.\n'; else brew install cliproxyapi; fi
elif brew outdated cliproxyapi 2>/dev/null | grep -q '^cliproxyapi'; then
  if [ "$DRY_RUN" = 1 ]; then printf 'Would upgrade cliproxyapi.\n'; else brew upgrade cliproxyapi; fi
fi

if ! command -v claude >/dev/null 2>&1; then
  printf 'Claude Code is missing. Official native installer:\n  curl -fsSL https://claude.ai/install.sh | bash\n'
  if [ "$DRY_RUN" = 0 ]; then
    confirm_install 'Install Claude Code now?' || exit 1
    curl -fsSL https://claude.ai/install.sh | bash
  fi
fi

ensure_backup_dir() {
  [ -n "$BACKUP_DIR" ] && return
  BACKUP_DIR="$CCX_DIR/backups/$(date +%Y%m%d-%H%M%S)-$$"
  mkdir -p "$BACKUP_DIR"
}

backup_file() {
  local source="$1" relative="$2"
  [ -e "$source" ] || [ -L "$source" ] || return 0
  ensure_backup_dir
  mkdir -p "$BACKUP_DIR/$(dirname "$relative")"
  cp -pPR "$source" "$BACKUP_DIR/$relative"
}

install_file() {
  local source="$1" destination="$2" relative="$3" mode="$4"
  if [ -f "$destination" ] && cmp -s "$source" "$destination"; then return; fi
  if [ "$DRY_RUN" = 1 ]; then printf 'Would update %s\n' "$destination"; return; fi
  backup_file "$destination" "$relative"
  mkdir -p "$(dirname "$destination")"
  install -m "$mode" "$source" "$destination"
}

install_link() {
  if [ -L "$CCX_COMMAND" ] && [ "$(readlink "$CCX_COMMAND")" = "$CLAUDE_SCRIPTS/ccx" ]; then return; fi
  [ ! -d "$CCX_COMMAND" ] || { printf 'Cannot replace directory %s.\n' "$CCX_COMMAND" >&2; exit 1; }
  if [ "$DRY_RUN" = 1 ]; then printf 'Would link %s globally.\n' "$CCX_COMMAND"; return; fi
  backup_file "$CCX_COMMAND" "prefix/bin/ccx"
  mkdir -p "$(dirname "$CCX_COMMAND")"
  rm -f "$CCX_COMMAND"
  ln -s "$CLAUDE_SCRIPTS/ccx" "$CCX_COMMAND"
}

RUNTIME=(ccx ccx-models.py ccx-rewrite.js sanitize-schema.js ccx-rewrite-selftest.js ccx-rewrite-plan-selftest.js ccx-models-selftest.py install-config.py install-config-selftest.py config.template.yaml)
for name in "${RUNTIME[@]}"; do
  [ -f "$ROOT/$name" ] || { printf 'Missing installer source: %s\n' "$name" >&2; exit 1; }
done

TMP="$(mktemp -d)"
cleanup() { local status=$?; rm -rf "$TMP"; return "$status"; }
trap cleanup EXIT
if [ -f "$PROXY_CONFIG" ]; then cp "$PROXY_CONFIG" "$TMP/proxy.conf"; else : > "$TMP/proxy.conf"; fi
if [ -f "$LOCAL_KEY" ]; then
  cp "$LOCAL_KEY" "$TMP/local-key"
else
  python3 -c 'import secrets; print(secrets.token_urlsafe(32))' > "$TMP/local-key"
fi
python3 "$ROOT/install-config.py" --config "$TMP/proxy.conf" --template "$ROOT/config.template.yaml" --local-key "$(cat "$TMP/local-key")" >/dev/null

for name in "${RUNTIME[@]}"; do
  case "$name" in ccx|*.py|*-selftest.js|install.sh) mode=755 ;; *) mode=644 ;; esac
  install_file "$ROOT/$name" "$CLAUDE_SCRIPTS/$name" "home/.claude/scripts/$name" "$mode"
done
install_link

if [ -f "$ROOT/../auto-update/claude-addons-update.sh" ]; then
  install_file "$ROOT/../auto-update/claude-addons-update.sh" "$CLAUDE_SCRIPTS/claude-addons-update.sh" "home/.claude/scripts/claude-addons-update.sh" 755
  mkdir -p "$HOME/.claude"
  echo "$ROOT/.." > "$HOME/.claude/addons-repo-path"
  [ -d "$CCX_DIR" ] && echo "$ROOT/.." > "$CCX_DIR/addons-repo-path"
fi
if [ ! -f "$LOCAL_KEY" ]; then
  if [ "$DRY_RUN" = 1 ]; then
    printf 'Would create %s\n' "$LOCAL_KEY"
  else
    mkdir -p "$AUTH_DIR"
    install -m 600 "$TMP/local-key" "$LOCAL_KEY"
  fi
fi
install_file "$TMP/proxy.conf" "$PROXY_CONFIG" "prefix/etc/cliproxyapi.conf" 600

if [ "$DRY_RUN" = 1 ]; then printf 'Dry run complete; nothing changed.\n'; exit 0; fi
if [ "${CCX_INSTALL_TEST:-0}" = 1 ]; then printf 'Test installation complete.\n'; exit 0; fi

brew services restart cliproxyapi
"$CLAUDE_SCRIPTS/ccx" --restart

has_auth() {
  local pattern="$1" file
  for file in "$AUTH_DIR"/$pattern*.json; do [ -e "$file" ] && return 0; done
  return 1
}

if [ "$SKIP_LOGIN" = 0 ]; then
  for entry in claude:claude codex:codex antigravity:antigravity xai:xai; do
    provider="${entry%%:*}"; pattern="${entry##*:}"
    if ! has_auth "$pattern" && confirm_user "Sign in to $provider now?"; then
      "$CLAUDE_SCRIPTS/ccx" --login "$provider"
    fi
  done
fi

if find "$AUTH_DIR" -maxdepth 1 -name '*.json' -print -quit | grep -q .; then
  "$CLAUDE_SCRIPTS/ccx" --refresh
  "$CLAUDE_SCRIPTS/ccx" --agents
else
  printf 'No provider login yet. Run: ccx --login\n'
fi

node "$CLAUDE_SCRIPTS/ccx-rewrite-selftest.js"
node "$CLAUDE_SCRIPTS/ccx-rewrite-plan-selftest.js"
python3 "$CLAUDE_SCRIPTS/ccx-models-selftest.py"
python3 "$CLAUDE_SCRIPTS/install-config-selftest.py"
"$CLAUDE_SCRIPTS/ccx" --status
[ -n "$BACKUP_DIR" ] && printf 'Backup saved at %s\n' "$BACKUP_DIR"
printf 'ccx is global and ready. Open a new terminal and run: ccx\n'
