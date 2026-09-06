-- Views לבעיות לטיפול, ממוקדים בערכי תוכן במרחב הראשי בלבד.
-- אינם כוללים: needs_attention=true (דפים ריקים - כבר מכוסים בקטגוריית
-- "ערכים לפתיחה"), is_dictionary_entry=true (תקצירים מילוניים, לא ערכים
-- מלאים). להרצה חד-פעמית בעורך ה-SQL של סופרבייס.
--
-- הוסרו (היו תלויים בעמודות שנמחקו עם המעבר לריקון-ומילוי-מחדש):
-- report_confirmed_deleted_from_wikipedia (deleted_from_wikipedia),
-- report_title_changed_since_match (matched_title).
--
-- ידוע, לא תוקן (2026-09): Supabase security advisor מסמן את כל
-- ארבעת ה-views למטה כ-"Security Definer View" (ERROR) - הן רצות
-- בהרשאות היוצר (postgres) ולא בהרשאות השולח, כלומר לא כפופות ל-RLS
-- של הטבלאות שמתחתן. זה לא נגרם משום שינוי שלנו (זו התנהגות ברירת
-- המחדל ההיסטורית של views בפוסטגרס, לפני security_invoker ב-PG15+),
-- וזו הסיבה שהגבלת ה-GRANT למטה קריטית - RLS לא מגן על ה-views האלה
-- בכל מקרה. לתיקון: ALTER VIEW ... SET (security_invoker = true) על
-- כל אחד, לא בוצע כאן כי זה משנה התנהגות בפועל ודורש בדיקה נפרדת.

-- 1. חשוד כמחיקה/בעיית התאמה: מקור ודאי-ויקיפדי או לא-ידוע, בלי
--    התאמה לוויקיפדיה בריצה הנוכחית. עשוי לנבוע ממחיקה אמיתית, מכותרת
--    שונה + דף נעול-לקריאה (מועמד ל-manual_matches), מטעות הקלדה
--    בתבנית המיון, או מכותרת שדורשת כלל נרמול חדש.
create or replace view report_possibly_deleted_source as
select id, title, status, source_type, match_type
from mechalol_pages
where maybe_deleted_from_wikipedia = true
  and needs_attention = false
  and is_dictionary_entry = false
order by title;

-- 2. מיובא ללא תיעוד: אין תבנית מיון תקינה (או שמעולם לא נבדק/לא
--    שויך לקטגוריה - אין הבדלה בין השניים כרגע, ראו fetch_mechalol.py).
create or replace view report_undocumented_import as
select id, title, source_type, wikipedia_id, match_type
from mechalol_pages
where status = 'מיובא ללא תיעוד'
  and needs_attention = false
  and is_dictionary_entry = false
order by title;

-- 3. משימות לטיפול - שני סוגים יחד, עם עמודת task_type להבחנה:
--    א. חשוד כמחיקה/דורש השוואה לוויקיפדיה (maybe_deleted_from_wikipedia).
--    ב. סטטוס לא ברור - מיובא ללא תיעוד (גם ודאי-חסר-תבנית וגם לא-ידוע,
--       שניהם יחד, בלי הבחנה ביניהם - כפי שנתבקש במפורש).
--    לא כולל דפי טיפול (needs_attention) ולא ערכים מילוניים
--    (is_dictionary_entry) - כפי שנתבקש במפורש.
create or replace view report_tasks_to_handle as
select
    id,
    title,
    status,
    source_type,
    wikipedia_id,
    match_type,
    case
        when maybe_deleted_from_wikipedia = true then 'לבדוק מחיקה/השוואה לוויקיפדיה'
        when status = 'מיובא ללא תיעוד' then 'סטטוס לא ברור'
    end as task_type
from mechalol_pages
where needs_attention = false
  and is_dictionary_entry = false
  and (maybe_deleted_from_wikipedia = true or status = 'מיובא ללא תיעוד')
order by task_type, title;

-- 4. קיים בוויקיפדיה, אין לו התאמה במכלול בכלל - מסונן מרשימה שחורה
--    (blacklist_titles: ערכים שבכוונה לא יובאו, אין טעם להציג אותם
--    כ"חסרים"). התאמה לפי כותרת מדויקת בלבד - כותרת שנוספה לרשימה
--    השחורה בכתיב שונה מהכתיב המדויק בוויקיפדיה לא תסונן.
-- מקור האמת: is_missing (מתוחזק ב-recompute_missing_flag/_scoped,
-- schema.sql) - לא JOIN חי כמו קודם. שינוי מדעת: join חי תמיד היה
-- מדויק ברגע השאילתה בלי תלות בשום דבר, אבל is_missing כולל גם כותרת
-- זהה ונירמול קידומת רבנית (לא רק wikipedia_id) - במחיר של פיגור עד
-- לריצה הלילית הבאה (ראו תיעוד is_missing ב-schema.sql). סדר העמודות
-- כאן חייב להישאר זהה אם מריצים על view קיים - Postgres לא מרשה
-- לשנות שם/סדר עמודות ב-CREATE OR REPLACE VIEW.
create or replace view report_missing_from_mechalol as
select w.id,
    w.title,
    w.checked_at,
    w.wikidata_desc,
    w.easy_import_length,
    w.easy_import_has_images,
    w.problematic_words_clean,
    w.created_at,
    w.mechalol_redirect_exists,
    w.easy_import_checked,
    w.created_at_checked
from wikipedia_pages w
where w.is_missing = true
  and not exists (
    select 1 from blacklist_titles b where b.title = w.title
  )
order by w.title;

-- --- הרשאות: קיימות בייצור, מעולם לא תועדו כאן עד 2026-09 ---
-- מלכוד שהתגלה בפועל: view חדש שנוצר עם create or replace view רגיל
-- (כמו שלושת הראשונים למעלה, כשהם נוצרו לראשונה) יורש את אותה ברירת
-- מחדל רחבה-מדי כמו טבלה חדשה (pg_default_acl) - קיבל בטעות INSERT/
-- UPDATE/DELETE/TRUNCATE ל-anon/authenticated, לא רק SELECT. אומת מול
-- המסד ותוקן ב-2026-09 (report_missing_from_mechalol למטה כבר היה
-- מוגבל נכון מלכתחילה, לא ברור למה רק הוא). ראו migration_document_
-- rls_and_grants.sql לתיעוד המלא כולל הטבלאות והפונקציות.
revoke all on report_possibly_deleted_source from anon, authenticated;
revoke all on report_tasks_to_handle from anon, authenticated;
revoke all on report_undocumented_import from anon, authenticated;
revoke all on report_missing_from_mechalol from anon, authenticated;

grant select on report_possibly_deleted_source to anon, authenticated;
grant select on report_tasks_to_handle to anon, authenticated;
grant select on report_undocumented_import to anon, authenticated;
grant select on report_missing_from_mechalol to anon, authenticated;
