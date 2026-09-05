# פס מצב מודע־ספק

## מטרה

פס המצב יציג מידע שמתאים למודל הפעיל במקום להציג תמיד את מכסות Claude:

- שם המודל
- רמת המאמץ החיה של הסשן
- גודל חלון הקונטקסט האמיתי
- מכסות הספק הפעיל בלבד
- זמני איפוס זמינים
- ב־Codex: מספר reset credits הזמינים ומועד הפקיעה הקרוב ביותר

אסור להציג ערך מנוחש, cache של ספק קודם, טוקן התחברות, כתובת חשבון או תגובת API גולמית.

## תצוגה

דוגמאות מבניות:

```text
Fable 5 · high · 1M ctx | PMS | 5h ███░░░░░░░ 30% ↻2h11m → 16:49 | wk █████████░ 89% | Fable ████████░░ 81%
```

```text
GPT 5.6 Sol · high · 372K ctx | PMS | 5h █████░░░░░ 51% ↻1h42m → 16:20 | wk ███░░░░░░░ 34% ↻3d → 31/8 | resets 3 · next expires 18h → 29/8 09:10
```

```text
Gemini 3.1 Pro · high · 1.05M ctx | PMS | 5h ████░░░░░░ 43% ↻2h08m → 16:46 | wk ██░░░░░░░░ 22% ↻4d → 1/9
```

```text
Grok 4.6 · high · 500K ctx | PMS | wk ██████░░░░ 64% ↻2d → 30/8
```

כללים:

1. המאמץ מגיע מ־`effort.level` ב־stdin של Claude Code ומשתנה מיד אחרי `/effort`.
2. גודל הקונטקסט מגיע מ־`context_window.context_window_size`; אין הסקה משם המודל.
3. מד ניצול הקונטקסט הקיים נשאר נפרד מגודל החלון.
4. מודל שאינו Claude לעולם לא מציג `5h`, `wk` או מגבלה פר־מודל של Claude.
5. חלון מכסה שאין לו label רשמי יקבל label לפי משכו: `5h`, `day`, `wk`, או משך מפורש.
6. reset credit ללא תאריך פקיעה נספר, אך אינו מועמד ל־`next expires`.
7. אם אין snapshot תקין ורענן, יוצג `<Provider> usage unavailable`.

## ארכיטקטורה

### פורמט cache מנורמל

כל collector כותב atomically קובץ JSON ללא סודות:

```json
{
  "provider": "codex",
  "fetchedAt": 1787929200000,
  "source": "official-client",
  "windows": [
    {
      "id": "primary",
      "label": "5h",
      "usedPercent": 51,
      "resetsAt": 1787935320
    }
  ],
  "resetCredits": {
    "availableCount": 3,
    "nextExpiresAt": 1787991000
  }
}
```

ה־renderer קורא רק פורמט זה. תגובות ספק אינן מגיעות אליו ישירות.

### רינדור

`gsd-statusline.js`:

1. מזהה ספק לפי השם הקריא של המודל.
2. בונה label מודל עם effort וגודל context.
3. ב־Claude משתמש ב־`rate_limits` החי וב־cache הקיים.
4. בספק אחר קורא cache מנורמל של אותו ספק בלבד.
5. cache ישן מסומן `stale`; אחרי hard expiry אינו מוצג כנתון אמיתי.
6. אם cache חסר או לא תקין, משגר collector detached עם lock פר־ספק וממשיך לרנדר מיד.

אין network, PTY או קריאת credential store במסלול הרינדור.

## Collectors

### Claude

המנגנון הקיים נשאר:

- `rate_limits` החי מקבל קדימות.
- endpoint השימוש שבו משתמש Claude Code משלים מגבלות scoped.
- cache מתרענן ברקע.

### Codex

מקור: `codex app-server`, המשתמש בהתחברות הקיימת של Codex.

ה־collector:

1. מפעיל app-server על stdio.
2. שולח `initialize`, מחכה לתשובה, ואז `initialized`.
3. שולח `account/rateLimits/read`.
4. קורא `rateLimits`, `rateLimitsByLimitId` ו־`rateLimitResetCredits`.
5. מנרמל primary/secondary וכל bucket מזוהה.
6. סופר רק credits במצב `available`.
7. מוצא `expiresAt` עתידי מינימלי.
8. סוגר את התהליך בתוך timeout קשיח.

אין קריאה ישירה מקובצי OAuth ואין שליחת model request.

### Google / Antigravity

הלקוח הרשמי אינו מותקן כרגע. המתקין יציע התקנה דרך ההתקנה הרשמית של Google וידרוש login נפרד אם ה־credential store אינו מזוהה.

המקור המועדף הוא payload ה־statusline המתועד של Antigravity:

- `quota.*.remaining_fraction`
- `quota.*.reset_time`
- `quota.*.reset_in_seconds`

helper יכתוב snapshot מסונן בכל state change של Antigravity.

כדי לרענן בזמן שימוש דרך CCX בלבד, collector רשאי להפעיל session קצר ומבודד של הלקוח הרשמי ב־PTY, להמתין ל־statusline callback ראשון, ואז לסגור. הוא לא שולח prompt למודל. אם הלקוח אינו מפיק callback בלי עבודה, הנתון מסומן unavailable; אין fallback ל־`v1internal` ואין קריאה ישירה לטוקן Google.

