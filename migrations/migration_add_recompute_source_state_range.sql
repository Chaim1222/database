-- migration_add_recompute_source_state_range.sql
--
-- recompute_source_state() על כל הטבלה לקחה ~27 שניות גם כשלא היה מה לעדכן (מדידה בייצור,
-- 2026-09-29), ובעדכון המוני של ~260 אלף שורות תיקח הרבה יותר - סיכון ל-timeout של שכבת ה-API.
-- מחשבת רק את השורות שה-id שלהן בטווח [p_from, p_to), דרך recompute_source_state(p_ids), כך
-- שסקריפט הטעינה של גרסאות ויקיפדיה יכול לרוץ בקבוצות קטנות.
-- idempotent.

create or replace function recompute_source_state_range(p_from bigint, p_to bigint)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
declare
    ids bigint[];
begin
    select array_agg(id) into ids
    from mechalol_pages
    where id >= p_from and id < p_to;

    if ids is not null then
        perform recompute_source_state(ids);
    end if;
end;
$$;

revoke all on function recompute_source_state_range(bigint, bigint) from public, anon, authenticated;
grant execute on function recompute_source_state_range(bigint, bigint) to service_role;

notify pgrst, 'reload schema';
