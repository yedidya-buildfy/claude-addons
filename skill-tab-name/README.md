<div dir="rtl">

# skill-tab-name — Claude מציע לבד שם קצר ל‑tab

סקיל ל‑Claude Code שעוקב אחרי מה שהשיחה שלך עוסקת בו ומגדיר בשקט את שם ה‑tab בטרמינל של VS Code לתווית קצרה שמתאימה לנושא (1–3 מילים, עדיף 2, אותיות קטנות, בסגנון שמות סקילים). בסוף כל תשובה הוא מוסיף שאלה פתוחה קצרה אחת כדי שתוכל לעקוף:

> *(Renamed tab to "auth bug" — want a different one?)*

## טריגרים

נורה אוטומטית כאשר:
- הכוונה שלך מתבהרת בהודעה המהותית הראשונה או השנייה שלך
- הנושא משתנה באמצע הסשן (פיצ'ר אחר, באג, אזור אחר)

נורה לפי בקשה מפורשת:
- `/tab-name`
- ביטויים כמו "rename tab", "tab name", "שנה שם לטרמינל", "תן שם לטרמינל"

**לא** נורה על:
- ברכות, הודעות זניחות, צילום מסך בודד בלי הקשר
- המשך של אותו נושא
- tabs שכבר קיבעת בהם שם ידני עם `tn`

## התנהגות

| המשתמש אומר | מה הסקיל עושה |
|---|---|
| `"let me fix the payplus webhook"` | בוחר `payplus`, מריץ `tn "payplus"` בשקט, מוסיף בסוף *(Renamed tab to "payplus" — different name?)* |
| `"rename tab to auth"` (שם מפורש) | מריץ `tn "auth"` ישירות, בלי שאלה |
| `"rename tab"` (בלי שם) | בוחר את הניחוש הטוב ביותר, מחיל, ומוסיף שאלת אישור בסוף |
| `"give me options for the name"` | משתמש ב‑`AskUserQuestion` עם 3 מועמדים |

## דרישות

הסקיל הזה קורא ל‑`~/.claude/scripts/tn`, שמותקן ע"י התוסף [`tab-status`](../tab-status). התקן את `tab-status` קודם (או יחד דרך ה‑`install.sh` ברמה העליונה).

## התקנה ידנית

```bash
mkdir -p ~/.claude/skills/tab-name
cp skill-tab-name/SKILL.md ~/.claude/skills/tab-name/SKILL.md
```

Claude Code מגלה את הסקיל אוטומטית בתחילת הסשן הבא שלו.

## סגנון השם

**טוב:** `payplus`, `auth bug`, `tab dots`, `claude addons`, `docs cleanup`, `code review`, `migrations`, `context bar`

**רע (הסקיל דוחה):**
- משפטים ארוכים (`fix-the-payplus-integration-webhook`)
- סיומות גרסה (`auth-fix-attempt-3`)
- אותיות בודדות / מזהים (`T1`, `current`)
- מילים גנריות (`working on stuff`, `code`)

</div>
