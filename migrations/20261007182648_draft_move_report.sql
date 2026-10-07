-- Requires 20261006205515_old_dashboard_task_validity.sql. Display-only draft targets.
-- The current mainspace mirror wins; otherwise use the latest move to draft,
-- unless a later deletion (also title-only logs) has not been restored.
-- fetch_wikipedia_delta now records all namespace moves and draft delete/restore logs.
create or replace view public.report_wikipedia_move_candidates with (security_invoker=true) as
with last_move as (
    select distinct on (r.page_id, r.old_title) r.page_id, r.old_title, r.renamed_at
    from wikipedia_renames r
    where r.action in ('move', 'move_redir') and r.page_id > 0
    order by r.page_id, r.old_title, r.renamed_at desc
),
latest_move as (
    select distinct on (r.page_id) r.page_id, r.new_title, r.renamed_at
    from public.wikipedia_renames r where r.page_id > 0
    order by r.page_id, r.renamed_at desc, r.id desc
),
current_source as (
    select lm.page_id, coalesce(w.title, lm.new_title) as title
    from latest_move lm
    left join public.wikipedia_pages w on w.id = lm.page_id
    where w.id is not null
       or (lm.new_title like 'טיוטה:%' and not exists (
            select from public.wikipedia_deletions d
            where d.title = lm.new_title
              and (d.page_id = lm.page_id or d.page_id = 0)
              and d.deleted_at >= lm.renamed_at
              and not exists (
                  select from public.wikipedia_creations c
                  where c.page_id = lm.page_id and c.title = lm.new_title
                    and c.created_at > d.deleted_at
              )
       ))
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
select
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
join current_source w on w.page_id = h.page_id
where m.title <> w.title
;

notify pgrst, 'reload schema';
