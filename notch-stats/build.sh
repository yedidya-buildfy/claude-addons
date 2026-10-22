#!/bin/sh
# Rebuild the notch monitor after changing src/: compiles (needs Rust: https://rustup.rs) and refreshes
# dist/NotchStats, the Apple-Silicon binary the add-on installs. The build folder stays outside the repo.
set -e
cd "$(dirname "$0")"
export CARGO_TARGET_DIR="$HOME/Library/Caches/notch-stats-target"
~/.cargo/bin/cargo test --release
~/.cargo/bin/cargo build --release
cp "$CARGO_TARGET_DIR/release/notch-stats" dist/NotchStats
echo "dist/NotchStats updated; commit it, then: addons apply"
