-- migration_add_word_filter_names.sql (2026-09)
--
-- שמות הקודש (word-filter, נושא names) - קטגוריה נפרדת: לא בעיה, לא חשד ולא ניסוח
-- (הכרעת חיים 2026-09-27). הם לא משפיעים על רמת הערך (verdict / ctx_verdict), ונספרים לחוד -
-- למסנן "שמות הקודש" בדשבורד:
--   names_count           - מספר ההתאמות לפי הרשימות המאושרות
--   names_count_suggested - כולל ההצעות
-- ערך שנסרק לפני העמודה - null (הסריקה הבאה ממלאת). idempotent.

alter table word_filter_results add column if not exists names_count integer;
alter table word_filter_results add column if not exists names_count_suggested integer;

create or replace view report_missing_word_filter with (security_invoker = true) as
select m.id, m.title, m.checked_at, m.wikidata_desc, m.easy_import_length, m.created_at, m.mechalol_redirect_exists,
    r.verdict, r.verdict_suggested, r.has_images, r.photo_count, r.counts, r.matches_total, r.images, r.scanned_at,
    r.ctx_verdict, r.ctx_suspicion, r.ctx_verdict_suggested, r.ctx_suspicion_suggested,
    r.hidden_count, r.hidden_count_suggested,
    r.dictionary, r.dictionary_why,
    r.topic,
    r.names_count, r.names_count_suggested
from report_missing_from_mechalol m
left join word_filter_results r on r.wikipedia_id = m.id;

revoke all on report_missing_word_filter from anon, authenticated;
grant select on report_missing_word_filter to anon, authenticated;
