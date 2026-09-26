# usage-by-device — who on a shared Claude plan used how much — design

Date: 2026-09-26 · Status: draft, awaiting owner review

## Why

Two or three people (or one person on two Macs) log into the same Claude
subscription. The plan's usage meter (`/usage`, and our status line) shows one
number for the whole account; nobody can tell whose machine burned it. The
owner wants every machine to register itself by name and a table that shows,
per machine, how much of the plan it used today, over 7 days, 30 days and this
month.

Prior art: **CodeBurn** (getagentseal/codeburn) — reads the local session
JSONL logs Claude Code already writes, dedupes, prices by model, shows
Today / 7 days / 30 days / This month. Local only; no cross-machine view.
We borrow its reading + pricing approach and add the sharing part.

## Goal

A new add-on, `usage-by-device`. Once it is on:

- the machine registers itself (stable device id + its Mac name, e.g.
  "Yedidya's MacBook Pro"); the name can be changed from the `addons` page;
- every machine keeps a full local copy of every machine's daily usage on the
  same subscription;
- machines exchange that copy whenever they are online — no server of ours,
  no accounts, no setup;
- the `addons` page shows a per-device table, live while open.

Non-goals (v1): a status-line segment, a terminal command, per-project
breakdown, other AI tools (Codex, Gemini…), history older than 31 days,
Windows.

## Owner decisions (from the brainstorm)

1. Several people may share one plan — not only one person's Macs.
2. No server. Each machine stores everything; sync happens when online.
3. Default name = the Mac's name; renamable; the view is by names.
4. Show "updated N minutes ago" per device so staleness is visible.

## How it works

### 1. Reading local usage

Source: `~/.claude/projects/**/*.jsonl` (includes subagent sidechains). Take
assistant lines with `message.usage`; dedupe by `message.id` + `requestId`
(the same reply is written more than once, and `~/.claude-ccx/projects` is a
symlink to the same folder — resolve real paths so it is read once).

Per line: input, output, cache-write and cache-read tokens, model. Weight =
tokens × that model's list price for each token kind (a table in the add-on,
by model family: opus / sonnet / haiku / fable; unknown model → sonnet
prices). The weight is "equivalent dollars" — the best local proxy for how
much of the plan's limit a reply consumed, since Opus drains it faster than
Sonnet.

Bucket by **local calendar day** (for day/month views) and keep a rolling
list of hourly buckets for the last 7 days (needed to split the 5-hour and
weekly windows accurately). Reading is incremental: remember each file's size
+ offset, only parse new bytes.

### 2. The ledger (what each machine stores)

`~/.claude/usage-by-device/ledger.json`:

```json
{
  "devices": {
    "<deviceId>": {
      "name": "Yedidya's MacBook Pro",
      "nameSetAt": "2026-09-26T10:00:00Z",
      "updatedAt": "2026-09-26T13:40:00Z",
      "days":  { "2026-09-26": { "w": 41.2, "o": 38.0, "s": 3.2, "h": 0 } },
      "hours": { "2026-09-26T13": 4.1 }
    }
  }
}
```

`w` = total weight (equivalent $); `o/s/h` = split by family for the tooltip.
Days older than 31, hours older than 7 days are dropped.

- **deviceId**: SHA-256 of the hardware UUID (`ioreg IOPlatformUUID`; Linux:
  `/etc/machine-id`), first 16 hex chars. Never the raw UUID.
- **name**: `scutil --get ComputerName` on first run; Linux: hostname.
- Only this machine writes its own `days/hours`. Anyone may rename any device
  (small trusted group); newest `nameSetAt` wins.

### 3. Sync — a mailbox on the owner's Akamai box

Machines in different homes can't reach each other directly (NAT), and are
rarely on at the same moment — often not for a whole weekend. So they meet in
a mailbox: **ntfy** (plain HTTPS publish/subscribe). The free public ntfy.sh
keeps messages only 12 h, fixed, which loses a weekend. So we run the same
ready-made ntfy image on the owner's Akamai/Coolify server — no code of ours
on the server, only config:

- `cache-duration: 168h` (7 days) — the hard ceiling for the setting below;
- attachments off, message body limit 4 KB, ntfy's per-visitor rate limits
  on; container memory limit 64 MB, CPU niced (it shares a box with prod);
- HTTPS on a subdomain through Coolify.
- No login: the add-on repo is public, so any shared write token would be
  public too. Protection is instead: unguessable topic + encrypted payloads +
  the limits above (an abuser gets at most a small, rate-limited relay).

The server address is a default in the add-on, overridable per machine.

