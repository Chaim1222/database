-- migration_drop_rev_link_check.sql
--
-- rev_link_check ו-report_rev_link_mismatch (migration_add_rev_link_check.sql, 2026-10-01) היו צילום מצב
-- חד-פעמי של הסריקה הראשונה. מחליפות אותן עמודות rev_task בשורת הערך (migration_add_rev_task.sql),
-- שמתעדכנות ב-match.py. להריץ אחרי שהטאבים החדשים בדשבורד עובדים. idempotent.

drop view if exists report_rev_link_mismatch;
drop table if exists rev_link_check;
notify pgrst, 'reload schema';
