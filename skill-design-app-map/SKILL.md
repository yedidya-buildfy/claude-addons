---
name: design-app-map
description: Use when the owner wants to design a WHOLE app (many screens and flows) in the browser before building it — a tree/map of every screen, each screen clickable inside a phone frame, options per screen, and a running list of decisions that becomes the build plan. Trigger on /design-app-map, "design the whole app", "app map", "map of screens", "tree of screens", "עיצוב כל האפליקציה", "מפת אפליקציה", "עץ מסכים". Not for one screen (use design-in-browser).
---

# Design an app map (whole-app design in the browser)

**REQUIRED BACKGROUND:** design-in-browser. This skill uses it, it does not replace it: same rules (read the real
design system first, real data, 2–3 genuinely different variants, never touch app code before approval, port only
after approval). The difference: instead of one mockup page with tabs, you build ONE map of the whole app.

## What the owner gets
- A **tree** of every screen (top-down; `link:'next'` sequences drawn to the right), pan/zoom, jump buttons per tab.
- Click a screen → it runs inside an **iPhone frame**: taps navigate (`data-go`), steppers/switches/keypad respond.
- **Options** A/B/C per screen (switch in the tree or side panel; "Compare options" shows them side by side; "Copy picks").
- **Decisions** view: whole-app decisions (`S.global`) + every closed screen's `decided:` text = the plan for building.

## Setup
1. Copy `~/.claude/skills/design-app-map/template/` to `<project>/design/` (`app-map.html` = engine, `screens.js` = example).
2. Theme: replace the tokens in `.scr{...}` (colors, `--head`/`--ui`/`--body` fonts) and the Google Fonts link with the
   project's real design system.
3. Replace `screens.js` with the real app (one file per area is fine — add each as `<script src>` before the engine).
   Exactly one screen has no `parent`: the root (app launch). Every `S.tabs` id must be a screen id.
4. Open it for the owner: `open design/app-map.html` (the only visible window; your own checks stay headless).

## Screen API (`S.add`)
| Field | Meaning |
|---|---|
| `id`, `title`, `tab` | stable id; tree label; tab key (color from `S.tabColors`, bar from `S.tabs`) |
| `parent`, `link:'next'`, `rank`, `via` | tree placement; sequence to the right; sibling order; edge label |
| `html:()=>H.scr(inner,{tab})` or `variants:[{label,note,html}]` | one design, or 2–3 options |
| `note` / `decided` | one-line side-panel note / closed decision (shown green, listed in Decisions) |
| `H.scr(inner,{tab,cls,style,light})` | phone screen; app-wide toggles (e.g. dark mode) = `cls` from `PS` + `.scr.<cls>` token overrides |

Generic interactions (data attributes, no per-screen JS): `data-go="id|back"`, `data-sel`+`data-group`,
`data-check`, `.sw` (+`data-pin`/`data-mod` → shared `PS` state, redraws `S.refresh`), `data-stp`/`data-step`/`data-v`
steppers, `data-cell` + iOS keypad, accordion `data-accbox`/`data-acc`/`.accbody`/`.accsum`, popovers `data-pop`/`data-popid`/`data-opt`,
wheels `data-wheel`, `data-quick` toast, `data-drag` sortable rows. Deep link: `app-map.html#open=<id>&v=<n>`.

## The loop
1. Agree the screen tree in chat first (short map), then build it.
2. After EVERY change run `bash ~/.claude/skills/design-app-map/scripts/check.sh <project>/design` → must print
   `OK <screens>` (tree nodes; variants are rendered too but not counted) — anything else names the broken screen.
3. Verify visually headless (never steal focus), then read the image (phone = right 460 px), fix, repeat:
   `"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --disable-gpu --hide-scrollbars --virtual-time-budget=5000 --window-size=800,940 --screenshot=<png> "file://<abs>/design/app-map.html#open=<id>&v=<n>"`
4. Owner picks → close it: keep only the chosen html, **delete the other variants**, write `decided:'…'`.
   App-wide rules go to `S.global`. Picks made in the browser live in its localStorage — ask for "Copy picks".
5. Big areas → parallel agents, **one screens file each** (ownership stated in the brief); shared engine edits only as
   small generic blocks, re-read the file right before editing.
6. Approved map + Decisions = the spec. Port per design-in-browser step 5.

## Common mistakes
| Symptom | Fix |
|---|---|
| Map blank after cutting variants | You deleted a helper/const sitting between nodes. check.sh names it. |
| Tap does nothing | Attribute clash: e.g. a row with `data-key` is eaten by the keypad handler — use unique names. |
| Accordion opens then closes | Two handlers bound to the same attribute (one in a screens file). Keep one shared handler. |
| `Script error` only | file:// hides it — check.sh inlines scripts to show the real error. |
| Numbers disagree across screens | Same demo data everywhere; fix on sight. |