**Retention setting (on the page).** "Keep updates for N hours", default 72,
range 12–168. It is a plan-wide setting carried in the ledger like a device
name (newest change wins, travels to all machines). The server keeps
everything for 7 days; the setting controls how far back a returning machine
looks (`since=<N>h`) and how often machines refresh their entries so they
stay inside that window (see Gossip). Lower = less chatter; higher = a
machine closed for longer still catches up.

- **Channel (topic)**: derived from the subscription — HMAC of
  `accountUuid + organizationUuid` (from `~/.claude.json` → `oauthAccount`)
  with a fixed label. Every machine logged into the same plan lands on the
  same topic automatically; nobody else can compute it.
- **Encryption**: AES-256-GCM, key derived the same way with a different
  label. The mailbox only ever sees ciphertext. Payload = gzip(one device's
  entry) → encrypt → base64. Must stay under the 4 KB message body. One
  device = 31 days + at most 168 hour buckets, stored sparse (only hours with
  usage) — about 1–2 KB after gzip + base64. The self-test asserts the worst
  case (every hour of the week busy) fits; if it doesn't, hours are dropped
  first and the 5-hour/weekly split falls back to day buckets.
- **Gossip**: each machine publishes **every device it knows**, one message
  per device, only when that entry changed since it last published it — or
  when its last publish is older than half the retention setting, so every
  device's latest entry is always inside the window. On receive: merge per
  device, newest `updatedAt` wins for usage, newest `nameSetAt` wins for the
  name. So any machine that is on keeps everyone's latest data alive.

When it runs (no always-on daemon):

- **Claude Code hooks** (`SessionStart` + `Stop`, added through the add-on's
  `claudeSettings` snippet): spawn the sync detached, throttled to once per
  60 s. Claude needs internet to work, so a machine that is using the plan is
  online and reports within a minute. A machine that is off uses nothing, so
  its last report stays correct.
- **The `addons` page open**: pulls once, then holds a live subscription
  (ntfy's streaming endpoint) so other machines' updates appear within
  seconds.
- Each sync = read new local usage → merge → pull (`since=<last id>`, or
  `since=<N>h` when the last id is older than the window) → merge → publish
  changed or ageing device entries → save.

Known gap (accepted): a machine that stays closed longer than the retention
setting, while the machine holding the newer data is also closed, sees that
data only once a machine holding it is on again. The "updated N ago" label
makes this visible.

### 4. What the page shows

A new section in the `addons` page, designed properly (owner asked for it to look good): a browser mockup with 2–3 variants is shown and picked before the real page is built. Content, one row per device:

| Device | Today | 7 days | 30 days | This month | 5-hour | Week | Updated |
|---|---|---|---|---|---|---|---|

- Today…This month: that device's share of all devices' weight in the period,
  as a percent, with the equivalent-$ on hover.
- 5-hour / Week: the plan's official utilisation (already cached by the
  status line in `cache/claude-usage.json`; the add-on calls the same fetch if
  the cache is stale) × the device's share of weight inside that window. E.g.
  week at 44 %, this Mac did 2/3 of the week's weight → 29 %.
- Name cell is editable (click → type → Enter). This machine is marked "this
  Mac".
- Updated: "now / 5 min ago / 2 days ago".

## Pieces

| Piece | Job |
|---|---|
| `usage-by-device/addon.json` | manifest: files, hooks snippet, page section |
| `usage-by-device/ubd.mjs` | one Node script, subcommands `sync`, `rename <id> <name>`, `json` (for the page) |
| engine page + server | a section that renders `ubd.mjs json`, rename + retention calls, and the live subscription |
| Coolify app on Akamai | stock `binwiederhier/ntfy` image + a `server.yml` kept in `usage-by-device/server/` |

Node stdlib only (`crypto`, `zlib`, `fetch`). No npm dependencies.

## Errors

Every failure (no network, mailbox down, bad message, no Claude login) → exit
0, keep the previous ledger, log one line to `cache/usage-by-device.log`. A
message that fails to decrypt is ignored (not ours / corrupted). The ledger is
written via temp file + rename so a crash never leaves it half-written.

## Testing

A self-test under a fake `HOME` (never the real one): two simulated machines
with fake JSONL logs and a local in-process stand-in for the mailbox. Checks:
dedupe, weighting, day/hour bucketing across midnight, merge rules (usage and
name), gossip carrying a third device, payload size with 3 devices × 31 days,
decrypt failure ignored, window share maths.

Server: publish a test message, restart the container, confirm it is still returned with `since=72h`.

Manual: turn the add-on on on two Macs logged into the same plan, use Claude on
one, open `addons` on the other — its row updates within a minute.
