-- מיגרציה חד-פעמית להרצה בעורך ה-SQL של סופרבייס, על הסביבה הקיימת.
-- מוסיפה ל-wikipedia_pages עמודת wikidata_desc - תיאור קצר מוויקינתונים,
-- נשלף ונשמר על ידי fetch_wikidata_descriptions.py (סקריפט עצמאי,
-- לא חלק מ-weekly_update.yml) עבור השורות שמופיעות בדוח
-- report_missing_from_mechalol בלבד.
--
-- nullable בכוונה, בלי ברירת מחדל - wikipedia_pages מתרוקנת (TRUNCATE)
-- ומתמלאת מחדש במלואה בכל ריצה שבועית (ראו schema.sql), כך שהעמודה
-- חוזרת ל-NULL אוטומטית עבור כל השורות מדי שבוע, ומתמלאת מחדש רק עבור
-- מי שעדיין מופיע כחסר במכלול באותה ריצה - אין סיכון לנתון "תקוע"
-- מריצה קודמת.

alter table wikipedia_pages
    add column if not exists wikidata_desc text;
