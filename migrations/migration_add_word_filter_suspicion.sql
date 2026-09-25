-- migration_add_word_filter_suspicion.sql (2026-09-25)
--
-- רמות חשד בתוך "לבדיקה" (הצעת חיים): לכל ערך ב"חסר במכלול" גם רמה לפי הקשר -
-- המילה עצמה (קבוצת השימוש שלה, word-filter/lists/usage.json) והמשפט שלה (עוגן
-- או מילה חשודה אחרת). ראו word-filter/analysis/word-rates.md ו-contextLevels במנוע.
--   ctx_verdict / ctx_verdict_suggested     - problem / review / wording / clean
--   ctx_suspicion / ctx_suspicion_suggested - high / medium / low (רק כש-review)
-- (verdict / verdict_suggested הקיימים = לפי רמת הרשימה בלבד, בלי הקשר.)
--
-- report_missing_word_filter_summary - ספירה מקובצת לפי כל העמודות שהדשבורד מסנן
-- לפיהן (מאות שורות), כדי שהמחוון יחושב בבקשה אחת בלי לספור 25 אלף שורות בדפדפן.
-- idempotent.

alter table word_filter_results
    add column if not exists ctx_verdict text check (ctx_verdict in ('problem', 'review', 'wording', 'clean')),
    add column if not exists ctx_suspicion text check (ctx_suspicion in ('high', 'medium', 'low')),
    add column if not exists ctx_verdict_suggested text check (ctx_verdict_suggested in ('problem', 'review', 'wording', 'clean')),
    add column if not exists ctx_suspicion_suggested text check (ctx_suspicion_suggested in ('high', 'medium', 'low'));

-- עמודות חדשות רק בסוף (create or replace view לא מרשה לשנות סדר).
create or replace view report_missing_word_filter with (security_invoker = true) as
select m.id,
    m.title,
    m.checked_at,
    m.wikidata_desc,
    m.easy_import_length,
    m.created_at,
    m.mechalol_redirect_exists,
    r.verdict,
    r.verdict_suggested,
    r.has_images,
    r.photo_count,
    r.counts,
    r.matches_total,
    r.images,
    r.scanned_at,
    r.ctx_verdict,
    r.ctx_suspicion,
    r.ctx_verdict_suggested,
    r.ctx_suspicion_suggested
from report_missing_from_mechalol m
left join word_filter_results r on r.wikipedia_id = m.id;

create or replace view report_missing_word_filter_summary with (security_invoker = true) as
select coalesce(mechalol_redirect_exists, false) as redirect,
    has_images,
    verdict,
    verdict_suggested,
    ctx_verdict,
    ctx_suspicion,
    ctx_verdict_suggested,
    ctx_suspicion_suggested,
    count(*)::int as n
from report_missing_word_filter
group by 1, 2, 3, 4, 5, 6, 7, 8;

revoke all on report_missing_word_filter, report_missing_word_filter_summary from anon, authenticated;
grant select on report_missing_word_filter, report_missing_word_filter_summary to anon, authenticated;
