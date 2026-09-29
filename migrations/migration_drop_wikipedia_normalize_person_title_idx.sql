-- migration_drop_wikipedia_normalize_person_title_idx.sql
--
-- מסיר את האינדקס על normalize_person_title(title) ב-wikipedia_pages (36 MB, ועוד 36 MB
-- בעותק הזמני בשיא ההחלפה השבועית) - חיסכון באחסון, המסד קרוב לגבול.
--
-- נבדק (2026-09-29):
--  * רק recompute_missing_flag_by_titles (הדלתא הלילית) משתמשת בו (1,962 סריקות). שלוש
--    הפונקציות האחרות נשענות על האינדקס של mechalol_pages.
--  * report_rav_prefix_normalization נשען על wikipedia_pages_rav_override_idx ועל האינדקס של
--    המכלול, לא על זה (EXPLAIN, ~0.6 שניות).
--  * perform_atomic_swap בונה את תוכנית שינוי השמות דינמית מ-pg_indexes לפי קידומת הטבלה,
--    ולכן היעדרו בשני העותקים לא שובר את ההחלפה.
-- המחיר: כ-8 שניות לצ'אנק של 500 כותרות בדלתא הלילית (עד דקה בלילה), בלי שינוי בתוצאות.
-- אם הצעד "התאמה ממוקדת" ב-nightly_delta.yml יתארך מדי: לעבור לחיפוש
-- title in (N, 'הרב '||N, 'רבי '||N) לפי title_key.
--
-- להריץ מחוץ לריצה שבועית/לילית (drop index לוקח נעילה קצרה). חייבת לרוץ אחרי
-- migration_review_fixes_2026_09.sql, שיוצר את האינדקס בהתקנה חדשה.
drop index if exists wikipedia_pages_normalize_person_title_idx;
drop index if exists wikipedia_pages_temp_normalize_person_title_idx;
