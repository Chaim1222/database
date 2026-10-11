-- Durable deletion handoff: mirror DELETE + saved identity are one transaction.
-- Source-event journals cannot represent collision deletions or the old wikipedia_id.
-- Apply before deploying the updated match.py. No historical rows are repaired here.
begin;
create table public.mech_release_queue (
    id bigint generated always as identity primary key,
    mechalol_id bigint not null,
    title text not null,
    wikipedia_id bigint
);
alter table public.mech_release_queue enable row level security;
revoke all on public.mech_release_queue from public, anon, authenticated;
grant select, insert, update, delete on public.mech_release_queue to service_role;
revoke all on sequence public.mech_release_queue_id_seq from public, anon, authenticated;
grant usage, select on sequence public.mech_release_queue_id_seq to service_role;

create function public.capture_mechalol_release() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
    -- Both physical mirrors carry the trigger across the weekly name swap.
    -- Building/clearing the inactive mirror must never enqueue work.
    if TG_TABLE_SCHEMA = 'public' and TG_TABLE_NAME = 'mechalol_pages' then
        insert into public.mech_release_queue(mechalol_id,title,wikipedia_id)
        values(old.id,old.title,old.wikipedia_id);
    end if;
    return old;
end $$;
revoke all on function public.capture_mechalol_release() from public, anon, authenticated;
grant execute on function public.capture_mechalol_release() to service_role;
create trigger capture_mechalol_release after delete on public.mechalol_pages
for each row execute function public.capture_mechalol_release();
create trigger capture_mechalol_release after delete on public.mechalol_pages_temp
for each row execute function public.capture_mechalol_release();

create function public.recompute_released_mechalol_pages() returns integer
language plpgsql set search_path = '' as $$
declare ids bigint[]; wiki_ids bigint[]; titles text[];
begin
    select array_agg(q.id), array_remove(array_agg(q.wikipedia_id),null), array_agg(q.title)
    into ids,wiki_ids,titles
    from (select * from public.mech_release_queue order by id limit 500 for update skip locked) q;
    if ids is null then return 0; end if;
    if cardinality(wiki_ids)>0 then
        perform public.recompute_missing_flag_scoped(wiki_ids);
    end if;
    perform public.recompute_missing_flag_by_titles(titles);
    -- Failed recompute/timeout rolls back the whole batch, including its acknowledgement.
    delete from public.mech_release_queue where id=any(ids);
    return cardinality(ids);
end $$;
revoke all on function public.recompute_released_mechalol_pages() from public, anon, authenticated;
grant execute on function public.recompute_released_mechalol_pages() to service_role;
commit;
