-- מוסיף סיווג אוטומטי "תזמון בלבד" מול "פער עיצוב אמיתי" לכל שורה
-- ב-reconciliation_audit_details, כדי שדוח log_reconciliation_diff לא
-- יציג מידע מטעה: שינוי שקרה פשוט אחרי ריצת הדלתא האחרונה (ויתפס
-- ממילא בריצה הבאה) אינו "פער" שהדלתא מפספסת מעצם עיצובה - ההבחנה
-- בין השניים לא ניתנת לקביעה מתוך המסד המקומי בלבד (נדרשת בדיקת
-- הגרסה האחרונה בפועל מול ה-API החי) - ראו log_reconciliation_diff.py
-- לחלק שמבצע את הבדיקה בפועל ומעדכן את העמודות האלה אחרי הקריאה
-- לפונקציה הזו.

alter table reconciliation_audit_details
    add column if not exists is_timing_only boolean not null default false,
    add column if not exists source_latest_edit_at timestamptz;

alter table reconciliation_audit
    add column if not exists untracked_changes_genuine integer;

-- log_reconciliation_diff() עצמה: אין שינוי בלוגיקה הפנימית, רק
-- returns bigint במקום returns void - כדי ש-log_reconciliation_diff.py
-- ידע בדיוק על איזה audit_id לבצע את סיווג התזמון, בלי לנחש
-- לפי max(id) (שבירה בתיאורטית לפחות תחת ריצות מקבילות).
-- CREATE OR REPLACE לא מאפשר לשנות סוג החזרה - נדרש DROP קודם.
drop function if exists log_reconciliation_diff();

create function log_reconciliation_diff()
returns bigint
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

    return v_audit_id;
end;
$$;

-- לא נדרש בדפוס migration_*.sql אחר בריפו הזה (DROP+CREATE במקום
-- ALTER בגלל שינוי סוג החזרה) - ראו הערה על pg_default_acl בפרויקט
-- הזה שמעניקה EXECUTE אוטומטית גם ל-anon/authenticated/PUBLIC, אותה
-- תקלה בדיוק כמו שתועדה בעבר בשש הפונקציות האחרות. ננעל בחזרה.
revoke execute on function log_reconciliation_diff() from public;
revoke execute on function log_reconciliation_diff() from anon;
revoke execute on function log_reconciliation_diff() from authenticated;
grant execute on function log_reconciliation_diff() to service_role;
grant execute on function log_reconciliation_diff() to postgres;

