-- Requires 20261006205515_old_dashboard_task_validity.sql.
-- Isolated maintenance journal; existing mainspace delta logs and their consumers are untouched.
-- namespace 118 is Draft on Hebrew Wikipedia. Targets use the stored namespace, not a title prefix.
create table if not exists public.maintenance_wikipedia_events (
    id bigserial primary key,
    kind text not null check (kind in ('move','delete','restore')),
    page_id bigint not null,
    title text not null,
    namespace integer not null,
    target_title text not null default '',
    target_namespace integer,
    event_at timestamptz not null,
    fetched_at timestamptz not null default now(),
    unique (kind, title, target_title, event_at),
    check (kind <> 'move' or (target_title <> '' and target_namespace is not null))
);
create index if not exists maintenance_wiki_events_page_time_idx
    on public.maintenance_wikipedia_events(page_id, event_at desc, id desc);
create index if not exists maintenance_wiki_events_lifecycle_idx
    on public.maintenance_wikipedia_events(kind, title, event_at) where kind in ('delete','restore');
alter table public.maintenance_wikipedia_events enable row level security;
revoke all on public.maintenance_wikipedia_events from public, anon, authenticated;
grant select on public.maintenance_wikipedia_events to anon, authenticated;
grant select, insert, update, delete on public.maintenance_wikipedia_events to service_role;
grant usage, select on sequence public.maintenance_wikipedia_events_id_seq to service_role;
do $$ begin
    if not exists(select from pg_policies where schemaname='public' and tablename='maintenance_wikipedia_events' and policyname='Public read') then
        create policy "Public read" on public.maintenance_wikipedia_events for select to anon, authenticated using (true);
    end if;
end $$;
-- Existing rename rows are mainspace-only. Seed them so existing tasks survive deployment.
insert into public.maintenance_wikipedia_events(kind,page_id,title,namespace,target_title,target_namespace,event_at)
select 'move',page_id,old_title,0,new_title,0,renamed_at from public.wikipedia_renames
where action in ('move','move_redir')
on conflict(kind,title,target_title,event_at) do nothing;

create or replace view public.report_wikipedia_move_candidates with (security_invoker=true) as
with last_move as (
    select distinct on (r.page_id, r.title) r.page_id, r.title as old_title, r.event_at as renamed_at
    from public.maintenance_wikipedia_events r
    where r.kind = 'move' and r.page_id > 0
    order by r.page_id, r.title, r.event_at desc
),
latest_move as (
    select distinct on (r.page_id) r.page_id, r.target_title as new_title, r.target_namespace, r.event_at as renamed_at
    from public.maintenance_wikipedia_events r where r.kind = 'move' and r.page_id > 0
    order by r.page_id, r.event_at desc, r.id desc
),
current_source as (
    select lm.page_id, coalesce(w.title, lm.new_title) as title
    from latest_move lm
    left join public.wikipedia_pages w on w.id = lm.page_id
    where w.id is not null
       or (lm.target_namespace = 118 and not exists (
            select from public.maintenance_wikipedia_events d
            where d.kind = 'delete' and d.namespace = 118 and d.title = lm.new_title
              and d.event_at >= lm.renamed_at
              and not exists (
                  select from public.maintenance_wikipedia_events c
                  where c.kind = 'restore' and c.namespace = 118 and c.page_id = lm.page_id and c.title = lm.new_title
                    and c.event_at > d.event_at
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
