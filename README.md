# השוואת ערכים - ויקיפדיה העברית מול המכלול

## הגדרה נדרשת לפני הרצה
1. להריץ את `schema.sql` בעורך ה-SQL של סופרבייס (התקנה חדשה), או `migration_manual_matches_and_cleanup_columns.sql` (מעבר מסביבה קיימת - **קרא את האזהרה בראש הקובץ לפני הרצה**, יש בו DROP TABLE). התקנה קיימת שכבר עברה את המיגרציה הזו בעבר צריכה להריץ בנוסף גם את `migration_add_is_missing_flag.sql` (ראו הערה על `is_missing` למטה) ואת `migration_add_checked_columns.sql`/`migration_document_rls_and_grants.sql` (רטרואקטיביות - מתעדות מצב שכבר קיים בייצור, ראו "תיעוד רטרואקטיבי" למטה).
2. להריץ את `views.sql`.
3. להוסיף ב-Secrets של הריפו בגיטהאב: `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `MECHALOL_API_URL`.
4. לוודא ב-`config.py` שכתובת ה-API של המכלול וכתובות הקטגוריות מדויקות (הוגדרו לפי ההנחות מהשיחה, כדאי לאמת מול השרת בפועל).
5. לארכיטקטורת המראה (סעיף נפרד למטה): להריץ בנוסף, בסדר הזה, את `migration_add_mirror_tables.sql` → `migration_add_forward_fill_function.sql` → `migration_add_swap_function.sql`.

## תיעוד רטרואקטיבי (2026-09)
כמה אלמנטים היו קיימים בייצור בפועל אך מעולם לא תועדו בשום קובץ בריפו - נוצרו ישירות בעורך ה-SQL של סופרבייס בשלב מסוים, בלי מיגרציה מלווה. התגלו ותועדו תוך כדי בניית ארכיטקטורת המראה למטה (כי היה צריך לשחזר את אותו מצב בדיוק על טבלאות המראה):
- העמודות `wikipedia_pages.created_at_checked`/`easy_import_checked` (ראו `migration_add_checked_columns.sql`).
- הפונקציה `recompute_missing_flag_scoped` (כבר תועדה בעבר ב-`schema.sql`, ראו הערה שם).
- RLS+GRANT על `wikipedia_pages`/`mechalol_pages`, ו-REVOKE מפורש מ-`anon`/`authenticated` על ארבע הפונקציות ה"כותבות" (`truncate_wikipedia_pages`, `truncate_mechalol_pages`, `recompute_missing_flag`, `recompute_missing_flag_scoped`) וארבעת ה-views ב-`views.sql` (ראו `migration_document_rls_and_grants.sql`).

שלוש הקבצים האלה אינם משנים שום התנהגות בייצור - כולם `if not exists`/`create or replace`/idempotent, ומתעדים מצב שכבר קיים. מומלץ להריץ אותם על כל סביבה חדשה בכל זאת, כדי שהתקנה טרייה תגיע לאותו מצב בדיוק כמו הייצור.

## ארכיטקטורת המראה עם החלפה אטומית (2026-09)
`biweekly_full_reconciliation.yml` עבר מ"ריקון+מילוי-מלא ישיר על הטבלאות הפעילות" (שהשאיר את הגאדג'ט בלי דוחות מהימנים לאורך כל משך הריצה) לארכיטקטורת מראה: הריקון-ומילוי-מחדש קורה על `wikipedia_pages_shadow`/`mechalol_pages_shadow` (משתנה הסביבה `TARGET_TABLE_SUFFIX=_shadow`), בעוד הטבלאות הפעילות ממשיכות לשרת כרגיל. בסוף הריצה, אחרי ששער אימות (`validate_before_swap.py`) מוודא שאין ירידה חשודה במספר השורות, `swap_shadow_to_active.py` מבצע החלפת-שמות אטומית (`perform_atomic_swap()` ב-Postgres) - שניות בודדות, לא תלוי בכמות השורות. הטבלה הפעילה הקודמת נשארת בתור `_previous` עד תחילת הסבב הבא (חלון rollback של עד שבועיים; ראו `revert_to_previous.py` לרולבק חירום ידני בתוך החלון). `table_names.py` הוא המודול המרכזי שמפרמט את שמות הטבלאות/RPC לפי `TARGET_TABLE_SUFFIX` בשלושת סקריפטי הליבה (`fetch_wikipedia.py`, `fetch_mechalol.py`, `match.py`) - כל שינוי עתידי בשמות טבלה עובר דרכו, לא מפוזר בקוד.

## ארכיטקטורה - ריקון ומילוי מחדש בכל ריצה
`wikipedia_pages` ו-`mechalol_pages` מתרוקנות (`TRUNCATE`) ומתמלאות מחדש **במלואן** בכל ריצה שבועית - לא עדכון הפרשי. `id` בשתי הטבלאות הוא ה-`page_id` האמיתי באתר המקור (לא `bigserial`), כך שהוא יציב וזהה בין ריצות, גם אחרי הריקון.

`wikipedia_pages.is_missing` (בוליאני) מסמן דף שקיים בוויקיפדיה ואין לו שום שורה תואמת ב-`mechalol_pages` - זהו המקור ל-`report_missing_from_mechalol`. **לא מחושב חי** - `fetch_wikipedia.py` ממלא אותו ל-`false` (ברירת מחדל) בכל `INSERT`, ורק בסוף `match.py` (אחרי שכל ההתאמות של אותה ריצה כבר נקבעו) הוא מחושב מחדש בבת אחת דרך `recompute_missing_flag()`. המשמעות: **באמצע הריצה השבועית** (מרגע שה-`TRUNCATE` רץ ועד לסיום `match.py`, כ-30-40 דק') הדוח עשוי להראות זמנית פחות שורות משתמצה במציאות, עד שהחישוב מחדש רץ. הוחלף ב-2026-08 מהצטרפות (`JOIN`) חיה בין שתי הטבלאות ב-`report_missing_from_mechalol`, שלקחה כ-3.7 שניות וחרגה מ-`statement_timeout` של תפקיד ה-`anon` בסופרבייס - ראו `migration_add_is_missing_flag.sql`.

שתי טבלאות **לא** מתרוקנות, ודורשות תחזוקה ידנית שלך בלבד:
- **`manual_matches`** - התאמות שהאוטומציה לא יכולה לפתור לבד (למשל כותרת שונה + דף נעול-לקריאה). מפתח: `mechalol_page_id`/`wikipedia_page_id`.
- **`blacklist_titles`** - כותרות שבכוונה לא יובאו למכלול, לא יופיעו כ"חסרות" ב-`report_missing_from_mechalol`.

## הרצה
- הרצה ראשונית: `workflow_dispatch` על `initial_run.yml`. אם נעצר באמצע (מגבלת זמן), פשוט להריץ שוב - ההתקדמות נשמרת (ובמצב הזה, הריקון **לא** חוזר על עצמו, כדי לא לאבד את מה שכבר נטען). תומך גם ב-`mode=mechalol_only` למילוי חוזר של טבלה אחת בלבד, בלי לגעת בשנייה.
- עדכון שוטף (יומי): `nightly_delta.yml`, רץ אוטומטית כל לילה ב-02:00 UTC. לא מרוקן כלום - קורא `recentchanges`/`logevents` משני האתרים (יצירות/מחיקות/שינויי-שם/עריכות) ומעדכן רק את מה שהשתנה, דרך `fetch_wikipedia_delta.py` → `fetch_mechalol_delta.py` → `match.py --scoped`.
- רשת ביטחון (דו-שבועית): `biweekly_full_reconciliation.yml`, רץ אוטומטית ב-1 וב-15 לכל חודש, 03:00 UTC. תופס פערים שהעדכון המצטבר היומי לא רואה במכוון (בעיקר שינוי סטטוס הפניה↔ערך בלי אירוע נלווה). **מ-2026-09 רץ על ארכיטקטורת מראה עם החלפה אטומית** (ראו סעיף נפרד למטה) - הטבלאות הפעילות ממשיכות לשרת בקשות לאורך כל הריצה, לא "ריקון+מילוי-מלא" ישיר על הטבלאות החיות כמו קודם. סדר השלבים קריטי (מאותה סיבה בדיוק כמו על הטבלאות הפעילות): `fetch_wikipedia.py` (מבצע את הריקון/קידום-המראה, ואז ממלא) → `fetch_mechalol.py` → `forward_fill_enrichment.py` → `validate_before_swap.py` (שער אימות - עוצר אם יש ירידה חשודה במספר השורות) → `match.py` (מתאים כותרות **וגם** מחשב מחדש את `is_missing` על המראה בסופו) → `swap_shadow_to_active.py` (רק אם שער האימות אישר).
- העשרת "חסר במכלול": `enrichment_after_reconciliation.yml`, מופעל אוטומטית (טריגר `workflow_run`) מיד אחרי שריצת הסנכרון הדו-שבועי מסתיימת בהצלחה. ארבע עבודות מקבילות ובלתי-תלויות (לא ברצף - `fetch_wikipedia_created_at.py` לבדו יכול לקחת עד כמה שעות): תיאורי ויקינתונים, קלות ייבוא, תאריכי יצירה, הפניות במכלול.
- `weekly_update.yml` - **מושבת** (Disabled בטאב Actions). הוחלף במלואו על ידי שני ה-workflows האוטומטיים למעלה; נשאר בריפו כרפרנס/רשת ביטחון להפעלה ידנית, לא רץ מעצמו.
- `check_missing_locked.yml` - רץ אוטומטית פעם בחודש (1 לחודש, 04:00 UTC), בודק כותרות חסומות ליצירה במכלול.


