-- migration_add_rev_task.sql
--
-- התאמה לפי גרסה (scripts/rev_match.py): ההחלטה לכל ערך מתועד נשמרת בשורה עצמה, וארבעת טאבי
-- המשימות בדשבורד הם סינון לפי rev_task. מחליף את rev_link_check (ראו migration_drop_rev_link_check.sql).
--
--   rev_task        rename (העברת שם) / redirect (הפך להפניה) / bad_rev (גרסה שגויה או חסרה) /
--                   deleted_by_rev (נמחק לפי גרסה). NULL = תקין או מחוץ להיקף.
--   rev_page_id     הדף שהגרסה שייכת לו, ו-rev_page_title שמו הנוכחי (רק כשיש משימה; דף שאינו ב-
--                   wikipedia_pages, כמו הפניה או מרחב שם אחר, אין לו כותרת בשום מקום אחר).
--
-- העמודות מחושבות בכל ריצת match.py (שבועית על הטבלה הזמנית, ודלתא על הפעילה), ולכן אין צורך
-- ב-forward_fill. בלי מפתח זר (החלפת הטבלאות משנה שמות). אחסון: בערך 600 שורות עם ערך.
--
-- חייבת לרוץ לפני הקוד החדש של match.py (שכותב את העמודות רק אם הן קיימות, אבל compute_stale_ids
-- שואל עליהן) ולא בזמן הריצה השבועית (החלפת טבלאות). idempotent.

alter table mechalol_pages
    add column if not exists rev_task text,
    add column if not exists rev_page_id bigint,
    add column if not exists rev_page_title text;
alter table mechalol_pages_temp
    add column if not exists rev_task text,
    add column if not exists rev_page_id bigint,
    add column if not exists rev_page_title text;

alter table mechalol_pages drop constraint if exists mechalol_pages_rev_task_check;
alter table mechalol_pages
    add constraint mechalol_pages_rev_task_check
    check (rev_task in ('rename', 'redirect', 'bad_rev', 'deleted_by_rev'));
alter table mechalol_pages_temp drop constraint if exists mechalol_pages_temp_rev_task_check;
alter table mechalol_pages_temp
    add constraint mechalol_pages_temp_rev_task_check
    check (rev_task in ('rename', 'redirect', 'bad_rev', 'deleted_by_rev'));

-- שמות בתבנית ש-perform_atomic_swap משנה: mechalol_pages_<..> / mechalol_pages_temp_<..>
create index if not exists mechalol_pages_rev_task_idx
    on mechalol_pages (rev_task, id) where rev_task is not null;
create index if not exists mechalol_pages_temp_rev_task_idx
    on mechalol_pages_temp (rev_task, id) where rev_task is not null;

comment on column mechalol_pages.rev_task is
    'משימת גרסה: rename / redirect / bad_rev / deleted_by_rev. NULL = תקין או מחוץ להיקף. מחושב ב-match.py.';
comment on column mechalol_pages.rev_page_id is
    'הדף בוויקיפדיה שהגרסה (גרסה= בתבנית) שייכת לו. רק כשיש rev_task.';
comment on column mechalol_pages.rev_page_title is
    'שמו הנוכחי של דף הגרסה. רק כשיש rev_task.';

-- כתיבת תוצאות באצווה (scripts/backfill_rev_task.py). כל איבר: {id, rev_task, rev_page_id, rev_page_title}.
-- מעדכן רק את שלוש העמודות (בלי upsert: כתיבת שורה חלקית ל-mechalol_pages נכשלת על NOT NULL).
create or replace function set_rev_task_batch(p_rows jsonb)
returns integer
language plpgsql
security definer
set search_path to 'public'
as $$
declare
    n integer;
begin
    update mechalol_pages m
    set rev_task = r.rev_task,
        rev_page_id = r.rev_page_id,
        rev_page_title = r.rev_page_title
    from jsonb_to_recordset(p_rows) as r(id bigint, rev_task text, rev_page_id bigint, rev_page_title text)
    where m.id = r.id
      and (m.rev_task is distinct from r.rev_task
           or m.rev_page_id is distinct from r.rev_page_id
           or m.rev_page_title is distinct from r.rev_page_title);
    get diagnostics n = row_count;
    return n;
end;
$$;

revoke all on function set_rev_task_batch(jsonb) from public, anon, authenticated;
grant execute on function set_rev_task_batch(jsonb) to service_role;

-- הדוח לארבעת הטאבים (rev_task = rename / redirect / bad_rev / deleted_by_rev). linked_title = הערך
-- המקושר היום; rev_page_title = הדף שהגרסה שייכת לו.
create or replace view report_rev_tasks with (security_invoker = true) as
select m.id,
       m.title,
       m.status,
       m.rev_task,
       m.sort_template_rev,
       m.sort_template_date,
       m.wikipedia_id,
       w.title as linked_title,
       m.rev_page_id,
       m.rev_page_title
from mechalol_pages m
left join wikipedia_pages w on w.id = m.wikipedia_id
where m.rev_task is not null;

grant select on report_rev_tasks to anon, authenticated, service_role;

notify pgrst, 'reload schema';
