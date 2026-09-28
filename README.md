# מדגמי המדידה של סינון המילים החשודות

ענף נתונים בלבד (בלי קוד), כדי שלא יהיה צורך להוריד מחדש את הערכים (~40 דקות בגלל הגבלת הקצב של ויקיפדיה).
הקוד והתיעוד בענף הראשי, בתיקייה `word-filter/` (ראו `word-filter/NOTES.md`).

| קובץ | תוכן |
|---|---|
| `blacklist.json.gz` | 2,232 הערכים שב-`blacklist_titles`, כפי שהיו בוויקיפדיה ב-2026-09-24 |
| `dev.json.gz` | 500 ערכים אקראיים מהמכלול (עליהם נבנתה רשימת המותרות) |
| `holdout.json.gz` | 1,520 ערכים אקראיים נוספים מהמכלול (בדיקה עיוורת) |
| `wiki-random.json.gz` | 5,023 ערכים אקראיים מוויקיפדיה, בלי ערכי blacklist - המדגם המייצג (2026-09-24) |
| `to-open-results.jsonl.gz` | תוצאות בדיקת הנקיות של 42,237 "ערכים לפתיחה" (דפי {{דף לטיפול}}), 2026-09-28 - שורה לכל ערך, כמו בסריקת "חסר במכלול". נוצר ב-`word-filter/tools/scan-to-open.js`; הסיכום ב-`word-filter/analysis/to-open/` |

מבנה: `{ "<page id>": { "title": "...", "text": "<ויקיטקסט>" } }`.

שחזור לתיקייה המקומית שהכלים קוראים ממנה:

```
mkdir -p .word-filter-corpus
git fetch origin word-filter-corpus
for n in blacklist dev holdout wiki-random; do
  git show origin/word-filter-corpus:$n.json.gz | gunzip > .word-filter-corpus/$n.json
done
```
