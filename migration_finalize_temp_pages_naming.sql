-- מיגרציה חד-פעמית: מחליפה את כל השימוש ב"shadow"/"previous" בשכבת
-- ההחלפה האטומית ל-"temp" (ראו README.md לדיון המלא בסיבה). שני
-- שינויים מהותיים, לא רק קוסמטיים:
--
-- 1. אין יותר חלון rollback/"previous" נפרד. perform_atomic_swap
--    מבצעת שלוש החלפות שם לכל טבלה (לא שתיים) - הטבלה הפעילה הקודמת
--    חוזרת מיד להיות "_temp" הקבועה, מוכנה ל-log_reconciliation_diff
--    ואז ל-truncate_temp_pages() (חדשה, מחליפה את
--    promote_previous_to_shadow_and_truncate שנמחקת). revert_atomic_
--    swap נמחקת גם - אין יותר _previous לחזור אליה.
--
-- 2. שם כל אינדקס/אילוץ על שתי הטבלאות תמיד ישקף את התפקיד הנוכחי
--    שלו בפועל, ולא יישאר שריד קבוע מדור swap קודם (זו הייתה בדיוק
--    הבעיה עם שמות "_shadow" שנתקעו לצמיתות על טבלה פעילה - בלבל
--    בפאנל ה-Large Objects של סופרבייס יותר מפעם אחת). perform_
--    atomic_swap המעודכנת עושה את זה אוטומטית מעכשיו והלאה, בכל swap.
--
-- ההנחה: הרצת migration_add_mirror_tables.sql קודם (יוצרת/_shadow),
-- ושאין עדיין הרצת migration_finalize_temp_pages_naming.sql קודמת.
-- הבלוק הבא מטפל בשני מצבי-פתיחה אפשריים: (א) התקנה קיימת עם היסטוריה
-- של סבבים - יש טבלת _previous עם שמות אינדקס ישנים/לא-אחידים (יכולים
-- להצטבר לאורך זמן, כולל כפילויות אמיתיות שלא נוגעים בהן כאן - ראו
-- הערה בסוף); (ב) התקנה טרייה - יש רק _shadow (מ-migration_add_mirror_
-- tables.sql, אף פעם לא הוחלפה), אין עדיין _previous בכלל.

