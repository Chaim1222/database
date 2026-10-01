-- migration_exclude_manual_matches_from_maintenance.sql
--
-- שיוך ידני (manual_matches) = העורך כבר טיפל בערך, ולכן הוא יוצא מטאבי התחזוקה: משימות הגרסה,
-- "ללא תבנית מיון" ו"נעולים" (מקור 1 בלבד: דפי מכלול שקריאתם נדחתה). match.py כבר מנקה rev_task
-- לשורה עם שיוך ידני; כאן ה-views מסתירים גם את מה שעוד לא חושב מחדש.
--
-- "נעולים": מקור 2 (manual_matches שנוספו אוטומטית ע"י check_missing_locked.py עבור דפים נעולים
-- לקריאה, reason 'נעול לקריאה%') ומקור 3 (רשימה שחורה) נשארים: הם רשימת הנעולים עצמה, לא משימה.
-- ראו migration_add_locked_pages_report.sql. ללא שינוי בנפח; idempotent; לא בזמן ההחלפה השבועית.
-- (schema/views.sql לא מעודכן עד שהמיגרציה תורץ.)

create or replace view report_undocumented_import with (security_invoker = true) as
select id, title, source_type, wikipedia_id, match_type
from mechalol_pages
where status = 'מיובא ללא תיעוד'
  and needs_attention = false
  and is_dictionary_entry = false
  and not exists (select 1 from manual_matches mm where mm.mechalol_page_id = mechalol_pages.id)
order by title;

notify pgrst, 'reload schema';
