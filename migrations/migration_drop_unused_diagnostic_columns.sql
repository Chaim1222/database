-- מחיקת ארבע עמודות אבחון ב-mechalol_pages שנמצאו write-only: match.py
-- (ו-fetch_mechalol.py עבור last_update_month) כותבים אליהן בכל הרצה,
-- אבל אף view, פונקציית RPC, סקריפט אחר או הגאדג'ט לא קוראים אותן
-- בחזרה בשום מקום (אומת מול כל קובצי הריפו + כל pg_views/pg_proc
-- הקיימים בפועל). לא תרומה משמעותית לגודל המסד (העמודות ריקות ב-
-- 96.7%-99.997% מהשורות) - זו מיגרציית ניקיון סכימה, לא חלק מטיפול
-- במכסת האחסון.
--
-- קוד הכתיבה אליהן הוסר במקביל מ-match.py (5 מקומות) ומ-fetch_mechalol.py
-- (2 מקומות), ומ-schema.sql (הגדרת הטבלה העדכנית). מיגרציית היצירה
-- ההיסטורית (migration_manual_matches_and_cleanup_columns.sql) נשארת
-- כפי שהייתה - היא כבר רצה בעבר ומתעדת את המצב כפי שהיה אז.
--
-- מחיקה גם מ-mechalol_pages_previous (לא רק מהטבלה הפעילה): גילוי חשוב
-- - promote_previous_to_shadow_and_truncate לא בונה טבלת צל חדשה לפי
-- המבנה הנוכחי, אלא ממחזרת את mechalol_pages_previous הקיימת (rename
-- ואז truncate). בלי המחיקה כאן גם, ארבע העמודות היו "קמות לתחייה"
-- באופן שקט בסבב הפיוס המלא הבא, ברגע שהטבלה הזו מקודמת להיות ה-shadow
-- ואז מוחלפת עם הטבלה הפעילה.

alter table mechalol_pages
    drop column if exists normalization_match,
    drop column if exists normalization_method,
    drop column if exists title_normalized,
    drop column if exists last_update_month;

alter table mechalol_pages_previous
    drop column if exists normalization_match,
    drop column if exists normalization_method,
    drop column if exists title_normalized,
    drop column if exists last_update_month;
