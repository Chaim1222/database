-- migration_document_rls_and_grants.sql
--
-- מיגרציה רטרואקטיבית - מתעדת מצב שכבר קיים בפועל בייצור אך מעולם לא
-- הופיע בשום קובץ בריפו (לא schema.sql, לא views.sql, לא מיגרציה
-- נפרדת): RLS+policy+GRANT על wikipedia_pages/mechalol_pages, ו-REVOKE
-- מפורש מ-anon/authenticated על ארבע הפונקציות ה"כותבות". התגלה
-- ותועד תוך כדי בניית ארכיטקטורת המראה (migration_add_mirror_tables.sql),
-- כשהיה צריך לשחזר את אותה מדיניות בדיוק על טבלאות המראה ואומת ישירות
-- מול המסד החי כדי לדעת מה בכלל להעתיק. אין כאן שום שינוי במדיניות
-- עצמה - רק תיעוד, בטוח להרצה חוזרת.
--
-- שימו לב: revoke ... from public בלבד *אינו מספיק* - pg_default_acl
-- בפרויקט הזה מעניק הרשאה מפורשת בנפרד לכל תפקיד (anon, authenticated),
-- לא רק ל-PUBLIC, כך שיש לנקוב בשם התפקידים במפורש (התגלה כשהמיגרציה
-- הראשונה של ארכיטקטורת המראה לא נעלה בפועל את הפונקציות שלה למרות
-- revoke ... from public שהיה בה).

-- --- טבלאות: RLS + מדיניות ---
alter table wikipedia_pages enable row level security;
alter table mechalol_pages enable row level security;

drop policy if exists "קריאה ציבורית" on wikipedia_pages;
create policy "קריאה ציבורית" on wikipedia_pages
    for select to anon using (true);

drop policy if exists "קריאה ציבורית" on mechalol_pages;
create policy "קריאה ציבורית" on mechalol_pages
    for select to anon using (true);

revoke all on wikipedia_pages from anon, authenticated;
revoke all on mechalol_pages from anon, authenticated;
grant select on wikipedia_pages to anon, authenticated;
grant select on mechalol_pages to anon, authenticated;
grant select, insert, update, delete, truncate, references, trigger
    on wikipedia_pages, mechalol_pages to service_role;

-- --- פונקציות כותבות: EXECUTE ל-service_role בלבד ---
revoke all on function truncate_wikipedia_pages() from public, anon, authenticated;
grant execute on function truncate_wikipedia_pages() to service_role;

revoke all on function truncate_mechalol_pages() from public, anon, authenticated;
grant execute on function truncate_mechalol_pages() to service_role;

revoke all on function recompute_missing_flag() from public, anon, authenticated;
grant execute on function recompute_missing_flag() to service_role;

revoke all on function recompute_missing_flag_scoped(bigint[]) from public, anon, authenticated;
grant execute on function recompute_missing_flag_scoped(bigint[]) to service_role;

-- --- views (report_*): SELECT-בלבד ל-anon/authenticated ---
-- report_missing_from_mechalol כבר תמיד היה מוגבל נכון (לא רחב-מדי
-- מלכתחילה - ראו מלכוד ברירת המחדל בהמשך). שלושת האחרים תוקנו ב-2026-09
-- אחרי שהתגלה שהם קיבלו INSERT/UPDATE/DELETE/TRUNCATE בטעות (ברירת
-- המחדל של postgres ל-views חדשים, לא כוונה מפורשת).
revoke all on report_possibly_deleted_source from anon, authenticated;
revoke all on report_tasks_to_handle from anon, authenticated;
revoke all on report_undocumented_import from anon, authenticated;
revoke all on report_missing_from_mechalol from anon, authenticated;

grant select on report_possibly_deleted_source to anon, authenticated;
grant select on report_tasks_to_handle to anon, authenticated;
grant select on report_undocumented_import to anon, authenticated;
grant select on report_missing_from_mechalol to anon, authenticated;

notify pgrst, 'reload schema';
notify pgrst, 'reload config';
