-- migration_add_db_size_report.sql
--
-- db_size_report() - גודל המסד וגודל כל טבלה (טבלה + אינדקסים), לקריאה ע"י
-- scripts/log_db_size.py בשלבים קבועים של הריצה השבועית (לפני, שיא לפני ההחלפה,
-- אחרי הריקון). המטרה: למדוד את שיא הנפח בפועל - כרגע יש רק אומדן (README, "אחסון
-- בסופרבייס"). קריאה בלבד, בלי פרמטרים, בלי גישה לנתונים - רק גדלים.
--
-- security definer + search_path קבוע, כמו analyze_pages_tables. EXECUTE ל-service_role
-- בלבד: pg_default_acl בפרויקט מעניק EXECUTE ל-anon/authenticated (ראו הערה ב-schema.sql).
--
-- בטוח להריץ בכל עת (create or replace, לא נוגע בשום טבלה). scripts/log_db_size.py
-- לא נכשל אם הפונקציה עדיין לא קיימת.

create or replace function db_size_report()
returns table (item text, total_bytes bigint, table_bytes bigint, index_bytes bigint)
language sql
stable
security definer
set search_path = public
as $$
    select * from (
        select 'DATABASE'::text as item,
               pg_database_size(current_database())::bigint as total_bytes,
               null::bigint as table_bytes,
               null::bigint as index_bytes
        union all
        select c.relname::text,
               pg_total_relation_size(c.oid)::bigint,
               pg_table_size(c.oid)::bigint,
               pg_indexes_size(c.oid)::bigint
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r'
    ) t
    order by total_bytes desc;
$$;

revoke all on function db_size_report() from public, anon, authenticated;
grant execute on function db_size_report() to service_role;
