# tab-status — נקודה צבעונית על ה‑tab של הטרמינל ב‑VS Code

כל סשן של Claude Code מקבל קידומת של עיגול צבעוני על כותרת ה‑tab בטרמינל של VS Code, שמשקפת במבט אחד את המצב הנוכחי של Claude:

| נקודה | משמעות |
|---|---|
| ⚪ | הסשן רק התחיל, עוד לא הורצו פקודות |
| 🔴 | Claude מעבד את הפרומפט שלך |
| 🔵 | Claude מחכה לתשובה שלך לשאלה (`AskUserQuestion`) |
| 🟡 | התשובה הראשית הסתיימה, **סוכנים** (subagents) עדיין רצים ברקע |
| 🩵 | התשובה הראשית הסתיימה, **shells של Bash** עדיין רצים ברקע (תכלת) |
| 🟢 | פנוי / סיים, מוכן לפרומפט הבא |

🟡 לעומת 🩵 מאפשר להבדיל בין שני סוגי עבודת הרקע: 🟡 = `Agent`/subagent עדיין רץ, 🩵 = פקודת `Bash` שהרצת עם `run_in_background:true` עדיין חיה. אם שניהם רצים, 🟡 מנצח.

בניגוד לשאר המצבים, 🩵 **לא** מונע ע"י hook — Claude Code לא משדר אירוע "background shell finished", אז לא היה מה שינקה את הנקודה. במקום זה ה‑watcher סופר ישירות את ה‑shells החיים ברקע (תהליכי zsh שהם ילדים של תהליך ה‑`claude` ב‑TTY הזה ומריצים shell-snapshot eval, בדגימה של ~3 Hz בזמן idle). כשה‑shell מסתיים, התהליך שלו נעלם והנקודה חוזרת לבד ל‑🟢.

## איך זה עובד

שני סקריפטים פלוס שבעה hooks של Claude Code:

- **`tab.sh`** — מטפל ה‑hook. מקבל את האירוע (`white`, `red`, `blue`, `green`, `bg-inc`, `bg-dec`, `session-end`) ומעדכן קובץ מצב פר‑סשן ב‑`~/.claude/terminal-state/<session>.state`. **לא** מצייר ישירות.
- **`tab-watcher.sh`** — מורץ ע"י `tab.sh` ב‑SessionStart (ומורץ מחדש מעצמו בכל hook מאוחר יותר אם הוא חסר). רץ ברקע לאורך כל חיי הסשן של Claude, קורא את קובץ המצב וכותב רצפי escape של OSC (`\033]0;<dot> <name>\a`) ל‑TTY הנוכחי כל 300 ms.
- **`tn`** — CLI קטן שמגדיר/מנקה עקיפת שם פר‑טרמינל. ניתן לקריאה מה‑shell שלך (דרך פונקציית ה‑zsh בשם `tn()`) **או מכלי ה‑Bash של Claude**.

ה‑watcher קיים כי Claude Code עצמו משדר רצפי כותרת של OSC (התווית האוטומטית של הסשן, למשל `* Count to ten in Hebrew`). ציור חד‑פעמי מתוך ה‑hook היה מפסיד במירוץ — Claude כותב מחדש את הכותרת אחרי שה‑hook שלנו חוזר. ה‑watcher מצייר מהר מספיק (5 Hz) כדי שננצח תוך ~300 ms מכל כתיבה של Claude, אז הנקודה נשארת יציבה.

## ה‑hooks המחוברים

| Hook | פעולה | מצב |
|---|---|---|
| `SessionStart` | `tab.sh white` | ⚪ |
| `UserPromptSubmit` | `tab.sh red` | 🔴 |
| `PreToolUse` (matcher: `Agent`) | `tab.sh bg-inc` | מונה בלבד |
| `PreToolUse` (matcher: `AskUserQuestion`) | `tab.sh blue` | 🔵 |
| `PostToolUse` (matcher: `AskUserQuestion`) | `tab.sh red` | 🔴 (חזרה לעבודה) |
| `SubagentStop` | `tab.sh bg-dec` | מונה בלבד |
| `Stop` | `tab.sh green` | 🟢, או 🟡 אם `bg > 0`, או 🩵 אם shells של רקע חיים |
| `SessionEnd` | `tab.sh session-end` | ניקוי |

## קבצי מצב

ב‑`~/.claude/terminal-state/`:

| קובץ | תוכן |
|---|---|
| `<session>.state` | `white` / `red` / `blue` / `green` |
| `<session>.bg` | מונה סוכני רקע (מספר שלם) |
| `<session>.name` | שם התצוגה של ה‑tab (אוטומטי = שם תיקיית הפרויקט) |
| `<session>.watcher_pid` | ה‑PID של ה‑watcher הרץ |
| `tty.<ttysNNN>.name` | עקיפה ידנית שנקבעה ע"י `tn <name>` |
| `hooks.log` | כל הרצה של hook |
| `watcher.log` | התחלה/יציאה של ה‑watcher + heartbeat כל ~6 שניות |

## שינוי שם ידני ל‑tab

```bash
tn payplus     # ה‑tab הופך ל‑"🟢 payplus" (הצבע מתעדכן לפי המצב)
tn             # מנקה את העקיפה, חזרה לשם האוטומטי (שם תיקיית הפרויקט)
```

לתשומת לבך: לחיצה ימנית ב‑VS Code → Rename קובעת כותרת *סטטית* ל‑tab שמתעלמת מרצפי OSC. כדי לקבל את הנקודה, השתמש ב‑`tn` במקום.

## משתלב היטב עם התוסף `skill-tab-name`

אם תתקין גם את [`skill-tab-name`](../skill-tab-name), Claude יבחר אוטומטית שם מתאים לנושא עבור כל סשן ויחיל אותו דרך ה‑CLI בשם `tn` שמגיע כאן. השניים עצמאיים — `tab-status` עובד מצוין גם בלי הסקיל (פשוט קובעים שמות ידנית עם `tn <name>`).

## ניפוי באגים

```bash
tail -f ~/.claude/terminal-state/watcher.log   # heartbeat every ~6 s, includes paint_ok=1/0
tail -f ~/.claude/terminal-state/hooks.log     # every hook fire
ps -ef | grep tab-watcher | grep -v grep       # running watchers
```

אם `paint_ok=0` באופן עקבי, ה‑watcher לא מצליח לכתוב ל‑`/dev/<tty>` — בדוק שמכשיר ה‑TTY קיים וניתן לכתיבה.

אם אין watcher רץ לסשן שאמור להיות לו אחד, פשוט שלח פרומפט באותו טרמינל — הסקריפט יתקן את עצמו ע"י הרצת watcher חדש.
