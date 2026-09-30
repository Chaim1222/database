-- migration_add_locked_pages_report.sql (2026-09-30)
--
-- view אחד שמרכז את כל הדפים הנעולים שהמערכת יודעת עליהם, לטאב "נעולים" בדשבורד
-- (gadget/gadget-searchHelperDashboard.js, VIEWS.locked). שלושה מקורות:
--   1. נעול לקריאה - mechalol_pages עם template_check_access_denied_at: בדיקת תבנית
--      המיון נדחתה (accessdenied), לרוב כי הדף נעול-לקריאה (fetch_sort_templates.py).
--   2. נעול לקריאה - manual_matches שנוספו אוטומטית ע"י check_missing_locked.py (allevel=read).
--   3. נעול ליצירה - blacklist_titles שנוספו אוטומטית באותו סקריפט (allevel=create).
-- id ייחודי ויציב בין המקורות (לעימוד): מזהה דף מכלול כמו שהוא, ושתי הטבלאות האחרות בהיסט.
-- הערה: נעול-לקריאה מזוהה רק כשבדיקה כלשהי נדחתה עליו, ולכן זו לא בהכרח רשימה מלאה של כל
-- הנעולים במכלול.
--
-- security_invoker = true, כמו שאר ה-views: כפוף ל-RLS של הטבלאות (דורש policy קריאה ל-anon
-- על mechalol_pages, manual_matches, blacklist_titles, wikipedia_pages - כולן כבר קיימות).
-- להרצה חד-פעמית בעורך ה-SQL של סופבייס (לא הורץ עדיין).

create or replace view report_locked_pages with (security_invoker = true) as
select
    m.id                                   as id,
    m.title                                as title,
    'נעול לקריאה'                          as lock_level,
    'בדיקת תבנית המיון נדחתה'              as lock_source,
    m.wikipedia_id                         as wikipedia_id,
    m.id                                   as mechalol_id,
    m.template_check_access_denied_at      as detected_at
from mechalol_pages m
where m.template_check_access_denied_at is not null
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
