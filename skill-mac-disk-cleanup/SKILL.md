---
name: mac-disk-cleanup
description: Use when the user's Mac is low on disk space, asks what takes up the disk, wants to free space, clean caches, remove apps or old projects, or says "ניקוי מחשב", "אין מקום", "מה תופס לי את הדיסק", "תפנה מקום", or types /mac-disk-cleanup.
---

# Mac disk cleanup

## Overview
Measure everything, show it as an interactive pie + choose page, let the user mark every item keep / delete / more-detail, then execute in rounds and re-publish after each round. Nothing is deleted without the user's mark, and nothing irreplaceable is deleted without a backup first.

Talk to the user in their language, in product terms (what a folder *is*, not its path).

## The loop
1. **Measure** — `bash ~/.claude/skills/mac-disk-cleanup/scan.sh` (read-only). Drill into anything ≥1 GB until you can name what it is in plain words.
2. **Snapshot page** — copy `~/.claude/skills/mac-disk-cleanup/template/snapshot.html` to the scratchpad, replace the `const D=[...]` array (categories → `d` sub-rows), the placeholder numbers (TOTAL_GB, USED_GB, FREE …) and note; publish as an Artifact (or open locally if Artifacts are unavailable). Pie + clickable drill-down.
3. **Choose page** — copy `template/choose.html`, replace `const G=[...]` and TOTAL_GB / FREE_GB. Row = `[id, name, GB, what-it-is, what-happens-if-deleted, rec, path]`, rec ∈ `d` delete / `k` keep / `q` your call / `i` needs detail. Covers **all** used space (incl. macOS, apps, "not itemizable"), so no "everything else" slice. Bump `KEY` (`disk-choices-vN`) when rows change. User marks, presses "העתק בחירות", pastes back.
4. **Execute the pasted choices** (rules below), measure real freed space with `df` before/after, re-publish both pages (same file paths), report: what was deleted, what was skipped and why, what the user must run themselves.
5. Repeat until the user is done. "לפרט עוד" items → new detailed rows in the next round.

## Execution rules
| Situation | Do |
|---|---|
| Shell | Run deletions with `bash` or `setopt nullglob`: in zsh one unmatched glob aborts the whole `rm`. Word-split lists explicitly (`for x in ${=LIST}` in zsh). Verify each target is gone afterwards. |
| Project with no remote / unpushed commits / dirty tree | Commit snapshot, `gh repo create <user>/<name> --private --push`, verify `rev-parse` equals origin, then delete. Leave a README pointer if the user wants the folder kept. |
| `.env`, secrets, `set-env.sh` | Add to `.gitignore` before committing; copy to `~/.<name>-secrets/` (chmod 700); confirm not in `git ls-files`. |
| Big files (>50 MB) in a repo | `.gitignore` them; they stay local — tell the user. |
| Claude scratch dirs (`/private/tmp/claude-*`) | Find live sessions first (running `claude` processes, `ListAgents`); never delete a live session's folder. A runaway file in a live session → SendMessage that session. |
| Live app / dev server | Quit the app (`osascript quit`) first; skip build folders of a dev server that is running. |
| Root-owned (`/Applications/*` by root, `/opt`, `/System/...`) | Give the user one `sudo rm -rf ...` per line in its own code block (pasted multi-line commands break). |
| Photos library | Only after checking `Photos.sqlite` (`ZCLOUDLOCALSTATE`): 1 = in iCloud. Non-uploaded rows with `ZSAVEDASSETTYPE=4` are shared-album items (stored in iCloud). Anything else non-uploaded → stop and ask. |
| Mail local copy | Safe when no `V*/Mailboxes` (local "On My Mac") folder exists. |
| Things the user said to keep | Never re-offer as delete; keep them in the page marked keep. |

## Honesty checks
- Chrome `code_sign_clone` folders and other APFS clones show in `du` but free ~0 when deleted. Prove space with a `df` delta, never with `du` totals.
- Apple Intelligence / Siri assets under `AssetsV2` are often mounted read-only ("Resource busy") even with SIP off — report as locked, don't escalate.
- Unexplained gap between `df` and the sum of `du` = APFS metadata + protected files; show it as its own slice, don't invent contents.
- If an earlier claim turns out wrong, say so in the next report.

## Common mistakes
- Counting a deletion as done without checking the path is gone (zsh glob abort).
- Deleting another live session's files or an iOS simulator another session is using without telling it.
- Offering "uninstall X" for macOS built-ins (Books, Games, Freeform) — they are on the sealed system volume.
- Treating a toolchain's many Launchpad icons (e.g. vendor SDK configurators) as junk — check whether a project builds or flashes with them first.
