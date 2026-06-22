# skill-design-in-browser

A Claude Code skill that designs UI **in the browser** before touching real code:
it reads the project's design system, builds a standalone interactive **HTML
mockup** with 2-3 variants in tabs, opens it in the browser to iterate, and only
ports the chosen design to the real framework after you approve.

Generalized — works in any project. If an **impeccable** plugin or any other
UI/UX design skill is installed, the skill uses it for the quality vocabulary and
tokens.

## Install
Run the repo `install.sh` and accept the `design-in-browser` step, or copy by hand:
```bash
mkdir -p ~/.claude/skills/design-in-browser
cp skill-design-in-browser/SKILL.md ~/.claude/skills/design-in-browser/SKILL.md
```
Restart Claude sessions so the skill loads.

## Use
- Auto-fires on phrases like "let's design X in the browser", "show me design
  options", "עיצוב בדפדפן", "נצא לעצב את הדף".
- Or run `/design-in-browser`.

## Tip
Drop a per-project copy under `<project>/.claude/skills/design-in-browser/SKILL.md`
to add project-specific paths, tokens, and a gold-standard example mockup to copy.
