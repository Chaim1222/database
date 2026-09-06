-- migration_fix_missing_view_checked_columns.sql
--
-- תיקון פער ותיק, לא קשור לארכיטקטורת המראה: fetch_easy_import_
-- candidates.py ו-fetch_wikipedia_created_at.py שואלים את report_
-- missing_from_mechalol ומסננים לפי easy_import_checked/created_at_
-- checked (client.table("report_missing_from_mechalol").eq(...)) -
-- אבל ה-view מעולם לא כלל את שתי העמודות האלה בהגדרתו, למרות ששתיהן
-- קיימות בפועל על wikipedia_pages (ראו migration_add_checked_
-- columns.sql). כל הרצה של שני הסקריפטים האלה נכשלה מיד בשלב הקריאה
-- (42703 column does not exist), לפני שהגיעה בכלל לשלב הכתיבה -
-- התגלה רק כשהמשתמש הריץ בפועל את workflow ההעשרה.
--
-- שימו לב: CREATE OR REPLACE VIEW לא מרשה להכניס עמודה באמצע רשימת
-- העמודות הקיימת (רק להוסיף בסוף) - שתי העמודות נוספו בסוף הרשימה,
-- לא לפי סדר "הגיוני" ליד created_at/easy_import_*.
create or replace view report_missing_from_mechalol as
select w.id,
    w.title,
    w.checked_at,
    w.wikidata_desc,
    w.easy_import_length,
    w.easy_import_has_images,
    w.problematic_words_clean,
    w.created_at,
    w.mechalol_redirect_exists,
    w.easy_import_checked,
    w.created_at_checked
from wikipedia_pages w
where w.is_missing = true
  and not exists (
    select 1 from blacklist_titles b where b.title = w.title
  )
order by w.title;

-- create or replace view על view קיים שומר grants אוטומטית - אבל
-- נכתב במפורש שוב ליתר ביטחון (זול, לא משנה כלום אם כבר נכון).
revoke all on report_missing_from_mechalol from anon, authenticated;
grant select on report_missing_from_mechalol to anon, authenticated;

notify pgrst, 'reload schema';
