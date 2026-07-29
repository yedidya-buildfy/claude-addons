#!/bin/bash
# One check for the tab-dot transcript reader: extract the python block out of
# tab-watcher.sh and assert it reports "<bg> <plan>" off the LAST permission-mode
# record. Run it after touching that block. Exits non-zero on failure.
set -u
w="$HOME/.claude/scripts/tab-watcher.sh"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

python3 - "$w" "$tmp/probe.py" <<'PY'
import sys
src = open(sys.argv[1]).read()
body = src.split("<<'PY' 2>/dev/null\n", 1)[1].split("\nPY\n", 1)[0]
open(sys.argv[2], "w").write(body)
PY

t="$tmp/t.jsonl"
run() { python3 "$tmp/probe.py" "$t" /dev/null /dev/null; }
expect() {
  got=$(run)
  [ "$got" = "$1" ] || { echo "FAIL: expected '$1', got '$got'"; exit 1; }
}

echo '{"type":"system","subtype":"turn_duration","pendingBackgroundAgentCount":2}' > "$t"
expect "2 0"

echo '{"type":"permission-mode","permissionMode":"plan"}' >> "$t"
expect "2 1"

echo '{"type":"permission-mode","permissionMode":"default"}' >> "$t"
expect "2 0"

: > "$t"
expect "0 0"

echo "tab-dots selftest OK"
