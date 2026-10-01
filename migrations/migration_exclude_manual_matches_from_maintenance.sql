-- migration_exclude_manual_matches_from_maintenance.sql
--
-- שיוך ידני (manual_matches) = העורך כבר טיפל בערך, ולכן הוא יוצא מטאבי התחזוקה: משימות הגרסה,
-- "ללא תבנית מיון" ו"נעולים" (מקור 1 בלבד: דפי מכלול שקריאתם נדחתה). match.py כבר מנקה rev_task
-- לשורה עם שיוך ידני; כאן ה-views מסתירים גם את מה שעוד לא חושב מחדש.
--
-- "נעולים": מקור 2 (manual_matches שנוספו אוטומטית ע"י check_missing_locked.py עבור דפים נעולים
-- לקריאה, reason 'נעול לקריאה%') ומקור 3 (רשימה שחורה) נשארים: הם רשימת הנעולים עצמה, לא משימה.
-- ראו migration_add_locked_pages_report.sql. ללא שינוי בנפח; idempotent; לא בזמן ההחלפה השבועית.
-- (schema/views.sql לא מעודכן עד שהמיגרציה תורץ.)

create or replace view report_undocumented_import with (security_invoker = true) as
select id, title, source_type, wikipedia_id, match_type
from mechalol_pages
where status = 'מיובא ללא תיעוד'
  and needs_attention = false
  and is_dictionary_entry = false
  and not exists (select 1 from manual_matches mm where mm.mechalol_page_id = mechalol_pages.id)
order by title;

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
where (m.sort_template_denied_at is not null
   or m.template_check_access_denied_at is not null)
  and not exists (select 1 from manual_matches mm where mm.mechalol_page_id = m.id)
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

notify pgrst, 'reload schema';
