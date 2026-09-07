-- מחיקת שני אינדקסים כפולים שהתגלו בייצור - כל אחד כפילות מלאה של אינדקס
-- אחר על אותה עמודה בדיוק. לא נוצרו ע"י הפרויקט הנוכחי (שינוי שם ל-temp) -
-- שרידים ותיקים ולא-מוסברים של המסד, שהתגלו כשהמסד תועד לראשונה במלואו
-- ב-schema.sql (ראו שם ההערה המקורית ליד idx_mechalol_wikipedia_id).
-- אומת מול כל קוד הריפו (פייתון+JS) שאף קובץ לא תלוי בשם או בקיום שלהם,
-- לפני המחיקה בפועל. הורץ ואומת live (2026-09) - חסך כ-49 מגה-בייט.

-- מכלול: idx_mechalol_pages_wikipedia_id (בשם mechalol_pages_wikipedia_id_idx_dup
-- אחרי שינוי שם ל-temp) - כפילות מלאה של idx_mechalol_wikipedia_id
-- (mechalol_pages_wikipedia_id_idx), שנוצר במפורש ב-
-- migration_manual_matches_and_cleanup_columns.sql. נשאר רק idx_mechalol_wikipedia_id.
drop index if exists mechalol_pages_wikipedia_id_idx_dup;

-- ויקיפדיה: idx_wikipedia_pages_title (wikipedia_pages_title_idx) - אינדקס רגיל
-- על title, כפול לאילוץ הייחודי wikipedia_pages_title_key שכבר מכסה את אותה
-- עמודה (אינדקס ייחודי משרת גם חיפוש שוויון/טווח, בלי צורך באינדקס רגיל נוסף).
-- wikipedia_pages_title_key נשאר בכוונה - הוא בשימוש פעיל בקוד (fetch_wikipedia.py
-- ואחרים בודקים את שמו בזיהוי שגיאת 23505 להתנגשות כותרת).
drop index if exists wikipedia_pages_title_idx;

analyze wikipedia_pages;
analyze mechalol_pages;
