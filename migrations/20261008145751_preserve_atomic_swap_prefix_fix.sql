-- שומר את תיקון הייצור מ-2026-10-08. CREATE OR REPLACE שומר את הבעלות וההרשאות הקיימות.
-- LIKE מפרש _ כתו כלשהו: mechalol_pages_template_ref_idx זוהה בטעות כאינדקס זמני.
-- starts_with בודק תחילית מילולית. כל שלבי ההחלפה ושמירת מאפייני התצוגות נשמרים.

CREATE OR REPLACE FUNCTION public.perform_atomic_swap()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
    r record;
    old_prefix text;
    new_prefix text;
    tbl text;
    n int;
begin
    perform set_config('lock_timeout', '5s', true);
    create temporary table _view_defs_capture on commit drop as
    select distinct dependent_view.relname as view_name,
           pg_get_viewdef(dependent_view.oid) as view_definition,
           dependent_view.reloptions as view_options
    from pg_depend
    join pg_rewrite on pg_depend.objid = pg_rewrite.oid
    join pg_class as dependent_view on pg_rewrite.ev_class = dependent_view.oid
    join pg_class as source_table on pg_depend.refobjid = source_table.oid
    where source_table.relname in ('wikipedia_pages', 'mechalol_pages')
      and dependent_view.relkind = 'v';
    alter table wikipedia_pages rename to _swap_holding_wikipedia;
    alter table mechalol_pages rename to _swap_holding_mechalol;
    alter table wikipedia_pages_temp rename to wikipedia_pages;
    alter table mechalol_pages_temp rename to mechalol_pages;
    alter table _swap_holding_wikipedia rename to wikipedia_pages_temp;
    alter table _swap_holding_mechalol rename to mechalol_pages_temp;
    create temporary table _swap_rename_plan (
        seq int, holding_name text, final_name text, orig_name text,
        on_table text, is_constraint boolean
    ) on commit drop;
    foreach tbl in array array['wikipedia_pages', 'mechalol_pages']::text[]
    loop
        old_prefix := tbl || '_temp_';
        new_prefix := tbl || '_';
        n := (select coalesce(max(seq), 0) from _swap_rename_plan);
        for r in
            select conname from pg_constraint where conrelid = tbl::regclass and starts_with(conname, old_prefix)
            union all
            select conname from pg_constraint where conrelid = (tbl||'_temp')::regclass
                and starts_with(conname, new_prefix) and not starts_with(conname, old_prefix)
        loop
            n := n + 1;
            insert into _swap_rename_plan values (n, '_swap_tmp_' || n, null, r.conname, null, true);
        end loop;
        for r in
            select i.tablename, i.indexname from pg_indexes i
            where i.schemaname = 'public' and i.tablename = tbl and starts_with(i.indexname, old_prefix)
              and not exists (select 1 from pg_constraint c where c.conrelid = tbl::regclass and c.conname = i.indexname)
            union all
            select i.tablename, i.indexname from pg_indexes i
            where i.schemaname = 'public' and i.tablename = tbl||'_temp'
              and starts_with(i.indexname, new_prefix) and not starts_with(i.indexname, old_prefix)
              and not exists (select 1 from pg_constraint c where c.conrelid = (tbl||'_temp')::regclass and c.conname = i.indexname)
        loop
            n := n + 1;
            insert into _swap_rename_plan values (n, '_swap_tmp_' || n, null, r.indexname, r.tablename, false);
        end loop;
        update _swap_rename_plan p set on_table = c.conrelid::regclass::text
            from pg_constraint c where p.is_constraint and p.on_table is null and c.conname = p.orig_name;
        update _swap_rename_plan set final_name =
            case when on_table = tbl then new_prefix || substring(orig_name from length(old_prefix)+1)
                 else old_prefix || substring(orig_name from length(new_prefix)+1) end
            where final_name is null and (on_table = tbl or on_table = tbl || '_temp');
    end loop;
    for r in select * from _swap_rename_plan loop
        if r.is_constraint then
            execute format('alter table %I rename constraint %I to %I', r.on_table, r.orig_name, r.holding_name);
        else
            execute format('alter index %I rename to %I', r.orig_name, r.holding_name);
        end if;
    end loop;
    for r in select * from _swap_rename_plan loop
        if r.is_constraint then
            execute format('alter table %I rename constraint %I to %I', r.on_table, r.holding_name, r.final_name);
        else
            execute format('alter index %I rename to %I', r.holding_name, r.final_name);
        end if;
    end loop;
    for r in select view_name, view_definition, view_options from _view_defs_capture loop
        execute format(
            'create or replace view %I %s as %s',
            r.view_name,
            case when r.view_options is null then ''
                 else 'with (' || array_to_string(r.view_options, ', ') || ')' end,
            r.view_definition
        );
    end loop;
    notify pgrst, 'reload schema';
    notify pgrst, 'reload config';
end;
$function$;
