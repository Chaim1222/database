-- migration_add_sort_template_denied.sql
--
-- דפים נעולים לקריאה (accessdenied) לא ניתנים לפענוח, ובלי טיפול נשארו ברשימת
-- הממתינים (list_pending_sort_template) והסקריפט ניסה אותם שוב ושוב. עכשיו דף שנדחה
-- מסומן ב-sort_template_denied_at ויוצא מהרשימה; נבדק שוב רק אחרי p_retry_days (30) - למקרה
-- שהנעילה הוסרה. הסימון נמחק כשהפענוח מצליח.
--
-- עמודה נפרדת מ-template_check_access_denied_at (של match.py): זו נכתבת ומתאפסת בריצה
-- השבועית של match.py על הטבלה הזמנית, ואילו זו מועתקת ב-forward_fill_enrichment_temp
-- כדי ששורות נעולות לא יחזרו לרשימה בכל החלפת טבלאות.
--
-- שורה נעולה נשארת בלי source_state (NULL): לא "אין בסיס" - פשוט לא ניתן לקרוא אותה.
-- idempotent. לא להריץ בזמן ריצה שבועית.

alter table mechalol_pages add column if not exists sort_template_denied_at timestamptz;
alter table mechalol_pages_temp add column if not exists sort_template_denied_at timestamptz;

comment on column mechalol_pages.sort_template_denied_at is
    'הפעם האחרונה שקריאת הדף נדחתה (נעול לקריאה) בפענוח התבנית. NULL = נקרא בהצלחה. נבדק שוב אחרי 30 יום.';

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
        mechalol_redirect_exists = old.mechalol_redirect_exists,
        latest_rev_id = old.latest_rev_id,
        latest_rev_ts = old.latest_rev_ts
    from wikipedia_pages as old
    where new.id = old.id;

    update mechalol_pages_temp as new
    set rev_id = old.rev_id,
        rev_ts = old.rev_ts,
        sort_template_rev = old.sort_template_rev,
        sort_template_title = old.sort_template_title,
        sort_template_date = old.sort_template_date,
        sort_template_parsed_rev = old.sort_template_parsed_rev,
        sort_template_denied_at = old.sort_template_denied_at,
        source_state = old.source_state
    from mechalol_pages as old
    where new.id = old.id;
$$;

-- החתימה משתנה (פרמטר חמישי), ולכן מסירים את הישנה במפורש כדי לא להשאיר עומס-יתר.
drop function if exists list_pending_sort_template(bigint, integer, integer, integer);
create or replace function list_pending_sort_template(
    p_after bigint default 0,
    p_limit integer default 2000,
    p_shard integer default 0,
    p_shards integer default 1,
    p_retry_days integer default 30
)
returns table (id bigint, title text)
language sql
stable
security definer
set search_path to 'public'
as $$
    select m.id, m.title
    from mechalol_pages m
    where m.status = 'מיובא ומתועד'
      and not m.is_dictionary_entry
      and not m.needs_attention
      and (m.sort_template_parsed_rev is null or m.sort_template_parsed_rev is distinct from m.rev_id)
      and (m.sort_template_denied_at is null
           or m.sort_template_denied_at < now() - make_interval(days => p_retry_days))
      and m.id > p_after
      and m.id % p_shards = p_shard
    order by m.id
    limit p_limit;
$$;

revoke all on function list_pending_sort_template(bigint, integer, integer, integer, integer)
    from public, anon, authenticated;
grant execute on function list_pending_sort_template(bigint, integer, integer, integer, integer)
    to service_role;

-- כתיבת פענוח מוצלח מנקה גם את סימון הנעילה.
create or replace function set_sort_template_batch(p_rows jsonb)
returns integer
language plpgsql
security definer
set search_path to 'public'
as $$
declare
    n integer;
begin
    update mechalol_pages m
    set rev_id = r.rev_id,
        rev_ts = r.rev_ts,
        sort_template_rev = r.rev,
        sort_template_title = r.title,
        sort_template_date = r.date,
        sort_template_parsed_rev = r.rev_id,
        sort_template_denied_at = null
    from jsonb_to_recordset(p_rows) as r(
        id bigint, rev_id bigint, rev_ts timestamptz, rev bigint, title text, date date
    )
    where m.id = r.id;
    get diagnostics n = row_count;
    return n;
end;
$$;

-- סימון דפים שנדחו. מאפס גם source_state - הנתון הקודם (אם היה) כבר לא ניתן לאימות.
create or replace function mark_sort_template_denied(p_ids bigint[])
returns integer
language plpgsql
security definer
set search_path to 'public'
as $$
declare
    n integer;
begin
    update mechalol_pages
    set sort_template_denied_at = now(),
        source_state = null
    where id = any (p_ids);
    get diagnostics n = row_count;
    return n;
end;
$$;

revoke all on function mark_sort_template_denied(bigint[]) from public, anon, authenticated;
grant execute on function mark_sort_template_denied(bigint[]) to service_role;

-- שורה נעולה לא מקבלת מצב (לא no_baseline): לא ניתן לקרוא אותה, ולכן גם לא לתקן.
create or replace function recompute_source_state(p_ids bigint[] default null)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
begin
    update mechalol_pages m
    set source_state = s.state
    from (
        select m2.id,
               case
                   when m2.sort_template_rev is null then 'no_baseline'
                   when w.latest_rev_id is null then 'unchecked'
                   when w.latest_rev_id = m2.sort_template_rev then 'current'
                   else 'ahead'
               end as state
        from mechalol_pages m2
        left join wikipedia_pages w on w.id = m2.wikipedia_id
        where m2.status = 'מיובא ומתועד'
          and not m2.is_dictionary_entry
          and not m2.needs_attention
          and m2.sort_template_denied_at is null
          and (p_ids is null or m2.id = any (p_ids))
    ) s
    where m.id = s.id
      and m.source_state is distinct from s.state;

    update mechalol_pages m
    set source_state = null
    where m.source_state is not null
      and (p_ids is null or m.id = any (p_ids))
      and (not (m.status = 'מיובא ומתועד' and not m.is_dictionary_entry and not m.needs_attention)
           or m.sort_template_denied_at is not null);
end;
$$;

revoke all on function recompute_source_state(bigint[]) from public, anon, authenticated;
grant execute on function recompute_source_state(bigint[]) to service_role;

notify pgrst, 'reload schema';
