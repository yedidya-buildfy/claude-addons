<div dir="rtl">

# statusline-gsd — ה‑statusline של GSD, מצורף

התיקייה הזו מצרפת את `gsd-statusline.js` מ‑[פרויקט GSD](https://github.com/gsd-build/get-shit-done) כך שסקריפט ההתקנה יכול להשתיל אותו ל‑`~/.claude/` בלי שתצטרך להתקין את כל הפצת GSD המלאה.

**הבסיס אינו הקוד שלי.** זה עותק של GSD בתוספת שינוי מקומי אחד: סגמנט **ניצול תוכנית** (usage). ראו [`ATTRIBUTION.md`](./ATTRIBUTION.md) לקרדיטים ו‑[`LICENSE`](./LICENSE) לרישיון ה‑MIT המקורי.

## מה זה מציג

בתוך ה‑statusline של Claude Code בתחתית כל טרמינל:

```
Fable 5 │ dashbord │ ████░░░░░░ 48% │ 5h 60% ↻2h07m → 13:16 │ wk 31% · Fable 53%
```

- **מודל** — מודל ה‑Claude הנוכחי
- **אמצע** — משימת ה‑TODO הפעילה כעת, או מצב התכנון של GSD אם נמצא `.planning/STATE.md` כלשהו ב‑workspace שלך, או מושמט
- **תיקייה** — שם הבסיס של ה‑cwd
- **מד קונטקסט** — מד התקדמות בן 10 מקטעים שמראה כמה מחלון הקונטקסט ה*שמיש* נוצל. מקודד בצבעים:
  - 🟩 ירוק < 50%
  - 🟨 צהוב 50–65%
  - 🟧 כתום 65–80%
  - 🟥 אדום מהבהב 💀 ≥ 80%
- **ניצול תוכנית** (תוספת מקומית) — אותם נתונים כמו `/usage`:
  - `5h 60% ↻2h07m → 13:16` — ניצול חלון הסשן (5 שעות) + זמן עד איפוס
  - `wk 31%` — ניצול שבועי כולל
  - `Fable 53%` — ניצול שבועי פר‑מודל (מופיע רק כשלמנוי יש מגבלה פר‑מודל)

  אותם ספי צבעים כמו מד הקונטקסט.

### מאיפה נתוני הניצול

- **סשן + שבועי**: מגיעים ישירות ב‑stdin של ה‑statusline (`rate_limits`) — Claude Code מרענן אותם אחרי כל תשובת API. קיים רק במנויי Pro/Max/Team, ורק אחרי התשובה הראשונה בסשן; לפני כן נופל ל‑cache.
- **פר‑מודל**: לא קיים ב‑stdin. הסקריפט `usage-fetch.sh` (מותקן ל‑`~/.claude/scripts/`) שולף את אותו endpoint שבו `/usage` של ה‑CLI משתמש (`api/oauth/usage`, טוקן OAuth מה‑Keychain) וכותב ל‑`~/.claude/cache/claude-usage.json`. ה‑statusline קורא רק את הקובץ, ואם הוא ישן מדקה — משגר את ה‑fetcher ברקע (detached, בלי לחסום רינדור; קובץ lock מונע ריצות כפולות). ה‑endpoint לא מתועד רשמית — אם ישבר, הסגמנט פשוט נעלם והשאר ממשיך לעבוד.

המד לוקח בחשבון את ה‑buffer של ה‑auto-compact ב‑Claude Code (~16.5% כברירת מחדל), אז 100% במד = קונטקסט שמיש מלא (נקודת ההפעלה של ה‑compaction), לא 100% מתקציב הטוקנים הגולמי.

## התקנה ידנית

העתק את `gsd-statusline.js` ל‑`~/.claude/` והפנה אליו את `statusLine` ב‑`~/.claude/settings.json`:

```json
{
  "statusLine": {
    "type": "command",
    "command": "node ~/.claude/gsd-statusline.js"
  }
}
```

## הפצת GSD המלאה

זה עותק נוחות בקובץ אחד. אם אתה רוצה את חוויית GSD ה**מלאה** — תהליכי תכנון, פקודות slash כמו `/gsd-plan-phase`, ה‑hook מסוג PostToolUse לניטור קונטקסט, בודק העדכונים, תוסף הסקילים — התקן את GSD ישירות מהמקור: https://github.com/gsd-build/get-shit-done

אני לא קשור ל‑TÂCHES או ל‑Lex Christopherson. החבילה הזו קיימת רק כי אני מוצא את ה‑statusline שימושי באמת ורציתי שהריפו שלי יהיה עצמאי.

</div>
