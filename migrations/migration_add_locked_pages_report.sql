-- migration_add_locked_pages_report.sql (2026-09-30)
--
-- view אחד שמרכז את כל הדפים הנעולים שהמערכת יודעת עליהם, לטאב "נעולים" בדשבורד
-- (gadget/gadget-searchHelperDashboard.js, VIEWS.locked). שלושה מקורות:
--   1. נעול לקריאה - mechalol_pages עם sort_template_denied_at (1,267 דפים, כולם בלי rev_id ובלי
--      source_state: טעינת תבנית המיון נדחתה ב-accessdenied, ראו SOURCE_TRACKING_NOTES.md) או עם
--      template_check_access_denied_at (match.py, 5 דפים, 3 מהם גם בקבוצה הראשונה).
--   2. נעול לקריאה - manual_matches שנוספו אוטומטית ע"י check_missing_locked.py (allevel=read).
--   3. נעול ליצירה - blacklist_titles שנוספו אוטומטית באותו סקריפט (allevel=create).
-- id ייחודי ויציב בין המקורות (לעימוד): מזהה דף מכלול כמו שהוא, ושתי הטבלאות האחרות בהיסט.
-- הערה: נעול-לקריאה מזוהה לפי דחיית קריאה בפועל (accessdenied), ולכן הרשימה מכסה את הדפים שנבדקו בטעינת
-- התבניות, לא בהכרח כל דף נעול במכלול.
--
-- security_invoker = true, כמו שאר ה-views: כפוף ל-RLS של הטבלאות (דורש policy קריאה ל-anon
-- על mechalol_pages, manual_matches, blacklist_titles, wikipedia_pages - כולן כבר קיימות).
-- להרצה חד-פעמית בעורך ה-SQL של סופבייס (לא הורץ עדיין).

create or replace view report_locked_pages with (security_invoker = true) as
select
    m.id                                   as id,
    m.title                                as title,
    'נעול לקריאה'                          as lock_level,
    'קריאת הדף נדחתה (accessdenied)'       as lock_source,
    m.wikipedia_id                         as wikipedia_id,
    m.id                                   as mechalol_id,
    coalesce(m.sort_template_denied_at, m.template_check_access_denied_at) as detected_at
from mechalol_pages m
where m.sort_template_denied_at is not null
   or m.template_check_access_denied_at is not null
union all
select
    2000000000000 + mm.id,
    coalesce(w.title, '(דף מכלול ' || mm.mechalol_page_id || ')'),
    'נעול לקריאה',
    'זוהה בבדיקת הכותרות החסרות (allevel=read)',
    mm.wikipedia_page_id,
    mm.mechalol_page_id,
    mm.added_at
from manual_matches mm
left join wikipedia_pages w on w.id = mm.wikipedia_page_id
where mm.reason like 'נעול לקריאה%'
union all
select
    1000000000000 + b.id,
    b.title,
    'נעול ליצירה',
    'זוהה בבדיקת הכותרות החסרות (allevel=create)',
    b.wikipedia_id,
    null::bigint,
    b.added_at
from blacklist_titles b
where b.reason like 'נעול ליצירה%';
