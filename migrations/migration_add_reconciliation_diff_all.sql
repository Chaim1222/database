-- migration_add_reconciliation_diff_all.sql
--
-- מדידה מלאה של מה שהסנכרון השבועי משנה בפועל. תוספת בלבד: לא משנה ולא מוחקת שום דבר קיים
-- (log_reconciliation_diff ו-reconciliation_audit* נשארות כמות שהן), ולא נוגעת בטבלאות הערכים.
--
-- למה: log_reconciliation_diff משווה רק חמש עמודות קישור, ורק שורות שקיימות בשני הצילומים (בכוונה: README,
-- "תיעוד מדיד"). אבל השבועית בונה מחדש את כל הטבלאות, כלומר היא יודעת בדיוק מה הסטייה של כל המסד מול
-- המקורות. ההפרש בין הטבלה הפעילה הקודמת (שנשארת בטבלה הזמנית מיד אחרי ההחלפה) לחדשה הוא המדד האמיתי
-- לשאלה "מה הדלתא והעדכון השעתי מפספסים". הפונקציה הזו שומרת אותו לפי סוג שינוי, כדי שאפשר יהיה להחליט
-- על סמך נתונים אם השבועית נחוצה, באיזו תדירות, ובאיזו צורה.
--
-- סוגי שינוי (change_class):
--   שני הצדדים:   only_new (שורה חדשה שהדלתא לא הכניסה), only_old (שורה שנשארה אצלנו והמקור כבר לא מכיר),
--                title (שינוי שם)
--   מכלול:        status, source_type, needs_attention, is_dictionary_entry (נגזרים מקטגוריות),
--                wikipedia_id, match_type, maybe_deleted, template_referenced_title (נגזרים מההתאמה)
--   ויקיפדיה:     is_missing, missing_override_reason, mechalol_redirect_exists
-- לא נבדקות בכוונה עמודות שהעדכון השעתי או הזמן קובעים (rev_id, rev_ts, sort_template_*, source_state,
-- latest_rev_*, template_check_access_denied_at, checked_at): הן אינן "סטייה".
--
-- known_to_delta: האם טבלאות הדלתא (או שיוך ידני) כבר ידעו על השורה מאז הביקורת הקודמת. שינוי שאינו
-- known_to_delta הוא מה שהדלתא לא ראתה. עדיין ייתכן תזמון (שינוי בשעות שבין הדלתא האחרונה לטעינה);
-- הסיווג המדויק של תזמון נשאר ב-log_reconciliation_diff.py ולא כאן.
--
-- נקראת מ-scripts/log_reconciliation_diff.py (--record-only), אחרי ההחלפה ולפני ריקון הטבלאות הזמניות
-- (בשלב הזה mechalol_pages_temp/wikipedia_pages_temp מחזיקות את המצב הקודם). כשל בה לא עוצר את הריצה.
--
-- idempotent. נבדק מקומית ב-Postgres 16 (נתונים סינתטיים, כל סוגי השינוי). לא הורץ בייצור.

create table if not exists reconciliation_diff_summary (
    audit_id            bigint  not null references reconciliation_audit (id) on delete cascade,
    side                text    not null check (side in ('wikipedia', 'mechalol')),
    change_class        text    not null,
    n                   integer not null,
    n_known_to_delta    integer not null,
    primary key (audit_id, side, change_class)
);

create table if not exists reconciliation_diff_examples (
    id              bigint generated always as identity primary key,
    audit_id        bigint  not null references reconciliation_audit (id) on delete cascade,
    side            text    not null check (side in ('wikipedia', 'mechalol')),
    change_class    text    not null,
    page_id         bigint  not null,
    title           text,
    old_value       text,
    new_value       text,
    known_to_delta  boolean not null default false
);
create index if not exists reconciliation_diff_examples_audit_idx on reconciliation_diff_examples (audit_id, side, change_class);

alter table reconciliation_diff_summary enable row level security;
alter table reconciliation_diff_examples enable row level security;
revoke all on reconciliation_diff_summary, reconciliation_diff_examples from anon, authenticated;
grant select, insert on reconciliation_diff_summary, reconciliation_diff_examples to service_role;
grant usage, select on sequence reconciliation_diff_examples_id_seq to service_role;

create or replace function log_reconciliation_diff_all(p_audit_id bigint, p_examples_per_class integer default 200)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
declare
    v_since timestamptz;
