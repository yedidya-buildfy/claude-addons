#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
HOME_DIR="$TMP/home"
PREFIX="$TMP/prefix"
BIN="$TMP/bin"
mkdir -p "$HOME_DIR" "$PREFIX/etc" "$BIN"

cat > "$BIN/brew" <<'SH'
#!/bin/bash
case "$*" in
  --prefix) printf '%s\n' "$FAKE_BREW_PREFIX" ;;
  "list --versions cliproxyapi") printf 'cliproxyapi 7.2.150\n' ;;
  *) exit 0 ;;
esac
SH
cat > "$BIN/claude" <<'SH'
#!/bin/bash
printf '2.1.263 (Claude Code)\n'
SH
chmod +x "$BIN/brew" "$BIN/claude"

cat > "$PREFIX/etc/cliproxyapi.conf" <<'YAML'
logging-to-file: false
custom-provider:
  endpoint: "https://example.invalid"
request-retry: 5
YAML

run_installer() {
  HOME="$HOME_DIR" PATH="$BIN:/usr/bin:/bin:/usr/sbin:/sbin" \
  FAKE_BREW_PREFIX="$PREFIX" CCX_INSTALL_TEST=1 \
  bash "$ROOT/install.sh" --yes --skip-login "$@"
}

run_installer
[ -x "$HOME_DIR/.claude/scripts/ccx" ]
[ -L "$PREFIX/bin/ccx" ]
[ "$(readlink "$PREFIX/bin/ccx")" = "$HOME_DIR/.claude/scripts/ccx" ]
[ "$(stat -f '%Lp' "$HOME_DIR/.cli-proxy-api/local-key")" = "600" ]
[ "$(stat -f '%Lp' "$PREFIX/etc/cliproxyapi.conf")" = "600" ]
grep -q 'custom-provider:' "$PREFIX/etc/cliproxyapi.conf"
grep -q 'request-retry: 0' "$PREFIX/etc/cliproxyapi.conf"
find "$HOME_DIR/.claude-ccx/backups" -type f | grep -q .

checksum() {
  shasum "$HOME_DIR/.claude/scripts/ccx" \
    "$PREFIX/etc/cliproxyapi.conf" \
    "$HOME_DIR/.cli-proxy-api/local-key"
}
BEFORE="$(checksum)"
run_installer
AFTER="$(checksum)"
[ "$BEFORE" = "$AFTER" ]

BEFORE_MTIME="$(stat -f '%m' "$PREFIX/etc/cliproxyapi.conf")"
run_installer --dry-run
AFTER_MTIME="$(stat -f '%m' "$PREFIX/etc/cliproxyapi.conf")"
[ "$BEFORE_MTIME" = "$AFTER_MTIME" ]

printf 'PASS: global ccx installer is private, idempotent, and dry-run writes nothing\n'
