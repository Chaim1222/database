# מטמון ויקינתונים - מיפוי הנושאים מחדש (2026-10-16)

נתוני עבודה לבניית `word-filter/wikidata.json` המלא (מחלקות של כל ~26,000 "חסר במכלול" ב-V2), לא קוד בשימוש.
לשקול אם להשאיר בריפו או למחוק לפני מיזוג.

| קובץ | מה |
|---|---|
| `all_titles.json` | כל הכותרות ב-`api.v_missing` ב-V2 (26,099, נשלף 2026-10-16) |
| `titles_done.json` | הכותרות שכבר נשלפו מוויקינתונים (כולן, 26,099) |
| `seeds.json` | הזרעים לבונה המפה (P31/P279/P106 מכל הפריטים) |
| `wd.json` | QID -> {P31, P279, P106} של הפריטים שנשלפו (כולל המדגם וסט הבדיקה) |
| `p279_cache.json` | QID -> "תת-מחלקה של", לבונה המפה (`--cache`) |
| `fetch_titles.py`, `wapi.py` | השליפה; ממשיכה מאיפה שעצרה |

## לבנות מחדש (למשל אחרי שנוספו הרבה ערכים חדשים)
```
cd word-filter/analysis/wikidata-cache
python3 -I fetch_titles.py            # ~3 דקות לכל 1,000 כותרות מהקונטיינר (429 מוויקינתונים)
python3 -c "import json;e=json.load(open('wd.json'));it=[v for v in e.values() if isinstance(v,dict)];json.dump({k:sorted({q for v in it for q in v[k] if q}) for k in ('P31','P279','P106')},open('seeds.json','w'))"
cd ../../..
node word-filter/tools/build-wikidata-map.js --seeds word-filter/analysis/wikidata-cache/seeds.json --cache word-filter/analysis/wikidata-cache/p279_cache.json
node word-filter/tools/topics-eval.js --quiet   # צריך להישאר 94.8% (המפה רק מתרחבת)
node --test word-filter/tests/*.test.js
```