### Grok

אין API headless רשמי למכסת מנוי. הלקוח הרשמי מותקן ומציג שימוש בממשק האינטראקטיבי.

collector יפעיל אותו ב־PTY מבודד, יפתח תחילה את `/help`, וישתמש ב־`/usage` רק אם הפקודה רשומה בגרסה המותקנת. הוא יחלץ רק אחוז וריסט, ואז יצא. אם `/usage` אינה רשומה, Grok מסומן unavailable ללא ניסיון חלופי. כללים:

- אין prompt למודל.
- timeout קשיח.
- parser מאפשר רק פורמטים שנבדקו כ־fixture.
- output לא מזוהה אינו מתפרש חלקית; מתקבל unavailable.
- אין שימוש בנתוני API billing או rate-limit headers כתחליף למכסת המנוי.

זה adapter פחות יציב מ־Claude/Codex/Google ולכן failure שלו מבודד.

## רענון וטריות

- Claude: הנתון החי בכל תשובה; cache עד 60 שניות.
- Codex: refresh אחרי 60 שניות.
- Google ו־Grok: refresh אחרי 120 שניות בגלל עלות הפעלת CLI.
- snapshot בן עד 10 דקות מוצג עם `stale` בלבד אם refresh נכשל.
- snapshot ישן מ־10 דקות אינו מציג אחוזים.
- lock פר־ספק מונע collectors מקבילים.
- כתיבה מתבצעת לקובץ זמני ואז rename.

## אבטחה

1. כל קובצי ההתחברות של CLIProxyAPI מקבלים mode `0600` כחלק מההתקנה וה־self-check.
2. cache מקבל mode `0600` ואינו כולל email, account id, project id, token, headers או response גולמי.
3. אין endpoint HTTP חדש.
4. אין פתיחת listener מעבר ל־loopback הקיים.
5. statusline לעולם אינו קורא credential files.
6. collectors אינם מדפיסים stdout/stderr רגיש; שגיאות נשמרות כקוד קצר בלבד.
7. כל process מקבל timeout ונאסף גם בכשל parse.

## שינויים בריפו

- הרחבת renderer הקיים לזיהוי ספק, effort, context ו־cache מנורמל.
- collector חדש שמכיל adapters מבודדים ל־Codex, Google ו־Grok.
- helper קטן ל־statusline של Antigravity.
- self-test אחד עם fixtures לכל ספק, stale cache, malformed output והחלפת ספק.
- עדכון installer להעתקה, הרשאות, והצעת התקנת Antigravity.
- עדכון README עם התצוגה, מקורות הנתונים והמגבלות.

## בדיקות

### אוטומטיות

1. GPT אינו מציג אף מכסת Claude.
2. Claude ממשיך להציג את שלושת סוגי המכסה הקיימים.
3. effort חסר מושמט ללא separator כפול.
4. context מוצג כ־`200K`, `372K`, `500K`, `1M` או `1.05M` לפי ערך אמיתי.
5. Codex מציג כל חלון פעם אחת ומחשב reset credit הקרוב בלבד.
6. Google ממיר remaining fraction ל־used percent.
7. Grok malformed output מחזיר unavailable.
8. cache stale וה־hard expiry מתנהגים לפי המדיניות.
9. מעבר בין ארבעת הספקים אינו מדליף cache של הספק הקודם.
10. קובצי cache והתחברות נשארים mode `0600`.

### אימות חי

1. לבחור Claude ולהשוות ל־`/usage`.
2. לבחור GPT ולהשוות לנתוני החשבון שמחזיר Codex.
3. לשנות `/effort` ולוודא שינוי מיידי.
4. לבחור Gemini ולהשוות ל־`/usage` של Antigravity.
5. לבחור Grok ולהשוות למסך Usage הרשמי.
6. לבצע בקשת מודל אחת בכל ספק ולוודא refresh.
7. להחליף ספק ולוודא שמכסת הקודם נעלמת.
8. לנתק רשת ולוודא שה־statusline נשאר מהיר ומסמן stale/unavailable.
9. לבדוק שאין secrets בקבצי cache.

## מגבלות מפורשות

- Google לא יקבל direct OAuth integration לממשק `v1internal`.
- Grok תלוי ב־output אינטראקטיבי ויכול להפוך unavailable אחרי עדכון CLI.
- אין הבטחה להצגת שימוש לספק שלא חושף snapshot אמין.
- שום collector לא יבצע model request רק כדי לקבל rate-limit headers.

## מקורות

- OpenAI Codex App Server: https://learn.chatgpt.com/docs/app-server
- OpenAI Codex protocol types: https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/src/protocol/v2/account.rs
- Google Antigravity status line: https://www.antigravity.google/docs/cli/statusline/
- Google Antigravity usage: https://www.antigravity.google/docs/cli/commands/usage/
- Google Antigravity install: https://www.antigravity.google/docs/cli/install
- xAI Grok usage: https://docs.x.ai/grok/faq
