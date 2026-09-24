# סינון מילים חשודות בוויקיטקסט

כלי לבדיקת ערכים לפני ייבוא למכלול (ובתוך המכלול): סורק את קוד הוויקיטקסט ומסווג את הדף, מבחינת צניעות, לשלוש רמות:

| רמה | משמעות |
|---|---|
| **בעיה ודאית** | נמצאה מילה שהיא בעיה במובהק (פורנו, זונה, fuck). |
| **לבדיקה** | נמצאה רק מילה דו-משמעית (מין, רומן, אונס במובן ההלכתי). |
| **נקי** | לא נמצא דבר. |

אמונה ונצרות, תיארוך ומדע ושאריות מוויקיפדיה מוצגים בנפרד כ**הערות ניסוח**: הם דורשים ניסוח מחדש ולא פסילה, ולכן לא משפיעים על הרמה. (כחלק מהרמה, 82% מערכי המכלול היו יוצאים "לבדיקה" בגלל מילים כמו "האל" ו"לפנה"ס".)

## מבנה

| קובץ | מה יש בו |
|---|---|
| `lists/words.json` | רשימת התבניות: לכל רשומה תבנית, רמה, נושא, סטטוס, מקור והסבר. |
| `lists/allow.json` | ביטויים מותרים ("המין האנושי", "בואנוס איירס") - התאמה שנופלת כולה בתוכם לא מוצגת. |
| `Gadget-wikitextWordCheck.js` | המנוע והגאדג'ט לאתר (JS). אותו קובץ משמש גם את הכלים שבריפו. |
| `tools/check.js` | בדיקת דף אחד משורת הפקודה. |
| `tools/evaluate.js` | מדידה מול ערכים אמיתיים (ראו למטה). |
| `tools/apply-decisions.js` | מחיל את ההחלטות מדף הסקירה על קובצי ה-JSON. |
| `tools/build-lists.js` | ההסבה החד-פעמית מהדפים הקיימים ל-JSON - לתיעוד. |
| `sources/` | העותקים של הדפים המקוריים ושל ההצעות, שמהם נבנה ה-JSON. |

### שדות רשומה (`words.json`)

- `level`: `problem` (בעיה ודאית) / `review` (לבדיקה).
- `topic`: `modesty` / `faith` / `dating` / `wiki`.
- `status`: `active` - פעיל; `suggested` - **הצעה שלא אושרה, לא נבדקת** (אלא אם מבקשים במפורש).
  `rejected` - נדחה בסקירה; נשאר בקובץ לתיעוד ולא נבדק.
- `reviewed`: האם אדם אישר את הרמה והנושא. אחרי ההסבה - `false` לכולם.
- `caseSensitive`: רשומות מ"בדיקת מילים חשודות" (שם אין דגל i, ולכן יש בה `sex|Sex|SEX`).
- `sources`, `original` (התבנית כפי שהייתה, אם תוקנה), `note`.

הרמה והנושא נקבעו בהסבה לפי הרשימה שהתבנית הגיעה ממנה (אדום כהה ובומח-צניעות = בעיה ודאית), ולא אוטומטית לפי מדגם: המכלול נקי ברובו אבל לא במאה אחוז, ומילה שמופיעה בו יכולה להיות בדיוק תוכן שצריך לנקות. ההחלטה של העורכים.

## למה JavaScript ולא Lua

הבדיקה החיה חייבת לרוץ בדפדפן, על תיבת העריכה - לפני שמירה. Lua (Scribunto) רץ רק בשרת בזמן עיבוד הדף, ותבניות ה-Lua אינן ביטויים רגולריים מלאים: אין בהן `|` (חלופות), lookbehind או lookahead, שהרשימות הקיימות משתמשות בהם בכל מקום. Lua יכול לשמש להצגת קובצי ה-JSON כטבלה קריאה בדף ויקי (`mw.loadJsonData`), אבל לא לבדיקה עצמה.

גם הכלים שבריפו כתובים ב-JS ומשתמשים באותו קובץ מנוע - כך אין שני מנועים שצריך לשמור מסונכרנים.

## הגאדג'ט באתר

1. להעלות את `Gadget-wikitextWordCheck.js` כגאדג'ט.
2. ליצור שני דפי JSON (מודל תוכן JSON): `מדיה ויקי:Gadget-wikitextWordCheck-words.json` ו-`מדיה ויקי:Gadget-wikitextWordCheck-allow.json`, עם התוכן של `lists/`. (דפי מרחב "מדיה ויקי" ניתנים לעריכה רק למנהלי ממשק. אם עדיף שעורכים רגילים יתחזקו את הרשימות - אפשר דף במרחב אחר עם שינוי מודל תוכן, ולעדכן את `WORDS_PAGE`/`ALLOW_PAGE` בראש הקובץ.)
3. בדף עריכה מופיע "בדיקת מילים חשודות בקוד" בתפריט הפעולות.

הגדרות אישיות (common.js): `window.wikitextWordCheckSuggested = true` - לכלול הצעות שלא אושרו; `window.wikitextWordCheckAllow = ['...']` - ביטויים מותרים נוספים.

## בדיקה ומדידה

```
node word-filter/tools/check.js --title "שם ערך"                  # ויקיפדיה; --wiki mechalol למכלול
node word-filter/tools/check.js --file page.wikitext --suggested --json
node --test word-filter/tests/*.test.js

node word-filter/tools/evaluate.js fetch-blacklist --ids-file ids.txt   # או מסופרבייס עם SUPABASE_URL/SUPABASE_SERVICE_KEY
node word-filter/tools/evaluate.js fetch-mechalol dev 500
node word-filter/tools/evaluate.js fetch-mechalol holdout 1500
node word-filter/tools/evaluate.js report --lost        # אחרי כל שינוי ברשימות
node word-filter/tools/evaluate.js noisy 40             # הרשומות שתופסות הכי הרבה במכלול
node word-filter/tools/evaluate.js candidates cands.txt # תבנית מועמדת: כמה חסומים היא מוסיפה, כמה מכלול היא תופסת
```

`check.js` מחזיר קוד יציאה 2 לבעיה ודאית, 1 ללבדיקה, 0 לנקי. המאגרים נשמרים ב-`.word-filter-corpus/` (מחוץ ל-git).
