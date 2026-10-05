-- migration_add_page_lock_levels.sql
--
-- דפים "נעולים למחצה לקריאה" (allevel=read-semi, ~80 דפים רפואיים/רבייה) לא יופיעו בטאב "נעולים" (הכרעת חיים, 5.10):
-- רק נעול ליצירה ונעול לקריאה (read). במסד אין היום שום מידע על רמת הנעילה: ב-mechalol_pages יש רק "קריאת התבנית נדחתה".
--
-- page_lock_levels: רמת הנעילה האחרונה שנמדדה לכל דף מכלול (scripts/verify_locked_pages.py --apply, מ-prop=info&inprop=allevel).
--   * טבלה נפרדת בכוונה, בלי מפתח זר: mechalol_pages מוחלפת כל שבת, ועמודה חדשה בה הייתה מתאפסת (ראו
--     SOURCE_TRACKING_NOTES.md, "החלפת הטבלאות השבועית מחליפה שמות").
--   * דף בלי שורה כאן מוצג כמו קודם (לא נבדק); רק allevel='read-semi' מוסתר.
--   * נכתבת רק ע"י service_role. קריאה ל-anon/authenticated, כי report_locked_pages הוא security_invoker.
-- report_locked_pages: אותו view בדיוק (אותן עמודות, באותו סדר), עם תנאי נוסף בענף הראשון: לא נעול למחצה.
-- נפח: ~1,300 שורות. idempotent. לא בזמן ההחלפה השבועית.

create table if not exists page_lock_levels (
    mechalol_id bigint primary key,
    allevel     text not null,
    checked_at  timestamptz not null default now()
);

alter table page_lock_levels enable row level security;
do $$
begin
    if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'page_lock_levels'
                   and policyname = 'קריאה ציבורית') then
        create policy "קריאה ציבורית" on page_lock_levels for select to anon, authenticated using (true);
    end if;
end $$;
revoke all on page_lock_levels from anon, authenticated;
grant select on page_lock_levels to anon, authenticated;
grant select, insert, update, delete on page_lock_levels to service_role;

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
  and not exists (select 1 from page_lock_levels l where l.mechalol_id = m.id and l.allevel = 'read-semi')
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
