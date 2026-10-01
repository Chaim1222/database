-- migration_rev_link_check_v2.sql
--
-- טבלת העבודה לבדיקת הגרסאות (scripts/rev_link_scan.py, פעם בחודש) והדוח של ארבעת הטאבים בדשבורד.
-- מחליפה את rev_link_check הראשונה (migration_add_rev_link_check.sql, צילום מצב חד-פעמי של 318 שורות
-- שנוצר ב-1.10): הסריקה הראשונה של הסקריפט החדש ממלאת אותה מחדש.
--
--   rev_task  rename (העברת שם) / redirect (הפכו להפניה) / bad_rev (גרסה שגויה) / deleted_by_rev (נמחקו)
--   כללי ההחלטה: scripts/rev_match.py. נשמרות רק שורות עם משימה (כמה מאות עד אלפים), בלי מפתח זר
--   (החלפת הטבלאות השבועית משנה שמות), והטבלה לא נוגעת בטבלאות הערכים ולא מושפעת מההחלפה.
--
-- report_rev_tasks: שיוך ידני (manual_matches) = טופל, ולכן מוסתר. rev_task ב-view כדי שהגאדג'ט יסנן לפיו.
-- הטבלה הישנה (עם עמודת status) לא נמחקת: שמה משתנה ל-rev_link_check_snapshot_20261001 (318 שורות, ~30KB),
-- למחיקה ידנית אחרי שהסריקה החדשה רצה. ללא שינוי בנפח משמעותי; לא בזמן ההחלפה השבועית. idempotent.

-- בלי DROP (הכלי שמריץ בייצור נתקע על פקודות הרס): הדוח והטבלה הישנים נשארים בשם חדש.
alter view if exists report_rev_link_mismatch rename to report_rev_link_mismatch_snapshot_20261001;

do $$
begin
    if exists (select 1 from information_schema.columns
               where table_schema = 'public' and table_name = 'rev_link_check' and column_name = 'status') then
        alter table rev_link_check rename to rev_link_check_snapshot_20261001;
    end if;
end $$;

create table if not exists rev_link_check (
    mechalol_id         bigint primary key,
    rev_task            text not null check (rev_task in ('rename', 'redirect', 'bad_rev', 'deleted_by_rev')),
    rev_id              bigint,
    linked_wikipedia_id bigint,
    rev_page_id         bigint,
    rev_page_title      text,
    checked_at          timestamptz not null default now()
);

create index if not exists rev_link_check_task_idx on rev_link_check (rev_task, mechalol_id);

alter table rev_link_check enable row level security;
do $$
begin
    if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'rev_link_check'
                   and policyname = 'קריאה ציבורית') then
        create policy "קריאה ציבורית" on rev_link_check for select to anon, authenticated using (true);
    end if;
end $$;

revoke all on rev_link_check from anon, authenticated;
grant select on rev_link_check to anon, authenticated;
grant select, insert, update, delete on rev_link_check to service_role;

create or replace view report_rev_tasks with (security_invoker = true) as
select c.mechalol_id as id,
       m.title,
       m.status,
       c.rev_task,
       c.rev_id as sort_template_rev,
       m.sort_template_date,
       m.wikipedia_id,
       w.title as linked_title,
       c.rev_page_id,
       c.rev_page_title,
       c.checked_at
from rev_link_check c
join mechalol_pages m on m.id = c.mechalol_id
left join wikipedia_pages w on w.id = m.wikipedia_id
where not exists (select 1 from manual_matches mm where mm.mechalol_page_id = c.mechalol_id);

revoke all on report_rev_tasks from anon, authenticated;
grant select on report_rev_tasks to anon, authenticated, service_role;

notify pgrst, 'reload schema';
