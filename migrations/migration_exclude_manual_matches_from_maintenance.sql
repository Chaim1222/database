-- migration_exclude_manual_matches_from_maintenance.sql
--
-- שיוך ידני (manual_matches) = העורך כבר טיפל בערך, ולכן הוא יוצא מ"ללא תבנית מיון". גם ממשימות
-- הגרסה (report_rev_tasks ב-migration_rev_link_check_v2.sql מסתיר אותן).
-- "נעולים" **לא** משתנה: שיוך ידני אינו מוציא דף מהרשימה שלו (הכרעת חיים, 1.10).
-- ללא שינוי בנפח; idempotent; לא בזמן ההחלפה השבועית. (schema/views.sql לא מעודכן עד שהמיגרציה תורץ.)

create or replace view report_undocumented_import with (security_invoker = true) as
select id, title, source_type, wikipedia_id, match_type
from mechalol_pages
where status = 'מיובא ללא תיעוד'
  and needs_attention = false
  and is_dictionary_entry = false
  and not exists (select 1 from manual_matches mm where mm.mechalol_page_id = mechalol_pages.id)
order by title;

notify pgrst, 'reload schema';
