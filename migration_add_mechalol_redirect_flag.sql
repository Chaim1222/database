-- מיגרציה חד-פעמית להרצה בעורך ה-SQL של סופרבייס, על הסביבה הקיימת.
-- מוסיפה ל-wikipedia_pages עמודת mechalol_redirect_exists - true אם
-- קיימת הפניה (redirect) במכלול תחת כותרת זהה בדיוק לכותרת הדף
-- בוויקיפדיה. נשלפת ונשמרת ידנית על ידי check_missing_redirects.py
-- (סקריפט עצמאי, לא חלק מ-weekly_update.yml) עבור השורות שמופיעות
-- בדוח report_missing_from_mechalol בלבד.
--
-- nullable בכוונה, בלי ברירת מחדל - כמו wikidata_desc/easy_import
-- (migration_add_wikidata_desc.sql, migration_add_easy_import_columns.sql):
-- wikipedia_pages מתרוקנת (TRUNCATE) ומתמלאת מחדש במלואה בכל ריצה
-- שבועית (ראו schema.sql), כך שהעמודה חוזרת ל-NULL אוטומטית עבור כל
-- השורות מדי שבוע, ומתמלאת מחדש רק כשמריצים את הסקריפט הידני שוב.
-- NULL = טרם נבדק. false אמיתי (לא רק ברירת מחדל) יתקבל רק על כותרת
-- שנבדקה בפועל מול המכלול ואין לה שם הפניה.

alter table wikipedia_pages
    add column if not exists mechalol_redirect_exists boolean;
