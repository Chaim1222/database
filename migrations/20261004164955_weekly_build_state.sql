-- Apply before deploying the workflow. Existing swap implementation is unchanged.
begin;

create table public.weekly_build_state (
    singleton boolean primary key default true check (singleton),
    build_id uuid not null unique,
    phase text not null check (phase in (
        'building', 'matched', 'ready', 'swapped', 'source_recomputed',
        'audited', 'cleaned', 'classified', 'complete')),
    -- Physical identities survive renames, even when all four row counts match.
    table_oids oid[] not null check (cardinality(table_oids) = 4),
    audit_id bigint references public.reconciliation_audit(id),
    delta_watermarks jsonb not null default '{}'::jsonb,
    started_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);
alter table public.weekly_build_state enable row level security;
revoke all on public.weekly_build_state from public, anon, authenticated;
grant select, insert, update on public.weekly_build_state to service_role;

create function public.begin_weekly_build(p_build_id uuid)
returns public.weekly_build_state
language plpgsql security invoker set search_path = '' as $$
declare
    s public.weekly_build_state;
    ids oid[] := array[
        'public.wikipedia_pages'::regclass::oid,
        'public.wikipedia_pages_temp'::regclass::oid,
        'public.mechalol_pages'::regclass::oid,
        'public.mechalol_pages_temp'::regclass::oid];
begin
    insert into public.weekly_build_state(build_id, phase, table_oids)
        values (p_build_id, 'building', ids) on conflict (singleton) do nothing;
    select * into strict s from public.weekly_build_state where singleton for update;
    if s.build_id = p_build_id then
        return s; -- Lost response: never reset the same build.
    end if;
    if s.phase not in ('building', 'matched', 'ready', 'complete') then
        raise exception 'Build % is %. Resume it before starting another build', s.build_id, s.phase;
    end if;
    ids := array[
        'public.wikipedia_pages'::regclass::oid,
        'public.wikipedia_pages_temp'::regclass::oid,
        'public.mechalol_pages'::regclass::oid,
        'public.mechalol_pages_temp'::regclass::oid];
    update public.weekly_build_state set
        build_id = p_build_id, phase = 'building', table_oids = ids,
        audit_id = null, delta_watermarks = '{}'::jsonb,
        started_at = now(), updated_at = now()
        where singleton returning * into s;
    return s;
end;
$$;

-- Every state transition, including swap/audit/cleanup, commits with its checkpoint.
-- Retrying the same step after an ambiguous network error cannot swap back or
-- create a second audit. The singleton lock also serializes duplicate RPC calls.
create function public.advance_weekly_build(p_build_id uuid, p_step text)
returns public.weekly_build_state
language plpgsql security invoker set search_path = '' as $$
declare
    s public.weekly_build_state;
    phases text[] := array['building', 'matched', 'ready', 'swapped',
        'source_recomputed', 'audited', 'cleaned', 'classified', 'complete'];
    current_step integer;
    next_step integer := array_position(phases, p_step);
    ids oid[];
    expected_ids oid[];
begin
    select * into strict s from public.weekly_build_state where singleton for update;
    if s.build_id is distinct from p_build_id then
        raise exception 'Stale build ID: %, current build: %', p_build_id, s.build_id;
    end if;
    current_step := array_position(phases, s.phase);
    -- Resolve names after acquiring the lock: another call may just have swapped.
    ids := array[
        'public.wikipedia_pages'::regclass::oid,
        'public.wikipedia_pages_temp'::regclass::oid,
        'public.mechalol_pages'::regclass::oid,
        'public.mechalol_pages_temp'::regclass::oid];
    expected_ids := case when current_step < 4 then s.table_oids else
        array[s.table_oids[2], s.table_oids[1], s.table_oids[4], s.table_oids[3]] end;
    if ids is distinct from expected_ids then
        raise exception 'Page table identities changed outside build %. Refusing recovery', p_build_id;
    end if;
    if next_step is null or next_step = 1 then
        raise exception 'Invalid build step: %', p_step;
    end if;
    if current_step >= next_step then
        return s;
    end if;
    if next_step <> current_step + 1 then
        raise exception 'Cannot advance build from % to %', s.phase, p_step;
    end if;
    if p_step = 'matched' then
        select coalesce(jsonb_object_agg(source, last_synced_ts), '{}'::jsonb)
            into s.delta_watermarks from public.sync_watermarks;
    elsif p_step = 'swapped' then
        perform public.perform_atomic_swap();
    elsif p_step = 'audited' then
        s.audit_id := public.log_reconciliation_diff();
        if s.audit_id is null then
            raise exception 'Audit did not return an ID; retaining old page tables';
        end if;
        -- log_reconciliation_diff_all is deliberately NOT here: it is measurement only, its duration on
        -- real data is unmeasured, and a statement timeout inside this call would block cleanup and
        -- every other writer. weekly_build.py runs it non-blocking before the 'cleaned' step.
    elsif p_step = 'cleaned' then
        if s.audit_id is null then
            raise exception 'Missing audit ID; refusing cleanup';
        end if;
        perform public.truncate_temp_pages();
    end if;
    update public.weekly_build_state set phase = p_step, audit_id = s.audit_id,
        delta_watermarks = s.delta_watermarks, updated_at = now()
        where singleton returning * into s;
    return s;
end;
$$;

revoke all on function public.begin_weekly_build(uuid) from public, anon, authenticated;
revoke all on function public.advance_weekly_build(uuid, text) from public, anon, authenticated;
grant execute on function public.begin_weekly_build(uuid) to service_role;
grant execute on function public.advance_weekly_build(uuid, text) to service_role;
notify pgrst, 'reload schema';
commit;
