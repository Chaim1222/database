-- מיגרציה חד-פעמית להרצה בעורך ה-SQL של סופרבייס, על הסביבה הקיימת.
-- מוסיפה ל-wikipedia_pages שלוש עמודות "קלות ייבוא" - נשלפות ונשמרות
-- על ידי fetch_easy_import_candidates.py (סקריפט עצמאי, לא חלק
-- מ-weekly_update.yml) עבור השורות שמופיעות בדוח
-- report_missing_from_mechalol בלבד. מאפשרות לדשבורד לסנן "קטיף קל"
-- (למשל: עד 1000 בתים, ללא תמונות, נקי ממילים בעייתיות) לפי נתונים
-- שכבר מחושבים, בלי בדיקה חיה מול ה-API בכל בקשה.
--
-- nullable בכוונה, בלי ברירת מחדל - כמו wikidata_desc
-- (migration_add_wikidata_desc.sql): wikipedia_pages מתרוקנת (TRUNCATE)
-- ומתמלאת מחדש במלואה בכל ריצה שבועית (ראו schema.sql), כך שהעמודות
-- חוזרות ל-NULL אוטומטית עבור כל השורות מדי שבוע, ומתמלאות מחדש רק
-- עבור מי שעדיין מופיע כחסר במכלול באותה ריצה - אין סיכון לנתון
-- "תקוע" מריצה קודמת.
--
-- problematic_words_clean בוליאני יחיד (לא שני דגלים נפרדים) - הרשימה
-- המקורית כללה שני "בלוקים" מופרדים ויזואלית בלבד (תוכן מיני/מגדרי,
-- ואבולוציה/גיאולוגיה/פרשנות ביקורתית של המקרא), אך מטופלת כרשימה
-- מאוחדת אחת - ראו problematic_words.py.

alter table wikipedia_pages
    add column if not exists easy_import_length bigint;

alter table wikipedia_pages
    add column if not exists easy_import_has_images boolean;

alter table wikipedia_pages
    add column if not exists problematic_words_clean boolean;
