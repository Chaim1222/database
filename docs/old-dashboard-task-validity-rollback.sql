-- Restore only the two previous view definitions. Keep evidence and all original data.
-- Explicit production approval required. Disable the added workflow step when reverting code.
create or replace view report_wikipedia_moves with (security_invoker = true) as
with last_move as (
    select distinct on (r.page_id, r.old_title) r.page_id, r.old_title, r.renamed_at
    from wikipedia_renames r
    where r.action = 'move'
    order by r.page_id, r.old_title, r.renamed_at desc
),
tpl as (
    select m.id, m.template_referenced_title
    from mechalol_pages m
    where m.template_referenced_title is not null
      and m.status <> 'נשמר במכלול למרות מחיקה בוויקיפדיה'
),
hits as (
    select m.id, 'title'::text as via, lm.page_id, lm.old_title, lm.renamed_at
    from last_move lm
    join mechalol_pages m on m.title = lm.old_title
    union all
    select t.id, 'template', lm.page_id, lm.old_title, lm.renamed_at
    from last_move lm
    join tpl t on t.template_referenced_title = lm.old_title
)
select distinct on (h.id)
    h.id,
    m.title,
    w.title as wikipedia_title,
    h.old_title,
    h.renamed_at,
    h.via,
    m.status,
    h.page_id as wikipedia_id
from hits h
join mechalol_pages m on m.id = h.id
join wikipedia_pages w on w.id = h.page_id
where m.title <> w.title
order by h.id, (h.via = 'title') desc, h.renamed_at desc;

revoke all on report_wikipedia_moves from anon, authenticated;
grant select on report_wikipedia_moves to anon, authenticated, service_role;

notify pgrst, 'reload schema';

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
