#!/bin/bash
# One writer, change-only painting. Native title updates must be disabled.
exec python3 "$(dirname "$0")/tab-state.py" watch "$@"
