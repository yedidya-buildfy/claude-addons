<div dir="rtl">

# claude-addons

תוספים קטנים ל‑[Claude Code](https://claude.com/claude-code) על macOS + VS Code:

| תוסף | מה זה עושה |
|---|---|
| [**tab-status**](./tab-status) | נקודה צבעונית (⚪🔴🟣🟠🔵🟡🟤🟢) על ה‑tab של הטרמינל ב‑VS Code, שמראה אם Claude פנוי, עובד, בונה תוכנית (🟣), מחכה להחלטה שלך על תוכנית (🟠), מחכה לתשובה שלך (🔵), מחכה לסוכן רקע (🟡), או מריץ shell של Bash ברקע (🟤). |
| [**skill-tab-name**](./skill-tab-name) | מסלול הגיבוי לשמות ה‑tab: `tab-status` נותן שם אוטומטית מתוך הפרומפט שלך, והסקיל הזה נכנס לפעולה כשאתה מבקש שם במפורש, או כשהקריאה האוטומטית נכשלה. |
| [**skill-design-in-browser**](./skill-design-in-browser) | סקיל ל‑Claude Code שמעצב UI בדפדפן לפני נגיעה בקוד: בונה mockup HTML עצמאי עם 2–3 גרסאות בלשוניות, פותח בדפדפן לאיטרציה, ומיישם ל‑React/וכו׳ רק אחרי שאתה מאשר. משתמש ב‑impeccable או בכל סקיל UI/UX אם מותקן. |
| [**statusline-gsd**](./statusline-gsd) | משתיל את ה‑statusline של [פרויקט GSD](https://github.com/gsd-build/get-shit-done) — שם המודל, המשימה הנוכחית, ומד ניצול הקונטקסט בתחתית כל סשן של Claude — בתוספת מקומית של ניצול התוכנית כמו `/usage`: סשן 5 שעות (+זמן לאיפוס), שבועי, ושבועי פר‑מודל (Fable). |
| [**sticky-prompt**](./sticky-prompt) | תיבת ההודעה שלך עצמה ננעצת בראש הטרמינל של VS Code, במקום פקודת ה‑shell שפתחה את הסשן. גוללים מעל ההודעה האחרונה והנעוץ הופך לזו שמעליה; לחיצה עליו קופצת חזרה להודעה. עוטף שמריץ את Claude מאחורי פסאודו‑טרמינל ומזריק סימונים לתוך הפלט שלו. |
| [**multi-model**](./multi-model) | מריץ את Claude Code — עם הסקילים, ההוקים והכלים שלך — על המודלים של המנויים האחרים שלך: ChatGPT/Codex, Grok, ו‑Antigravity של גוגל. התחברות דרך המנוי בלבד (OAuth בדפדפן), בלי שום מפתח API. `claude` עצמו הוא נקודת הכניסה, ומתג (`ccx on` / `ccx off`, דלוק כברירת מחדל) קובע אם הסשן עובר דרך שרת מקומי שמאזין רק ל‑127.0.0.1; אם השרת לא זמין הסשן נפתח בדרך הרגילה במקום להיכשל. תפריט `/model` מציג רק את הדור הנוכחי של כל קו מודלים, ובנוסף מצב `Fable Plan → Opus` שבו פייבל מתכנן ואופוס מבצע עם חלון של מיליון. אין רשימת מודלים קשיחה: גרסה חדשה נכנסת לבד והישנה נעלמת. ברירת המחדל וה‑effort נזכרים כרגיל, בזוג נפרד משלו, וגודל הקונטקסט נלקח מהספק עצמו במקום מהנחת 200k. כשהמתג כבוי `claude` מתנהג בדיוק כמו קודם. מדריך מלא נמצא בתיקיית התוסף. |
| [**phone-alerts**](./phone-alerts) | התראה לטלפון כשקלוד צריך אותך: שאלה, תוכנית שממתינה לאישור, או סוף עבודה (עם תחילת התשובה כסיכום). עובר דרך [ntfy](https://ntfy.sh) — אפליקציה חינמית, בלי חשבון. כל אחד מייצר לעצמו נושא פרטי בהתקנה, כך ששום התראה לא עוברת בין משתמשים; בלי הצעד הזה התוסף שותק. הכותרת מציינת את הפרויקט ואת שם הטאב כדי שתדע מי מבין הסשנים קורא לך, והתראות שמגיעות יחד מסודרות בתור במרווח של 5 שניות במקום ליפול כערימה. מתריע רק על טרמינל שממתין לך: סוכן שרץ ברקע שותק לגמרי, וסיום תור שעוד תלויים בו סוכן משנה או פקודת רקע מחכה לסיום האמיתי. |
| [**fable-plan**](./fable-plan) | מצב מודל היברידי: Fable 5 מתכנן (plan mode, קונטקסט 1M), Sonnet 5 מבצע. alias בשם `fplan` שפותח סשן `opusplan` עם פייבל במקום אופוס — תחום לסשן בלבד, לא נוגע בשאר. |

כולם עצמאיים — אפשר להתקין כל שילוב. אין ביניהם תלויות קשיחות, אבל `skill-tab-name` כן משתמש ב‑CLI בשם `tn` שמותקן ע"י `tab-status`, אז הוא הכי שימושי כששניהם מותקנים.

## התקנה

להתקנת כל התוספים לבחירה:

```bash
git clone https://github.com/yedidya-buildfy/claude-addons.git
cd claude-addons
./install.sh
```

להתקנת `ccx` בלבד כפקודה גלובלית:

```bash
./multi-model/install.sh
```

שני המתקינים אינטראקטיביים, יוצרים גיבויים לפני החלפה, ושומרים הגדרות שאינן בבעלות התוסף. בטוח להריץ אותם שוב לצורך עדכון.

## עדכונים אוטומטיים

מרגע ההתקנה, **התוספים מתעדכנים לבד ברקע** פעם ב־12 שעות (בעת פתיחת סשן Claude Code). כל שינוי שנדחף למאגר נמשך ומותקן אוטומטית אצל כל מי שהתקין.

לעדכון יזום ומיידי בכל רגע:
```bash
ccx update
# או מתוך התיקייה:
~/.claude/scripts/claude-addons-update.sh --force
```

## Bootstrap באמצעות AI

אפשר לתת ל‑AI את כתובת המאגר ולבקש: “הכן את המחשב הזה ל‑ccx”.
הקבצים [`CLAUDE.md`](./CLAUDE.md) ו‑[`AGENTS.md`](./AGENTS.md) מסבירים לסוכני קוד
איזה מתקין להריץ, מה אסור להעתיק ממחשב אחר, אילו בדיקות נדרשות, ואיך להוכיח
שהפקודה הגלובלית וכל הספקים עלו בהצלחה.

## הסרה

```bash
./uninstall.sh
```

מסיר את הסקריפטים שהותקנו ומחזיר את רשומות ה‑hooks שהוא הוסיף. משאיר את `~/.zshrc` ואת `~/.claude/gsd-statusline.js` במקומם, למקרה שתרצה להמשיך להשתמש בהם בנפרד.

## דרישות

- macOS (סביר שגם Linux עובד — שום חלק מלוגיקת ההתקנה לא ספציפי ל‑Mac, אבל זה לא נבדק שם באופן קבוע)
- VS Code (עבור `tab-status`; התנהגות כותרת ה‑tab דרך OSC ספציפית ל‑VS Code)
- Claude Code (כל גרסה עדכנית עם תמיכה ב‑hooks + skills)
- Node.js (כבר נדרש ע"י Claude Code)
- Python 3 (לפענוח JSON בסקריפט ה‑hook — `/usr/bin/python3` מגיע עם macOS)

## מה נמצא איפה אחרי ההתקנה

```
~/.claude/
├── scripts/
│   ├── tab.sh                 ← from tab-status/
│   ├── tab-watcher.sh         ← from tab-status/
│   ├── tn                     ← from tab-status/
│   ├── tab-dots-selftest.sh   ← from tab-status/
│   ├── sticky-claude          ← from sticky-prompt/
│   ├── ccx                    ← from multi-model/
│   ├── ccx-models.py          ← from multi-model/
│   ├── ccx-rewrite.js         ← from multi-model/
│   └── sanitize-schema.js     ← from multi-model/
├── skills/tab-name/
│   └── SKILL.md               ← from skill-tab-name/
├── gsd-statusline.js          ← from statusline-gsd/
├── settings.json              ← hooks block merged in
└── terminal-state/            ← runtime state, auto-created

~/.zshrc                       ← optional `tn` shell wrapper appended
~/Library/Application Support/Code/User/settings.json
                               ← terminal.integrated.tabs.title added

$(brew --prefix)/etc/cliproxyapi.conf   ← from multi-model/ (loopback only)
~/.cli-proxy-api/                       ← multi-model provider logins + local key
```

## רישיון

הקוד של הריפו עצמו הוא MIT — ראו [`LICENSE`](./LICENSE). ה‑statusline של GSD המצורף הוא גם MIT, בזכויות יוצרים של Lex Christopherson — ראו [`statusline-gsd/LICENSE`](./statusline-gsd/LICENSE) ו‑[`statusline-gsd/ATTRIBUTION.md`](./statusline-gsd/ATTRIBUTION.md).

</div>