do $$
begin
    if exists (select 1 from pg_tables where schemaname='public' and tablename='wikipedia_pages_previous') then
        -- מצב (א): יש היסטוריה. שמות האינדקסים/אילוצים על _previous
        -- תלויים בהיסטוריה המצטברת של ההתקנה הספציפית - אין דרך
        -- גנרית לנחש אותם. הבלוק הזה מניח את השמות שהיו בפועל בהתקנה
        -- שממנה נכתבה המיגרציה הזו (ספטמבר 2026) - אם ההתקנה שלך
        -- הצטברה אחרת, הרץ קודם שאילתת אבחון (select tablename,
        -- indexname from pg_indexes where tablename in
        -- ('wikipedia_pages_previous','mechalol_pages_previous')) והתאם
        -- ידנית.
        if exists (select 1 from pg_indexes where schemaname='public' and indexname='wikipedia_pages_pkey' and tablename='wikipedia_pages_previous') then
            alter index wikipedia_pages_pkey rename to wikipedia_pages_temp_pkey;
            alter index wikipedia_pages_title_key rename to wikipedia_pages_temp_title_key;
            alter index idx_wikipedia_pages_title rename to wikipedia_pages_temp_title_idx;
            alter index idx_wikipedia_norm_person_title rename to wikipedia_pages_temp_normalize_person_title_idx;
            alter index idx_wikipedia_is_missing rename to wikipedia_pages_temp_is_missing_idx;

            alter index mechalol_pages_pkey rename to mechalol_pages_temp_pkey;
            alter index mechalol_pages_title_key rename to mechalol_pages_temp_title_key;
            alter table mechalol_pages_previous rename constraint mechalol_pages_wikipedia_id_fkey to mechalol_pages_temp_wikipedia_id_fkey;
            alter table mechalol_pages_previous rename constraint mechalol_pages_match_type_check to mechalol_pages_temp_match_type_check;
            alter table mechalol_pages_previous rename constraint mechalol_pages_status_check to mechalol_pages_temp_status_check;
            -- שני אינדקסי wikipedia_id כפולים ישנים על הטבלה הזו (אותה
            -- כפילות שכבר תוקנה על הטבלה הפעילה קודם) - משנה שם
            -- לשניהם בכוונה, לא מוחק. עדיין כפילות אמיתית, לא טופלה.
            alter index idx_mechalol_wikipedia_id rename to mechalol_pages_temp_wikipedia_id_idx;
            alter index idx_mechalol_pages_wikipedia_id rename to mechalol_pages_temp_wikipedia_id_idx_dup;
            alter index idx_mechalol_status rename to mechalol_pages_temp_status_idx;
            alter index idx_mechalol_match_type rename to mechalol_pages_temp_match_type_idx;
            alter index idx_mechalol_norm_person_title rename to mechalol_pages_temp_normalize_person_title_idx;
        end if;

        alter table wikipedia_pages_previous rename to wikipedia_pages_temp;
        alter table mechalol_pages_previous rename to mechalol_pages_temp;
    else
        -- מצב (ב): התקנה טרייה - רק _shadow קיימת (מ-migration_add_
        -- mirror_tables.sql), נבנתה עם LIKE...INCLUDING ALL אז שמות
        -- האינדקסים/אילוצים כבר עקביים (wikipedia_pages_shadow_pkey
        -- וכו') - רק צריך rename ישיר לטבלה + הסרת "_shadow" משמות
        -- האינדקסים שעליה, בלי כל שלב הביניים למעלה.
        alter index wikipedia_pages_shadow_pkey rename to wikipedia_pages_temp_pkey;
        alter index wikipedia_pages_shadow_title_key rename to wikipedia_pages_temp_title_key;
        alter table mechalol_pages_shadow rename constraint mechalol_pages_shadow_wikipedia_id_fkey to mechalol_pages_temp_wikipedia_id_fkey;
        alter index mechalol_pages_shadow_pkey rename to mechalol_pages_temp_pkey;
        alter index mechalol_pages_shadow_title_key rename to mechalol_pages_temp_title_key;

        alter table wikipedia_pages_shadow rename to wikipedia_pages_temp;
        alter table mechalol_pages_shadow rename to mechalol_pages_temp;
    end if;
end;
$$;

-- הסרת "_shadow" משמות האינדקסים/אילוצים על הטבלאות הפעילות עצמן -
-- הן פעילות בפועל, לא צל/זמני; השם הישן הוא שריד היסטורי מדור קודם.
-- (אם ההתקנה טרייה ואף פעם לא עבר בה swap, לטבלאות הפעילות עדיין יש
-- את השם הבסיסי הנקי מ-schema.sql, ובלוק הזה לא ימצא מה לשנות - בסדר.)
do $$
begin
    if exists (select 1 from pg_indexes where schemaname='public' and indexname='wikipedia_pages_shadow_pkey' and tablename='wikipedia_pages') then
        alter index wikipedia_pages_shadow_pkey rename to wikipedia_pages_pkey;
        alter index wikipedia_pages_shadow_title_key rename to wikipedia_pages_title_key;
        alter index wikipedia_pages_shadow_is_missing_idx rename to wikipedia_pages_is_missing_idx;
    end if;
    if exists (select 1 from pg_indexes where schemaname='public' and indexname='mechalol_pages_shadow_pkey' and tablename='mechalol_pages') then
        alter index mechalol_pages_shadow_pkey rename to mechalol_pages_pkey;
        alter index mechalol_pages_shadow_title_key rename to mechalol_pages_title_key;
        alter table mechalol_pages rename constraint mechalol_pages_shadow_wikipedia_id_fkey to mechalol_pages_wikipedia_id_fkey;
        alter index mechalol_pages_shadow_normalize_person_title_idx rename to mechalol_pages_normalize_person_title_idx;
        alter index mechalol_pages_shadow_status_idx rename to mechalol_pages_status_idx;
        alter index mechalol_pages_shadow_wikipedia_id_idx1 rename to mechalol_pages_wikipedia_id_idx;
    end if;
end;
$$;

-- שינוי שם פונקציות + עדכון גוף (מחליף רפרנס פנימי ל-_shadow ב-_temp)
alter function recompute_missing_flag_shadow() rename to recompute_missing_flag_temp;
alter function forward_fill_enrichment_shadow() rename to forward_fill_enrichment_temp;

create or replace function recompute_missing_flag_temp()
returns void
language sql
set search_path to 'public'
as $$
    update wikipedia_pages_temp w
    set is_missing = not exists (
            select 1 from mechalol_pages_temp m
            where m.wikipedia_id = w.id
               or m.title = w.title
               or normalize_person_title(m.title) = normalize_person_title(w.title)
        ),
        missing_override_reason = case
            when exists (select 1 from mechalol_pages_temp m where m.wikipedia_id = w.id or m.title = w.title)
                then null
            when exists (select 1 from mechalol_pages_temp m where normalize_person_title(m.title) = normalize_person_title(w.title))
                then 'rav_prefix_normalization'
            else null
        end
    where w.is_missing is distinct from not exists (
            select 1 from mechalol_pages_temp m
            where m.wikipedia_id = w.id
               or m.title = w.title
               or normalize_person_title(m.title) = normalize_person_title(w.title)
        )
       or w.missing_override_reason is distinct from case
            when exists (select 1 from mechalol_pages_temp m where m.wikipedia_id = w.id or m.title = w.title)
                then null
            when exists (select 1 from mechalol_pages_temp m where normalize_person_title(m.title) = normalize_person_title(w.title))
                then 'rav_prefix_normalization'
            else null
        end;
$$;

create or replace function forward_fill_enrichment_temp()
returns void
language sql
set search_path to 'public'
as $$
    update wikipedia_pages_temp as new
    set wikidata_desc = old.wikidata_desc,
        created_at = old.created_at,
        created_at_checked = old.created_at_checked,
        easy_import_length = old.easy_import_length,
        easy_import_has_images = old.easy_import_has_images,
        problematic_words_clean = old.problematic_words_clean,
        easy_import_checked = old.easy_import_checked,
        mechalol_redirect_exists = old.mechalol_redirect_exists
    from wikipedia_pages as old
    where new.id = old.id;
$$;

-- מחליפה את promote_previous_to_shadow_and_truncate - אין יותר
-- rename כאן בכלל, רק TRUNCATE (הטבלאות הזמניות קבועות, לא נבנות
-- מחדש בכל סבב).
create or replace function truncate_temp_pages()
returns void
language sql
security definer
set search_path to 'public'
as $$
    truncate table mechalol_pages_temp, wikipedia_pages_temp;
$$;

revoke all on function truncate_temp_pages() from public;
grant execute on function truncate_temp_pages() to service_role;

drop function if exists promote_previous_to_shadow_and_truncate();
drop function if exists revert_atomic_swap();

-- perform_atomic_swap מחדש: שלוש החלפות שם לטבלה (לא שתיים - אין
-- יותר "_previous" נפרד), ובנוסף שינוי שם אוטומטי לכל אינדקס/אילוץ
-- על שתי הטבלאות, כדי שהשם תמיד ישקף את התפקיד הנוכחי. מבוצע בשתי
-- פאזות (שם-ביניים ייחודי, ואז יעד סופי) - לא ישירות ליעד, כי שני
-- הצדדים "מחליפים" שם ביניהם ורנוס ישיר מתנגש עם האובייקט שעדיין
-- יושב שם (נבדק ותוקן בפועל אחרי שגיאת שם-כפול אמיתית שנתפסה בבדיקה
-- על טבלאות זניחות, לא בייצור).
create or replace function perform_atomic_swap()
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
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
           pg_get_viewdef(dependent_view.oid) as view_definition
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
            select conname from pg_constraint where conrelid = tbl::regclass and conname like old_prefix || '%'
            union all
            select conname from pg_constraint where conrelid = (tbl||'_temp')::regclass
                and conname like new_prefix || '%' and conname not like old_prefix || '%'
        loop
            n := n + 1;
            insert into _swap_rename_plan values (n, '_swap_tmp_' || n, null, r.conname, null, true);
        end loop;

        for r in
            select i.tablename, i.indexname from pg_indexes i
            where i.schemaname = 'public' and i.tablename = tbl and i.indexname like old_prefix || '%'
              and not exists (select 1 from pg_constraint c where c.conrelid = tbl::regclass and c.conname = i.indexname)
            union all
            select i.tablename, i.indexname from pg_indexes i
            where i.schemaname = 'public' and i.tablename = tbl||'_temp'
              and i.indexname like new_prefix || '%' and i.indexname not like old_prefix || '%'
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

    for r in select view_name, view_definition from _view_defs_capture loop
        execute format('create or replace view %I as %s', r.view_name, r.view_definition);
    end loop;

    notify pgrst, 'reload schema';
    notify pgrst, 'reload config';
end;
$$;

-- log_reconciliation_diff: משווה מול _temp במקום _previous
create or replace function log_reconciliation_diff()
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
declare
    v_since timestamptz;
    v_audit_id bigint;
    v_mechalol_compared int;
    v_wikipedia_compared int;
    v_untracked int;
begin
    select max(run_at) into v_since from reconciliation_audit;

    create temporary table _mechalol_diff on commit drop as
    select cur.id as page_id, cur.title,
        array_remove(array[
            case when cur.match_type is distinct from prev.match_type then 'match_type' end,
            case when cur.wikipedia_id is distinct from prev.wikipedia_id then 'wikipedia_id' end
        ], null) as changed_columns
    from mechalol_pages cur
    join mechalol_pages_temp prev on prev.id = cur.id
    where not exists (select 1 from mechalol_creations c where c.page_id = cur.id and (v_since is null or c.fetched_at > v_since))
      and not exists (select 1 from mechalol_deletions d where d.page_id = cur.id and (v_since is null or d.fetched_at > v_since))
      and not exists (select 1 from mechalol_renames r where r.page_id = cur.id and (v_since is null or r.fetched_at > v_since))
      and not exists (select 1 from mechalol_status_update_log s where s.page_id = cur.id and (v_since is null or s.fetched_at > v_since))
      and not exists (select 1 from manual_matches mm where mm.mechalol_page_id = cur.id);

    select count(*) into v_mechalol_compared from _mechalol_diff;

    create temporary table _wikipedia_diff on commit drop as
    select cur.id as page_id, cur.title,
        array_remove(array[
            case when cur.is_missing is distinct from prev.is_missing then 'is_missing' end,
            case when cur.missing_override_reason is distinct from prev.missing_override_reason then 'missing_override_reason' end,
            case when cur.mechalol_redirect_exists is distinct from prev.mechalol_redirect_exists then 'mechalol_redirect_exists' end
        ], null) as changed_columns
    from wikipedia_pages cur
    join wikipedia_pages_temp prev on prev.id = cur.id
    where not exists (select 1 from wikipedia_creations c where c.page_id = cur.id and (v_since is null or c.fetched_at > v_since))
      and not exists (select 1 from wikipedia_deletions d where d.page_id = cur.id and (v_since is null or d.fetched_at > v_since))
      and not exists (select 1 from wikipedia_renames r where r.page_id = cur.id and (v_since is null or r.fetched_at > v_since))
      and not exists (select 1 from manual_matches mm where mm.wikipedia_page_id = cur.id);

    select count(*) into v_wikipedia_compared from _wikipedia_diff;

    select count(*) into v_untracked from (
        select page_id from _mechalol_diff where array_length(changed_columns, 1) > 0
        union all
        select page_id from _wikipedia_diff where array_length(changed_columns, 1) > 0
    ) x;

    insert into reconciliation_audit (since, rows_compared_mechalol, rows_compared_wikipedia, untracked_changes_found)
    values (v_since, v_mechalol_compared, v_wikipedia_compared, v_untracked)
    returning id into v_audit_id;

    insert into reconciliation_audit_details (audit_id, side, page_id, title, changed_columns)
    select v_audit_id, 'mechalol', page_id, title, changed_columns
    from _mechalol_diff where array_length(changed_columns, 1) > 0;

    insert into reconciliation_audit_details (audit_id, side, page_id, title, changed_columns)
    select v_audit_id, 'wikipedia', page_id, title, changed_columns
    from _wikipedia_diff where array_length(changed_columns, 1) > 0;
end;
$$;

-- analyze_pages_tables: מקבלת "_temp" במקום "_shadow"
create or replace function analyze_pages_tables(table_suffix text default ''::text)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
begin
    if table_suffix not in ('', '_temp') then
        raise exception 'table_suffix לא מוכר: %', table_suffix;
    end if;

    execute format('analyze %I', 'wikipedia_pages' || table_suffix);
    execute format('analyze %I', 'mechalol_pages' || table_suffix);
end;
$$;