begin
    select since into v_since from reconciliation_audit where id = p_audit_id;
    if not found then
        raise exception 'reconciliation_audit % לא קיימת', p_audit_id;
    end if;

    -- מה הדלתא (או שיוך ידני) כבר ידעה עליו מאז הביקורת הקודמת
    create temporary table _known_m on commit drop as
    select page_id from mechalol_creations where v_since is null or fetched_at > v_since
    union select page_id from mechalol_deletions where v_since is null or fetched_at > v_since
    union select page_id from mechalol_renames where v_since is null or fetched_at > v_since
    union select page_id from mechalol_status_update_log where v_since is null or fetched_at > v_since
    union select mechalol_page_id from manual_matches;
    create temporary table _known_w on commit drop as
    select page_id from wikipedia_creations where v_since is null or fetched_at > v_since
    union select page_id from wikipedia_deletions where v_since is null or fetched_at > v_since
    union select page_id from wikipedia_renames where v_since is null or fetched_at > v_since
    union select wikipedia_page_id from manual_matches;

    create temporary table _diff on commit drop as
    -- ---- מכלול: cur = הפעילה החדשה, prev = הזמנית (הפעילה הקודמת) ----
    select 'mechalol'::text as side, 'only_new'::text as change_class, cur.id as page_id, cur.title as title,
           null::text as old_value, cur.title as new_value
    from mechalol_pages cur where not exists (select 1 from mechalol_pages_temp p where p.id = cur.id)
    union all
    select 'mechalol', 'only_old', prev.id, prev.title, prev.title, null
    from mechalol_pages_temp prev where not exists (select 1 from mechalol_pages c where c.id = prev.id)
    union all
    select 'mechalol', 'title', cur.id, cur.title, prev.title, cur.title
    from mechalol_pages cur join mechalol_pages_temp prev using (id) where cur.title is distinct from prev.title
    union all
    select 'mechalol', 'status', cur.id, cur.title, prev.status, cur.status
    from mechalol_pages cur join mechalol_pages_temp prev using (id) where cur.status is distinct from prev.status
    union all
    select 'mechalol', 'source_type', cur.id, cur.title, prev.source_type, cur.source_type
    from mechalol_pages cur join mechalol_pages_temp prev using (id) where cur.source_type is distinct from prev.source_type
    union all
    select 'mechalol', 'needs_attention', cur.id, cur.title, prev.needs_attention::text, cur.needs_attention::text
    from mechalol_pages cur join mechalol_pages_temp prev using (id) where cur.needs_attention is distinct from prev.needs_attention
    union all
    select 'mechalol', 'is_dictionary_entry', cur.id, cur.title, prev.is_dictionary_entry::text, cur.is_dictionary_entry::text
    from mechalol_pages cur join mechalol_pages_temp prev using (id) where cur.is_dictionary_entry is distinct from prev.is_dictionary_entry
    union all
    select 'mechalol', 'wikipedia_id', cur.id, cur.title, prev.wikipedia_id::text, cur.wikipedia_id::text
    from mechalol_pages cur join mechalol_pages_temp prev using (id) where cur.wikipedia_id is distinct from prev.wikipedia_id
    union all
    select 'mechalol', 'match_type', cur.id, cur.title, prev.match_type, cur.match_type
    from mechalol_pages cur join mechalol_pages_temp prev using (id) where cur.match_type is distinct from prev.match_type
    union all
    select 'mechalol', 'maybe_deleted', cur.id, cur.title, prev.maybe_deleted_from_wikipedia::text, cur.maybe_deleted_from_wikipedia::text
    from mechalol_pages cur join mechalol_pages_temp prev using (id)
    where cur.maybe_deleted_from_wikipedia is distinct from prev.maybe_deleted_from_wikipedia
    union all
    select 'mechalol', 'template_referenced_title', cur.id, cur.title, prev.template_referenced_title, cur.template_referenced_title
    from mechalol_pages cur join mechalol_pages_temp prev using (id)
    where cur.template_referenced_title is distinct from prev.template_referenced_title
    -- ---- ויקיפדיה ----
    union all
    select 'wikipedia', 'only_new', cur.id, cur.title, null, cur.title
    from wikipedia_pages cur where not exists (select 1 from wikipedia_pages_temp p where p.id = cur.id)
    union all
    select 'wikipedia', 'only_old', prev.id, prev.title, prev.title, null
    from wikipedia_pages_temp prev where not exists (select 1 from wikipedia_pages c where c.id = prev.id)
    union all
    select 'wikipedia', 'title', cur.id, cur.title, prev.title, cur.title
    from wikipedia_pages cur join wikipedia_pages_temp prev using (id) where cur.title is distinct from prev.title
    union all
    select 'wikipedia', 'is_missing', cur.id, cur.title, prev.is_missing::text, cur.is_missing::text
    from wikipedia_pages cur join wikipedia_pages_temp prev using (id) where cur.is_missing is distinct from prev.is_missing
    union all
    select 'wikipedia', 'missing_override_reason', cur.id, cur.title, prev.missing_override_reason, cur.missing_override_reason
    from wikipedia_pages cur join wikipedia_pages_temp prev using (id)
    where cur.missing_override_reason is distinct from prev.missing_override_reason
    union all
    select 'wikipedia', 'mechalol_redirect_exists', cur.id, cur.title, prev.mechalol_redirect_exists::text, cur.mechalol_redirect_exists::text
    from wikipedia_pages cur join wikipedia_pages_temp prev using (id)
    where cur.mechalol_redirect_exists is distinct from prev.mechalol_redirect_exists;

    create temporary table _diff_k on commit drop as
    select d.*,
           case when d.side = 'mechalol'
                then exists (select 1 from _known_m k where k.page_id = d.page_id)
                else exists (select 1 from _known_w k where k.page_id = d.page_id)
           end as known_to_delta
    from _diff d;

    insert into reconciliation_diff_summary (audit_id, side, change_class, n, n_known_to_delta)
    select p_audit_id, side, change_class, count(*)::int, count(*) filter (where known_to_delta)::int
    from _diff_k group by side, change_class
    on conflict (audit_id, side, change_class) do update set n = excluded.n, n_known_to_delta = excluded.n_known_to_delta;

    delete from reconciliation_diff_examples where audit_id = p_audit_id;
    insert into reconciliation_diff_examples (audit_id, side, change_class, page_id, title, old_value, new_value, known_to_delta)
    select p_audit_id, side, change_class, page_id, title, old_value, new_value, known_to_delta
    from (
        select *, row_number() over (partition by side, change_class order by known_to_delta, page_id) as rn
        from _diff_k
    ) x
    where rn <= p_examples_per_class;
end;
$$;

revoke all on function log_reconciliation_diff_all(bigint, integer) from public, anon, authenticated;
grant execute on function log_reconciliation_diff_all(bigint, integer) to service_role;
