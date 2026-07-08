# fable-plan — תכנון בפייבל, ביצוע בסונט

מצב מודל היברידי ל-Claude Code: **Fable 5 במצב תכנון (plan mode), Sonnet 5 בביצוע**. המודל החכם והיקר חושב על התוכנית; המודל המהיר והזול מבצע אותה.

## איך זה עובד

ל-Claude Code יש מצב מובנה בשם `opusplan` — "Opus in plan mode, else Sonnet". משתנה הסביבה `ANTHROPIC_DEFAULT_OPUS_MODEL` קובע לאיזה מודל ה-alias "opus" מתורגם. ההתקנה מוסיפה ל-`~/.claude/settings.json`:

```json
{
  "env": {
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "claude-fable-5"
  }
}
```

ומעכשיו `opusplan` בפועל = פייבל בתכנון (עם קונטקסט 1M), סונט 5 בביצוע.

## שימוש

1. פתח סשן **חדש** (ה-env נטען בהפעלת סשן).
2. `/model opusplan` (או `/model` → "Opus Plan Mode"), או מהטרמינל: `claude --model opusplan`.
3. `shift+tab` ל-plan mode → פייבל 5. אישור התוכנית ויציאה לביצוע → סונט 5 אוטומטית.
4. חזרה לפייבל מלא: `/model fable`.

אם מותקן `statusline-gsd`, שם המודל בסטטוסליין מתחלף לפי המצב — ככה רואים שזה עובד.

## תופעת לוואי

כל בחירה של "Opus" (גם `/model opus` רגיל) תתורגם לפייבל 5 כל עוד ה-env מוגדר. אם אתה כן רוצה אופוס אמיתי לפעמים — הסר את המפתח מ-`settings.json` או בחר את המודל לפי ID מלא.
