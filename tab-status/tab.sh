#!/bin/bash
# Keep the installed hook entrypoint stable; Python owns locking and state.
exec python3 "$(dirname "$0")/tab-state.py" hook "$@"
