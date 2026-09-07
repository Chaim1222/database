-- migration_add_template_reference_problem.sql
--
-- שתי בקשות מהמשתמש (2026-09):
--
-- 1. report_possibly_deleted_source הסתיר ערכים מילוניים/ערכים-לפתיחה
--    (is_dictionary_entry/needs_attention) גם כשהם מסומנים בפועל
--    כ-maybe_deleted_from_wikipedia - אומת בבדיקת נתונים אמיתית: 40
--    שורות בדיוק במצב הזה, מוסתרות לגמרי מהדוח. הוסרו שני התנאים -
--    הדוח מציג עכשיו את כל מה שבאמת מסומן כחשוד-כמחיקה.
--
-- 2. match.py לא הבחין בין "אין תבנית מיון בכלל" ל"יש תבנית עם שם
--    מפורש, אבל השם לא נמצא בפועל ב-wikipedia_pages" - שני המצבים
--    הובילו לאותה תוצאה (match_type='ללא התאמה', בלי שום עדות
--    לכך שהייתה תבנית). match.py עודכן (ראו הקובץ המצורף בנפרד)
--    לשמור את השם הכושל בעמודה חדשה, template_referenced_title.
--    report_tasks_to_handle מוסיף עכשיו קטגוריית משימה שלישית על
--    בסיס העמודה הזו.
--
-- 3. אותו טעם, למקרה נפרד: כשה-API בכלל דוחה את הבקשה לתוכן הדף
--    (ACCESS_DENIED במקור - לרוב כי הדף נעול-לקריאה) לא נשמר שום
--    זכר לכך - השורה נשארת "ללא התאמה" סתמי בלי הבחנה מכל שורה
--    אחרת, גם אם זה קורה שוב ושוב. match.py עודכן לרשום חותמת זמן
--    בעמודה חדשה, template_check_access_denied_at, בכל פעם שזה קורה,
--    ולנקות אותה בכל פעם שהשורה כן נבדקת בהצלחה (בכל שלב, לא רק
--    בתבנית). מכיוון שדף נעול-לקריאה קשור ישירות לנעילת כותרות
--    (aspaklaryalockdown) - זו קטגוריית משימה רביעית ב-report_tasks_
--    to_handle: "דף נעול - לא ניתן לאמת".
--
-- שימו לב: קובץ זה בלבד לא משלים את סעיפים 2-3 - חייבים גם להריץ
-- בפועל את match.py המעודכן (שתי העמודות יישארו תמיד NULL בלי זה).

alter table mechalol_pages
    add column if not exists template_referenced_title text;

alter table mechalol_pages
    add column if not exists template_check_access_denied_at timestamptz;

comment on column mechalol_pages.template_referenced_title is
    'השם שתבנית המיון בגוף הערך מצהירה עליו כשם הערך המקביל בוויקיפדיה, כשהשם הזה לא נמצא בפועל ב-wikipedia_pages (תבנית שגויה/מיושנת, או שהערך בוויקיפדיה שונה שם/נמחק). NULL כשאין תבנית בכלל, או כשההתאמה כן הצליחה.';

comment on column mechalol_pages.template_check_access_denied_at is
    'חותמת הזמן של הפעם האחרונה שבדיקת תבנית המיון נדחתה על ידי ה-API (לרוב כי הדף נעול-לקריאה), ולכן לא בוצעה בכלל. NULL אם השורה נבדקה בהצלחה (בכל שלב) בריצה האחרונה שנגעה בה.';

create or replace view report_possibly_deleted_source as
select id, title, status, source_type, match_type
from mechalol_pages
where maybe_deleted_from_wikipedia = true
order by title;

create or replace view report_tasks_to_handle as
select id, title, status, source_type, wikipedia_id, match_type,
    case
        when maybe_deleted_from_wikipedia = true then 'לבדוק מחיקה/השוואה לוויקיפדיה'
        when status = 'מיובא ללא תיעוד' then 'סטטוס לא ברור'
        when template_referenced_title is not null then 'שם בתבנית לא אומת מול ויקיפדיה'
        when template_check_access_denied_at is not null then 'דף נעול - לא ניתן לאמת'
        else null
    end as task_type
from mechalol_pages
where needs_attention = false
  and is_dictionary_entry = false
  and (
    maybe_deleted_from_wikipedia = true
    or status = 'מיובא ללא תיעוד'
    or template_referenced_title is not null
    or template_check_access_denied_at is not null
  )
order by task_type, title;

revoke all on report_possibly_deleted_source from anon, authenticated;
revoke all on report_tasks_to_handle from anon, authenticated;
grant select on report_possibly_deleted_source to anon, authenticated;
grant select on report_tasks_to_handle to anon, authenticated;

notify pgrst, 'reload schema';
