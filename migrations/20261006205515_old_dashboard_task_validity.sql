-- V1 only. Pending explicit production approval. No mirror links or history are modified.
-- Proof is limited to move candidates and bound to the observed Hamichlol revision.
-- No foreign key to swappable mirror tables.
create table if not exists public.maintenance_move_sources (
    mechalol_id bigint primary key,
    mechalol_rev_id bigint,
    source_rev_id bigint,
    source_wikipedia_id bigint,
    checked_at timestamptz not null default now(),
    check (source_wikipedia_id is null or
           (mechalol_rev_id is not null and source_rev_id is not null
            and mechalol_rev_id > 0 and source_rev_id > 1))
);
alter table public.maintenance_move_sources enable row level security;
revoke all on public.maintenance_move_sources from public, anon, authenticated;
grant select on public.maintenance_move_sources to anon, authenticated;
grant select, insert, update, delete on public.maintenance_move_sources to service_role;
do $$ begin
    if not exists (select from pg_policies where schemaname='public'
                   and tablename='maintenance_move_sources' and policyname='Public read') then
        create policy "Public read" on public.maintenance_move_sources
            for select to anon, authenticated using (true);
    end if;
end $$;

-- All title/template candidates, including previously disproven ones, are rechecked.
create or replace view public.report_wikipedia_move_candidates with (security_invoker=true) as
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
join wikipedia_pages w on w.id = h.page_id
where m.title <> w.title
;


revoke all on public.report_wikipedia_move_candidates from public, anon, authenticated;
grant select on public.report_wikipedia_move_candidates to anon, authenticated, service_role;

create or replace view public.report_wikipedia_moves with (security_invoker=true) as
select distinct on (h.id) h.id, h.title, h.wikipedia_title, h.old_title,
       h.renamed_at, h.via, h.status, h.wikipedia_id
from public.report_wikipedia_move_candidates h
join public.mechalol_pages m on m.id=h.id
where not exists (
    select from public.manual_matches mm
    where mm.mechalol_page_id=h.id and mm.wikipedia_page_id<>h.wikipedia_id
)
and not exists (
    select from public.maintenance_move_sources e
    where e.mechalol_id=h.id
      and e.mechalol_rev_id=m.rev_id
      and m.sort_template_parsed_rev=m.rev_id
      and e.source_rev_id=m.sort_template_rev
      and e.source_wikipedia_id<>h.wikipedia_id
)
order by h.id, (h.via='title') desc, h.renamed_at desc;
revoke all on public.report_wikipedia_moves from public, anon, authenticated;
grant select on public.report_wikipedia_moves to anon, authenticated, service_role;

-- A changed baseline invalidates the old finding; it does not certify the new one.
create or replace view public.report_rev_tasks with (security_invoker=true) as
select c.mechalol_id as id, m.title, m.status, c.rev_task,
       c.rev_id as sort_template_rev, m.sort_template_date, m.wikipedia_id,
       w.title as linked_title, c.rev_page_id, c.rev_page_title, c.checked_at
from public.rev_link_check c
join public.mechalol_pages m on m.id=c.mechalol_id
left join public.wikipedia_pages w on w.id=m.wikipedia_id
where c.rev_id is not distinct from m.sort_template_rev
  and not exists (select from public.manual_matches mm where mm.mechalol_page_id=c.mechalol_id);
revoke all on public.report_rev_tasks from public, anon, authenticated;
grant select on public.report_rev_tasks to anon, authenticated, service_role;
notify pgrst, 'reload schema';
