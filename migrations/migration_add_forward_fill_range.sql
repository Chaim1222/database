-- migration_add_forward_fill_range.sql
--
-- גרסה בטווחי id של forward_fill_enrichment_temp (אותו גוף בדיוק, מוגבל ל-id >= p_from ו-id < p_to).
-- למה: ב-4.10.2026 הפונקציה המלאה רצה יותר מ-5 דקות (statement_timeout של service_role), בוטלה
-- וגלגלה לאחור, בזמן שבשבוע שלפני כן לקחה ~1.5 דקות. ביצועי המסד משתנים; טווחים קצרים לא תלויים בזה.
-- scripts/forward_fill_enrichment.py קורא לטווחים. הפונקציה המלאה נשארת (בדיקה ידנית).
--
-- idempotent (create or replace). לא נוגעת בשום טבלה. נקראת רק מהריצה השבועית (service_role).

create or replace function forward_fill_enrichment_temp_range(p_from bigint, p_to bigint)
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
    where new.id = old.id
      and new.id >= p_from and new.id < p_to;

    update mechalol_pages_temp as new
    set rev_id = old.rev_id,
        rev_ts = old.rev_ts,
        sort_template_rev = old.sort_template_rev,
        sort_template_date = old.sort_template_date,
        sort_template_parsed_rev = old.sort_template_parsed_rev,
        sort_template_denied_at = old.sort_template_denied_at,
        source_state = old.source_state
    from mechalol_pages as old
    where new.id = old.id
      and new.id >= p_from and new.id < p_to;
$$;

revoke all on function forward_fill_enrichment_temp_range(bigint, bigint) from public, anon, authenticated;
grant execute on function forward_fill_enrichment_temp_range(bigint, bigint) to service_role;
