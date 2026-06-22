---
name: design-in-browser
description: Redesign a page or component by building a standalone interactive HTML mockup on the project's real design system, opening it in the browser, iterating on 2-3 variants in tabs, letting the user pick, and only then porting the chosen design to the framework (React/Vue/etc). Use when the user wants to explore or redesign the look of a UI before touching real code. Trigger on /design-in-browser, "design in browser", "let's design X somewhere else", "show me design options", "mockup the design", "explore the design", "עיצוב בדפדפן", "נצא לעצב את הדף", "תראה לי אופציות עיצוב".
when_to_use: Whenever the user wants to redesign/shape/explore the visual design of a page or component and see options in the browser before any real code change. Not for tiny tweaks to existing UI (just edit directly) or backend work. Also fires on the slash command /design-in-browser.
disable-model-invocation: false
---

# Design in browser

Design in a throwaway HTML mockup first, implement in the real framework second.
Do **not** touch real app code during the design phase. Works in any project.

## First: use a design plugin/skill if one is installed

Before anything, check for an installed design helper and use it for the quality
vocabulary, tokens, and review:
- **impeccable** (design skill/plugin) — if present, invoke it (`shape` to plan,
  `live` for in-browser iteration, `craft` for plan+build) and follow its
  `DESIGN.md`/`PRODUCT.md` system. Snap any off-scale radii to its token scale.
- Any other **UI/UX design skill or plugin** — prefer it over ad-hoc styling.

The HTML-mockup loop below is the delivery technique; layer a design plugin on top
of it whenever one exists. If none is installed, run the loop on its own.

## The loop

1. **Read the project's design system first** (never invent tokens). Read whatever
   exists: a `DESIGN.md` / `PRODUCT.md` / style guide; the CSS theme
   (`globals.css`, `theme.css`, `tailwind.config.*`, CSS custom properties / design
   tokens); the component being redesigned + 1-2 sibling components; and the
   project's reusable UI primitives (buttons, inputs, selects, badges). Match the
   real fonts, colors, radii, shadows, spacing, and reading direction (RTL/LTR).

2. **Build a standalone HTML mockup** at a sensible path (repo root is fine), named
   `<feature>-designs.html`:
   - Self-contained: inline `<style>` + a little vanilla `<script>`; design tokens
     lifted into `:root` CSS vars from the project's real theme.
   - Load the project's actual font (Google Fonts CDN or local).
   - Correct reading direction; for RTL, give numeric inputs `dir="ltr"` so typing
     reads correctly. Use `tabular-nums` for numbers.
   - **2-3 genuinely distinct variants in tabs** (differ in layout/hierarchy, not
     just palette); clicking a tab swaps the design.
   - Interactive (working toggles/dropdowns) and seeded with the user's **real data**
     so judging is honest. One-line note per variant explaining its idea.

3. **Open it in the browser** so the user can look:
   - macOS: `open <file>.html` · Linux: `xdg-open <file>.html` · Windows: `start <file>.html`
   - Re-run after each edit; the user refreshes. (If a dev server already serves the
     file, give them the URL instead.)

4. **Iterate** on the HTML per feedback (which tab, what to change, combine variants)
   until the user approves one. Iterate in HTML where it's cheap, not in real code.

5. **Port to the real framework only after approval.** Translate the chosen mockup
   into the project's components/styles, reusing existing primitives and tokens; keep
   the visual result identical to the approved mockup. For big work (new feature +
   logic), consider spinning a fresh subagent with a full brief that points it at the
   mockup as the source of truth.

6. **Clean up:** the `*-designs.html` mockups are throwaway scaffolding — offer to
   delete once shipped, or keep one as a living reference (user's call).

## Notes
- Keep direction-correct throughout (alignment, number-field direction, icon mirroring).
- Don't gate content visibility on JS-only reveals; the default state must render.
- A per-project copy of this skill can add project-specific paths/tokens and a
  gold-standard example mockup file to copy.
