-- migration_restrict_delta_log_tables_grants.sql
--
-- תיקון פער הרשאות שהתגלה בבדיקה מקיפה (2026-09): כל עשר טבלאות
-- הדלתא/לוג (הישנות וגם השתיים החדשות שלי - mechalol_status_update_log,
-- reconciliation_audit/reconciliation_audit_details) קיבלו הרשאות
-- מלאות (SELECT/INSERT/UPDATE/DELETE/TRUNCATE) ל-anon/authenticated
-- כברירת מחדל של pg_default_acl - בלי GRANT/REVOKE מפורש בשום קובץ
-- מיגרציה. RLS (מופעל, בלי אף מדיניות) כבר חוסם בפועל SELECT/INSERT/
-- UPDATE/DELETE, אבל TRUNCATE אינו כפוף ל-RLS בפוסטגרס - חשיפה
-- תיאורטית. אומת ישירות מול קוד הגאדג'ט (JS במדיה-ויקי): הוא קורא
-- אך ורק wikipedia_pages/mechalol_pages/report_* - אף אחת מעשר
-- הטבלאות האלה - אז אין סיכון לשבור אותו.
revoke all on mechalol_creations from anon, authenticated;
revoke all on mechalol_deletions from anon, authenticated;
revoke all on mechalol_renames from anon, authenticated;
revoke all on wikipedia_creations from anon, authenticated;
revoke all on wikipedia_deletions from anon, authenticated;
revoke all on wikipedia_renames from anon, authenticated;
revoke all on sync_watermarks from anon, authenticated;
revoke all on mechalol_status_update_log from anon, authenticated;
revoke all on reconciliation_audit from anon, authenticated;
revoke all on reconciliation_audit_details from anon, authenticated;

grant select on mechalol_creations to anon, authenticated;
grant select on mechalol_deletions to anon, authenticated;
grant select on mechalol_renames to anon, authenticated;
grant select on wikipedia_creations to anon, authenticated;
grant select on wikipedia_deletions to anon, authenticated;
grant select on wikipedia_renames to anon, authenticated;
grant select on sync_watermarks to anon, authenticated;
grant select on mechalol_status_update_log to anon, authenticated;
grant select on reconciliation_audit to anon, authenticated;
grant select on reconciliation_audit_details to anon, authenticated;
