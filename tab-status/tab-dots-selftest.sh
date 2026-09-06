#!/bin/bash
# Runs against the adjacent source/installed copy, in private test terminals.
set -e
root="$(cd "$(dirname "$0")" && pwd)"
python3 -m unittest discover -s "$root" -p 'test_tab_*.py' -v
