# fable-plan — תכנון בפייבל, ביצוע בסונט

מצב מודל היברידי ל-Claude Code: **Fable 5 במצב תכנון (plan mode), Sonnet 5 בביצוע**. המודל החכם והיקר חושב על התוכנית; המודל המהיר והזול מבצע אותה.

## איך זה עובד

ל-Claude Code יש מצב מובנה בשם `opusplan` — "Opus in plan mode, else Sonnet". משתנה הסביבה `ANTHROPIC_DEFAULT_OPUS_MODEL` קובע לאיזה מודל ה-alias "opus" מתורגם. ההתקנה מוסיפה alias ל-`~/.zshrc`:

```bash
alias fplan='ANTHROPIC_DEFAULT_OPUS_MODEL=claude-fable-5 claude --model opusplan'
```

ה-env מוזרק **רק לסשן שנפתח דרך `fplan`** — סשני `claude` רגילים לא מושפעים, ו-`/model opus` בהם עדיין נותן אופוס אמיתי.

(האלטרנטיבה — env גלובלי ב-`~/.claude/settings.json` — עובדת גם, ואז `/model opusplan` נותן פייבל+סונט מכל סשן; המחיר: כל בחירת "opus" הופכת לפייבל, ואופוס אמיתי זמין רק לפי ID מלא `claude-opus-4-8`.)

## שימוש

1. `source ~/.zshrc` (פעם אחת אחרי ההתקנה).
2. `fplan` במקום `claude`.
3. `shift+tab` ל-plan mode → פייבל 5 (קונטקסט 1M). אישור התוכנית ויציאה לביצוע → סונט 5 אוטומטית.

אם מותקן `statusline-gsd`, שם המודל בסטטוסליין מתחלף לפי המצב — ככה רואים שזה עובד.

## הסרה

מחק את שורת ה-alias מ-`~/.zshrc`.
