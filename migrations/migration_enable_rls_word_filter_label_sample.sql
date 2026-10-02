-- migration_enable_rls_word_filter_label_sample.sql
--
-- תיקון התראת סופבייס rls_disabled_in_public (27.9.2026): בייצור, RLS כבוי
-- על word_filter_label_sample (הטבלה היחידה בסכמה public בלי RLS; נבדק מול
-- המסד החי ב-2.10). המיגרציה המקורית (migration_add_word_filter_occurrences)
-- כללה enable row level security, אך המצב החי לא תאם.
--
-- זו טבלת עבודה פנימית (מדגם לסיווג ידני; נקראת רק דרך service_role / עורך
-- ה-SQL), ואף גאדג'ט או דשבורד לא קוראים אותה. לכן: RLS בלי מדיניות
-- (נעילה מלאה ל-anon/authenticated) + שלילת ההרשאות. service_role עוקף RLS.
-- word_filter_labels כבר עם RLS בלי מדיניות; כאן רק שוללים את ה-GRANT
-- הלא נחוץ. בטוח להרצה חוזרת.

alter table word_filter_label_sample enable row level security;
alter table word_filter_labels enable row level security;

revoke all on word_filter_label_sample from anon, authenticated;
revoke all on word_filter_labels from anon, authenticated;

grant select, insert, update, delete, truncate, references, trigger
    on word_filter_label_sample, word_filter_labels to service_role;

notify pgrst, 'reload schema';
