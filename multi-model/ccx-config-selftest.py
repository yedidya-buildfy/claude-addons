#!/usr/bin/env python3
import re
from pathlib import Path

home = Path.home()
config = Path('/opt/homebrew/etc/cliproxyapi.conf').read_text()
launcher = (home / '.claude/scripts/ccx').read_text()

retry = re.search(r'^request-retry:\s*(\d+)\s*$', config, re.MULTILINE)
assert retry, 'request-retry is missing from proxy config'
assert retry.group(1) == '0', 'proxy must pass retryable errors to Claude Code instead of retrying them itself'

catalogue = re.search(r'^CATALOGUE="([^"]+)"', launcher, re.MULTILINE)
auth_dir = re.search(r'^AUTH_DIR="([^"]+)"', launcher, re.MULTILINE)
assert catalogue and auth_dir, 'CCX catalogue/auth paths are missing'
assert catalogue.group(1) != auth_dir.group(1) + '/ccx-catalogue.json', 'model catalogue must stay outside auth directory'
assert not (home / '.cli-proxy-api/ccx-catalogue.json').exists(), 'stale catalogue remains in auth directory'
assert 'rm -f "$CATALOGUE"' not in launcher, 'refresh must preserve remembered providers during proxy startup'

print('PASS: proxy errors return promptly and model catalogue survives refresh')
