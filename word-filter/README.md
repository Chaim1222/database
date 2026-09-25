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
| `lists/usage.json` | קבוצת השימוש של כל מילה (A: בעייתית ב-75% ומעלה מהמופעים, B: 40%-75%, C: פחות מ-40%) ועוגנים מוחלטים - לרמות החשד. נבנה ב-`tools/build-usage.js` מהסיווג הידני. השדה `override` במשפחה גובר על החישוב. |
| `tools/build-usage.js` | בונה את `lists/usage.json` מ-`analysis/missing-labels.json` ומ-`analysis/wiki-random-occurrences.json`. |
| `analysis/word-rates.md`, `missing-labels.json` | 1,800 מופעים מסווגים מ"חסר במכלול", ושיעור הבעייתיות לכל מילה. |
| `analysis/suspicion.md`, `suspicion.js`, `anchors.json` | רמות החשד: ההגדרה והבדיקה מול הסיווג הידני. |
| `tools/scan-missing.js` | סינון כל רשימת "חסר במכלול" ושמירה בסופבייס (`word_filter_results`) - לדשבורד. רץ ב-GitHub Actions (`word_filter_scan.yml`). |
| `tools/evaluate.js` | מדידה מול ערכים אמיתיים (ראו למטה). |
| `tools/apply-decisions.js` | מחיל את ההחלטות מדף הסקירה על קובצי ה-JSON. |
| `tools/build-lists.js` | ההסבה החד-פעמית מהדפים הקיימים ל-JSON - לתיעוד. |
| `sources/` | העותקים של הדפים המקוריים ושל ההצעות, שמהם נבנה ה-JSON. |
| `review/` | דף הסקירה המשותף (`index.html`), הנתונים שלו ו-`build-data.js` שמרכיב אותם. |
| `analysis/` | סיווג מופעי המילים במדגם האקראי מוויקיפדיה (בעייתי / תמים / לא ברור) - הבסיס להחלטה על רמה. |
| `decisions/` | גיבויים של ההחלטות מדף הסקירה. |
| `corpus-ids/` | מזהי הדפים של מדגמי המדידה - לשחזור מדויק (`evaluate.js fetch-ids`). |
| `NOTES.md` | יומן העבודה: מצב נוכחי, החלטות ונימוקים, ממצאים, מה ממתין. **להתחיל ממנו בכל סשן.** |

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
node word-filter/tools/evaluate.js fetch-random wiki-random wikipedia 2000   # מדגם מייצג מוויקיפדיה (בלי blacklist)
node word-filter/tools/evaluate.js contexts /tmp/contexts.json    # הקשרי המופעים במדגם האקראי - לסיווג
node word-filter/tools/evaluate.js fetch-ids dev mechalol word-filter/corpus-ids/dev.txt   # שחזור מדגם קיים
node word-filter/tools/evaluate.js report --lost        # אחרי כל שינוי ברשימות
node word-filter/tools/evaluate.js noisy 40             # הרשומות שתופסות הכי הרבה במכלול
node word-filter/tools/evaluate.js candidates cands.txt # תבנית מועמדת: כמה חסומים היא מוסיפה, כמה מכלול היא תופסת
```

ב-`--json`, לכל התאמה יש שדה `context` ובו `{before, text, after}`: המשפט שבו נמצאה ההתאמה, כטקסט קריא בלי קישורים, תבניות והערות שוליים. זה השדה שדשבורד צריך להציג, כי העורך לא רואה שם את הטקסט המלא (הפונקציה `contextOf` במנוע).

`check.js` מחזיר קוד יציאה 3 לבעיה ודאית, 2 ללבדיקה, 1 ל"דורש ניסוח" (רק הערות ניסוח), 0 לנקי, 9 לשגיאה. המאגרים נשמרים ב-`.word-filter-corpus/` (מחוץ ל-git); עותק דחוס בענף `word-filter-corpus`. **המדד המייצג הוא `wiki-random`**: ב-blacklist המילים כמעט תמיד בהקשר בעייתי ובמכלול כמעט תמיד תמים, כך ששניהם לא מלמדים איך מילה מתנהגת בערכים רגילים.

## סינון רשימת "חסר במכלול" (הדשבורד)

`tools/scan-missing.js` עובר על כל ערך ב-`report_missing_from_mechalol`, סורק אותו במנוע, ושומר ב-`word_filter_results`:

| שדה | מה |
|---|---|
| `verdict` / `verdict_suggested` | רמת הדף לפי הרשימות המאושרות / כולל ההצעות: `problem`, `review`, `wording`, `clean` |
| `counts` | מספר ההתאמות בכל רמה, לכל מצב (`a`, `s`) |
| `matches` | עד 300 התאמות: המילה, מספר השורה, הנושא, הרמה בכל מצב (`a`/`s`, או null), הרשומות, והמשפט (`b` + `x` + `f`) |
| `has_images`, `photo_count`, `images` | תמונות **של הערך**: קובץ שמופיע בקוד הערך, או התמונה הראשית (PageImages, כולל תמונה מוויקינתונים). SVG ואייקונים מתבניות (Allmusic, כוכבים, "קצרמר") לא נספרים. |
| `rev_id`, `lists_version` | כדי לדלג על ערך שלא השתנה. שינוי ברשימות או במנוע = סריקה מחדש. |

```
SUPABASE_URL=... SUPABASE_SERVICE_KEY=... node word-filter/tools/scan-missing.js [--force] [--prune]
node word-filter/tools/scan-missing.js --ids-file ids.txt --dry-run --out results.jsonl   # בלי סופבייס
```

הגאדג'ט `gadget/gadget-searchHelperDashboard.js` מסנן את טאבי "חסר במכלול" לפי ה-view `report_missing_word_filter`: רמת תוכן, בורר רשימות (מאושרות / כולל הצעות), ותמונות (עם / בלי). כפתור "הקשר" בכל שורה פותח את המילים במשפטים שלהן, ואת שמות התמונות כקישורים בלבד, בלי להציג את התמונות עצמן.

### רמות חשד (לפי הקשר)

`engine.contextLevels(wikitext, matches, usage)` נותן לכל התאמת צניעות `match.context = {group, level, suspicion}`, ו-`engine.contextVerdict(matches)` נותן את רמת הדף. הרמה נקבעת משני ממדים:

| קבוצת המילה | לבד במשפט | הקשר חלש (מילה חשודה במשפט, או עוגן בערך) | הקשר חזק (עוגן במשפט, או מילה חשודה + עוגן בערך) |
|---|---|---|---|
| עוגן מוחלט, או רשומת "בעיה" בלי נתונים | בעיה ודאית | בעיה ודאית | בעיה ודאית |
| A (75% ומעלה) | חשד גבוה | בעיה ודאית | בעיה ודאית |
| B (40%-75%) | חשד בינוני | חשד גבוה | בעיה ודאית |
| C (פחות מ-40%) | חשד נמוך | חשד בינוני | חשד גבוה |

- "עוגן" = מילה מקבוצה A, עוגן מוחלט, או רשומת "בעיה" בלי נתונים.
- התאמה שירדה לבדיקה בגלל היתר מסוג demote לא תהיה "בעיה ודאית", אלא לכל היותר חשד גבוה.
- הנתונים שמאחורי הטבלה: `analysis/word-rates.md`.

