-- migration_drop_sort_template_title.sql
--
-- מסירה את mechalol_pages.sort_template_title (`דף=` מהתבנית, ~6.5 MB): הכותרת של דף ויקיפדיה
-- נגזרת ממילא מ-wikipedia_id, והעמודה כמעט תמיד זהה לה. הכלי בגאדג'ט שולף את התבנית חי.
-- אין פגיעה באף לוגיקה: source_state נשען על sort_template_rev בלבד.
--
-- שימו לב: DROP COLUMN לא מקטין את הקובץ מיד; המקום מתפנה כשהשורות נכתבות מחדש. בטבלה
-- הפעילה זה קורה בהחלפה השבועית (הטבלה הזמנית נבנית בלי העמודה). ה-RPC set_sort_template_batch
-- מתעלם ממפתח "title" בקלט, כך שסקריפטים ישנים ממשיכים לעבוד.
-- idempotent.

drop view if exists report_source_ahead;

alter table mechalol_pages drop column if exists sort_template_title;
alter table mechalol_pages_temp drop column if exists sort_template_title;

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
        sort_template_date = old.sort_template_date,
        sort_template_parsed_rev = old.sort_template_parsed_rev,
        sort_template_denied_at = old.sort_template_denied_at,
        source_state = old.source_state
    from mechalol_pages as old
    where new.id = old.id;
$$;

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
        sort_template_date = r.date,
        sort_template_parsed_rev = r.rev_id,
        sort_template_denied_at = null
    from jsonb_to_recordset(p_rows) as r(
        id bigint, rev_id bigint, rev_ts timestamptz, rev bigint, date date
    )
    where m.id = r.id;
    get diagnostics n = row_count;
    return n;
end;
$$;

create or replace view report_source_ahead with (security_invoker = true) as
select m.id,
       m.title,
       m.wikipedia_id,
       m.sort_template_rev,
       m.sort_template_date,
       m.rev_ts
from mechalol_pages m
where m.source_state = 'ahead';

grant select on report_source_ahead to anon, authenticated, service_role;

notify pgrst, 'reload schema';
