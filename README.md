# claude-addons

שלושה תוספים קטנים ל‑[Claude Code](https://claude.com/claude-code) על macOS + VS Code:

| תוסף | מה זה עושה |
|---|---|
| [**tab-status**](./tab-status) | נקודה צבעונית (⚪🔴🔵🟡🩵🟢) על ה‑tab של הטרמינל ב‑VS Code, שמראה אם Claude פנוי, עובד, מחכה לך, מחכה לסוכן רקע (🟡), או מריץ shell של Bash ברקע (🩵). |
| [**skill-tab-name**](./skill-tab-name) | סקיל ל‑Claude Code שבוחר לבד שם קצר ל‑tab (1–3 מילים) לפי מה שהשיחה עוסקת בו. שקט — בלי חלון קופץ; שאלה פתוחה אחת בסוף התשובה כדי שתוכל לעקוף. |
| [**statusline-gsd**](./statusline-gsd) | משתיל את ה‑statusline של [פרויקט GSD](https://github.com/gsd-build/get-shit-done) — שם המודל, המשימה הנוכחית, ומד ניצול הקונטקסט בתחתית כל סשן של Claude. |

השלושה עצמאיים — אפשר להתקין כל שילוב. אין ביניהם תלויות קשיחות, אבל `skill-tab-name` כן משתמש ב‑CLI בשם `tn` שמותקן ע"י `tab-status`, אז הוא הכי שימושי כששניהם מותקנים.

## התקנה

```bash
git clone https://github.com/yedidya-buildfy/claude-addons.git
cd claude-addons
./install.sh
```

ההתקנה אינטראקטיבית — היא שואלת לפני כל תוסף, יוצרת גיבויים עם חותמת זמן לכל מה שהיא משנה (`*.bak.YYYY-MM-DD-HHMMSS`), ואידמפוטנטית (בטוח להריץ שוב).

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
│   └── tn                     ← from tab-status/
├── skills/tab-name/
│   └── SKILL.md               ← from skill-tab-name/
├── gsd-statusline.js          ← from statusline-gsd/
├── settings.json              ← hooks block merged in
└── terminal-state/            ← runtime state, auto-created

~/.zshrc                       ← optional `tn` shell wrapper appended
~/Library/Application Support/Code/User/settings.json
                               ← terminal.integrated.tabs.title added
```

## רישיון

הקוד של הריפו עצמו הוא MIT — ראו [`LICENSE`](./LICENSE). ה‑statusline של GSD המצורף הוא גם MIT, בזכויות יוצרים של Lex Christopherson — ראו [`statusline-gsd/LICENSE`](./statusline-gsd/LICENSE) ו‑[`statusline-gsd/ATTRIBUTION.md`](./statusline-gsd/ATTRIBUTION.md).
