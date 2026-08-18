-- Views לבעיות לטיפול, ממוקדים בערכי תוכן במרחב הראשי בלבד.
-- אינם כוללים: needs_attention=true (דפים ריקים - כבר מכוסים בקטגוריית
-- "ערכים לפתיחה"), is_dictionary_entry=true (תקצירים מילוניים, לא ערכים
-- מלאים). להרצה חד-פעמית בעורך ה-SQL של סופרבייס.
--
-- הוסרו (היו תלויים בעמודות שנמחקו עם המעבר לריקון-ומילוי-מחדש):
-- report_confirmed_deleted_from_wikipedia (deleted_from_wikipedia),
-- report_title_changed_since_match (matched_title).

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
create or replace view report_missing_from_mechalol as
select w.id, w.title, w.checked_at
from wikipedia_pages w
left join mechalol_pages m on m.wikipedia_id = w.id
where m.id is null
  and not exists (
    select 1 from blacklist_titles b where b.title = w.title
  )
order by w.title;
