-- migration_add_word_filter_hidden.sql (2026-09)
--
-- רשת ביטחון בסינון התוכן (word-filter/tools/scan-missing.js, scanHidden במנוע):
-- מילים שנמצאו רק בקוד שהקורא לא רואה - יעד של קישור ("[[אונס נערה (הלכה)|עינוי]]"),
-- הערה מוסתרת, שם קובץ, תבנית, כתובת. הקוד כולו עובר למכלול, אבל הרבה מההתאמות
-- האלה רעש ("[[ממלכת וסקס|וסקס]]"), ולכן הן לא נספרות ברמת הערך (verdict וכו').
-- הן נשמרות במערך matches עם השדה h (סוג הקוד), ובעמודות הספירה כאן - למסנן
-- "יש מילים בקוד המוסתר" בדשבורד.
--
--   hidden_count           - לפי הרשימות המאושרות
--   hidden_count_suggested - כולל ההצעות
-- נספרות רק צניעות וגיל העולם; לא שמות פרמטרים ("| מין = זכר") ולא מפתחות מיון.
-- ערך שנסרק לפני העמודות - null (הסריקה הבאה ממלאת, כי גרסת המנוע השתנתה).
-- idempotent - אפשר להריץ שוב.

alter table word_filter_results add column if not exists hidden_count integer;
alter table word_filter_results add column if not exists hidden_count_suggested integer;

create or replace view report_missing_word_filter with (security_invoker = true) as
select m.id, m.title, m.checked_at, m.wikidata_desc, m.easy_import_length, m.created_at, m.mechalol_redirect_exists,
    r.verdict, r.verdict_suggested, r.has_images, r.photo_count, r.counts, r.matches_total, r.images, r.scanned_at,
    r.ctx_verdict, r.ctx_suspicion, r.ctx_verdict_suggested, r.ctx_suspicion_suggested,
    r.hidden_count, r.hidden_count_suggested
from report_missing_from_mechalol m
left join word_filter_results r on r.wikipedia_id = m.id;

revoke all on report_missing_word_filter from anon, authenticated;
grant select on report_missing_word_filter to anon, authenticated;
