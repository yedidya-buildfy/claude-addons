# One engine for every add-on — design

Date: 2026-09-18 · Status: awaiting review

## Why

The repo is installed on several Macs and updates itself on each one. Today every
add-on is described three or four times — in `install.sh`, in `uninstall.sh`
(which covers only some of them), in `is_installed`, and in the updater — and
each copy drifts:

- Every `settings.json` merge is written twice, once for `~/.claude` and once for
  `~/.claude-ccx`, and not every add-on remembers the second one.
- `~/.zshrc` is built by appending snippets. Correctness depends on append order
  (auto-claude must come after the `claude` alias; multi-model `sed`-deletes
  sticky-prompt's alias). `uninstall.sh` never touches `~/.zshrc` at all.
- `install.sh --update` only refreshes add-ons it can detect as already
  installed, so a new add-on never reaches anyone and a removed one is never
  cleaned up.
- There is no way to switch one add-on off.

## Goal

One manifest per add-on, one engine that makes the machine match the user's
choices, one choices file per machine, and a local browser page on top.
Everything — first install, background update, the page, full removal — is the
same engine call.

Non-goals (for now): Linux/Windows, syncing choices between machines, an
"update now" button or update status on the page, uninstalling the `ccx` binary
and its services (off removes only what the engine wired in; see multi-model).

## Pieces

### 1. Manifest — `<addon>/addon.json`

One file per add-on, the only place that add-on is described. Fields:

```jsonc
{
  "id": "phone-alerts",
  "title": "התראות לטלפון",
  "summary": "…one Hebrew sentence for the page…",
  "default": false,            // state on a machine that has never chosen
  "required": false,           // true = always on, no switch (hebrew-guard)
  "order": 90,                 // position in the shell block and on the page
  "requires": [],              // e.g. skill-tab-name → ["tab-status"]
  "files": [                   // repo path → home path, mode
    {"from": "ntfy.sh", "to": "~/.claude/scripts/ntfy.sh", "mode": "755"}
  ],
  "claudeSettings": "settings.json.snippet",  // merged into EVERY Claude profile
  "vscodeSettings": "vscode-settings.snippet",
  "vscodeKeybindings": "vscode-keybindings.snippet",
  "shell": "zshrc.snippet",    // may contain {{settingName}} placeholders
  "claudeMd": "CLAUDE.md.snippet",
  "settings": [                // rendered as fields on the page
    {"key": "topic", "label": "נושא פרטי", "type": "secret", "generate": "ntfy-topic"}
  ],
  "external": {                // multi-model only: delegate to its own installer
    "install": "install.sh --yes"
  }
}
```

Existing snippet files stay where they are; manifests point at them. Adding an
add-on = adding one folder with one manifest. Nothing else in the repo changes.

### 2. Engine — `engine/addons.mjs` (Node, no dependencies)

Node is already a hard requirement (every JSON merge today shells out to it).
Commands, exposed as the global `addons`:

| Command | Does |
|---|---|
| `addons` | start the page (section 5) and open it |
| `addons apply` | make the machine match the choices; print what changed |
| `addons apply --dry-run` | print the plan, write nothing |
| `addons status` | per add-on: chosen, actually installed, drifted |
| `addons on <id>` / `off <id>` | change one choice, then apply |
| `addons set <id> <key> <value>` | change one setting, then apply |
| `addons remove-all` | apply with everything off (replaces `uninstall.sh`) |

**Targets the engine writes.** Each has one small adapter with `add` and
`remove`, and never touches content it did not write:

- **Files** — copied only when content differs (the VS Code extension offers a
  reload on every change of its own file).
- **Claude settings** — applied to every profile that exists: `~/.claude` and,
  when present, `~/.claude-ccx`. One code path, so the ccx profile can no
  longer be forgotten. Arrays: add/remove entries by structural equality (the
  current merge rule). Scalars (`statusLine`, `env.X`): the previous value is
  recorded and restored on removal, but only if the current value is still ours.
- **VS Code settings / keybindings** — same rules; `//` comments tolerated.
- **Shell** — ONE managed block in `~/.zshrc` between
  `# >>> claude-addons (managed — edit with \`addons\`) >>>` and
  `# <<< claude-addons <<<`, regenerated in full on every apply from the
  enabled add-ons sorted by `order`. Order is now a declared fact
  (sticky-prompt before multi-model before auto-claude, which is last).
  Everything outside the markers is never touched. The block is appended at the
  end of the file on first creation, so it runs after the user's own lines.
- **CLAUDE.md** — same managed-block technique, keyed per add-on.

**Ownership record — `~/.claude/addons/state.json`.** After each apply, per
add-on: files written with their content hash, settings entries added, prior
scalar values, the repo commit applied. Removal reads this record, not the
current manifest, so removing an add-on whose manifest has since changed or
been deleted from the repo is still exact. A file whose hash no longer matches
(the user edited it) is left in place and reported, not deleted.

**Safety.**
- Lock file around apply, so the background updater and the page cannot run at
  once; a second caller waits up to 30 s then gives up with a message.
- Before writing, every target file that will change is copied to
  `~/.claude/addons/backups/<timestamp>/`; the last 10 are kept.
- Each file is written to a temp file and renamed (atomic per file). If any step
  fails, every file already written in this apply is restored from that
  backup, and the state record is not advanced. Apply is all-or-nothing.
- A settings file that is not valid JSON is never overwritten: that target
  fails, the apply rolls back, and the message names the file.
- `requires` is checked before writing: switching on skill-tab-name without
  tab-status is refused with a message, not silently half-installed.

### 3. Choices — `~/.claude/addons/config.json`

```json
{"version": 1,
 "enabled": {"tab-status": true, "auto-claude": true, "phone-alerts": false},
 "settings": {"phone-alerts": {"topic": "…"}, "auto-claude": {"skipPermissions": true}}}
```

Per machine, never in the repo (it holds the private ntfy topic), mode 600. An
add-on missing from `enabled` uses its manifest `default` — this is how a new
add-on reaches existing machines: on by default only if its manifest says so.

### 4. Entry points after the change

- `install.sh` (fresh Mac) — checks Node, puts `addons` on PATH, writes the repo
  path, then: interactive → opens the page; `--yes` → applies manifest defaults.
  ~40 lines instead of ~500.
- Updater — `git pull --ff-only` then `addons apply`. Same throttling, same
  "skip when the repo has local edits" rule, same ccx-proxy restart.
- `uninstall.sh` — `addons remove-all`.
- `multi-model/install.sh` — unchanged and still runnable on its own (CLAUDE.md
  promises that). Its manifest has `external.install`; the engine runs it when
  multi-model is switched on or its files changed since the last apply. Off
  removes only the shell lines and settings the engine wired in; the `ccx`
  program, its services and logins stay (non-goal above).

### 5. The page

- `addons` starts a Node `http` server bound to `127.0.0.1` on a random free
  port, with a random token in the URL; every request without the token is
  refused (another site in the browser must not be able to switch add-ons).
  Opens the URL with `open`. Stops after 30 minutes idle or on Ctrl-C.
- One static HTML file, Hebrew, right-to-left, no build, no external requests.
  A card per add-on: title, summary, switch, its settings. Required add-ons are
  shown without a switch.
- Save shows the dry-run plan in words ("יוסר: 3 הוקים, שורות בטרמינל"), then
  applies and shows the result per add-on. Errors are shown with the file
  named.
- Phone alerts: topic field + "שלח התראת בדיקה" (runs the existing test send).
- auto-claude: "בלי בקשות אישור" on/off, rendered into its shell lines.

### 6. Moving machines already installed

First `addons apply` on a machine with no choices file:

1. Detect what is installed using today's `is_installed` rules → write
   `config.json` to match. Nothing switches on or off by itself.
2. Build `state.json` from what is on disk: an installed file whose content
   matches the repo is recorded as ours; hook entries equal to a manifest's
   entries are recorded as ours.
3. `~/.zshrc`: remove each legacy snippet by exact text match against every
   version of it in git history, then write the managed block. A legacy block
   that does not match exactly (the user edited it) is left alone and reported.
   The two `alias claude=` lines in today's file collapse to the one the
   declared order produces.
4. Everything touched is backed up first, as in any apply.

## Tests

`node --test` in a sandbox `HOME` (temp dir), never the real one:

- off → on → off returns every file byte-identical to the start
- apply twice: the second apply writes nothing
- lines/hooks the user or other tools added survive on and off
- legacy migration on a fixture copied from a real current `~/.zshrc` and
  `settings.json`: nothing changes behaviour, legacy snippets become one block
- failure injected mid-apply → every file back to its previous content
- invalid JSON in a settings file → refused, nothing written
- the page server refuses a request without the token
- existing per-add-on self-tests keep running unchanged

## Rollout

1. Build and test on a branch; run it against a copy of this Mac's real files.
2. Run the migration on this Mac, check every add-on still behaves.
3. Push to master; the other machines migrate on their next background update.
   The updater logs the migration result to its existing log file.
