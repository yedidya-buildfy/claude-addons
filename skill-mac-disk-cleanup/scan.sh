#!/bin/bash
# Read-only disk inventory for mac-disk-cleanup. Prints GB<TAB>path, biggest first.
# Run with bash (not zsh): zsh aborts a whole command when one glob has no match.
# Usage: bash scan.sh [min_gb]   (default 0.15)
shopt -s nullglob dotglob
MIN=${1:-0.15}
H="$HOME"
row() { du -xsk "$@" 2>/dev/null | awk -F'\t' -v m="$MIN" '$1/1048576>=m{printf "%.2f\t%s\n",$1/1048576,$2}' | sed "s#$H/#~/#" | sort -rn; }

echo "## free space"
# df "used" is the sealed system volume only; take used/total from the container lines below
df -k / | tail -1 | awk '{printf "free %.1f GB\n",$4*1024/1e9}'
diskutil apfs list | grep -E "Name:|Capacity Consumed" | paste - - | sed 's/  */ /g'

echo "## top level (data volume)"; row /System/Volumes/Data/*
echo "## home";                    row "$H"/*
echo "## ~/Library";               row "$H"/Library/*
echo "## app data";                row "$H"/Library/{Application\ Support,Group\ Containers,Containers,Caches,Developer}/*
echo "## applications";            row /Applications/* "$H"/Applications/*
echo "## desktop / documents";     row "$H"/Desktop/* "$H"/Documents/* "$H"/Downloads/*
echo "## system assets (AI models, simulator)"; row /System/Library/AssetsV2/*
echo "## temp (Claude scratch + system)"; row /private/tmp/* /private/tmp/claude-*/*/* /private/var/folders/*/*/[TC]
echo "## rebuildable folders under ~/Desktop and ~ (node_modules, .next, venvs, Pods, build)"
find "$H"/Desktop "$H" -maxdepth 5 -xdev -type d \( -name node_modules -o -name .next -o -name .venv -o -name venv -o -name Pods -o -name .expo -o -name .turbo \) -prune -print0 2>/dev/null \
  | xargs -0 du -sk 2>/dev/null | awk -v m="$MIN" '$1/1048576>=m{printf "%.2f\t%s\n",$1/1048576,$2}' | sed "s#$H/#~/#" | sort -rn | head -40
# Chrome code_sign_clone folders are APFS clones: du counts them, the disk does not. Never report them as space.
