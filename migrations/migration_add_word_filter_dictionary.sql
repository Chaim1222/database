-- migration_add_word_filter_dictionary.sql (2026-09)
--
-- מועמד לייבוא מילוני בסינון התוכן (word-filter/dictionary.js, scan-missing.js):
-- ערכי ספורט, מוזיקה, סרטים, שחקנים, טלוויזיה וספרות מיובאים למכלול כ"ערך מילוני"
-- (המכלול:מדיניות ערכים מילוניים). הזיהוי לפי תבנית המידע והקטגוריות שבוויקיטקסט.
-- סימון נפרד מרמת התוכן - לא משנה את verdict וכו'.
--
--   dictionary     - הסוג ('ספורט', 'מוזיקה', 'מוזיקאים', 'שחקנים', 'סרטים', 'טלוויזיה',
--                    'ספרות', 'משחקי מחשב', 'סרטים וטלוויזיה'), או null = לא מועמד
--   dictionary_why - הסיבה, להצגה ("תבנית סינגל", "קטגוריה כדורגלנים ישראלים")
-- ערך שנסרק לפני העמודות - null (הסריקה הבאה ממלאת, כי dictionary.js נכנס ל-lists_version).
--
-- report_missing_word_filter_summary מקבל עמודת dictionary (בוליאני) - למסנן בדשבורד
-- שמשפיע גם על המחוון. העמודה לא בסוף (לפני n), ולכן ה-view נבנה מחדש (drop + create).
-- idempotent - אפשר להריץ שוב.

alter table word_filter_results add column if not exists dictionary text;
alter table word_filter_results add column if not exists dictionary_why text;

-- עמודות חדשות רק בסוף (create or replace view לא מרשה לשנות סדר).
create or replace view report_missing_word_filter with (security_invoker = true) as
select m.id, m.title, m.checked_at, m.wikidata_desc, m.easy_import_length, m.created_at, m.mechalol_redirect_exists,
    r.verdict, r.verdict_suggested, r.has_images, r.photo_count, r.counts, r.matches_total, r.images, r.scanned_at,
    r.ctx_verdict, r.ctx_suspicion, r.ctx_verdict_suggested, r.ctx_suspicion_suggested,
    r.hidden_count, r.hidden_count_suggested,
    r.dictionary, r.dictionary_why
from report_missing_from_mechalol m
left join word_filter_results r on r.wikipedia_id = m.id;

drop view if exists report_missing_word_filter_summary;
create view report_missing_word_filter_summary with (security_invoker = true) as
select coalesce(mechalol_redirect_exists, false) as redirect,
    has_images,
    verdict,
    verdict_suggested,
    ctx_verdict,
    ctx_suspicion,
    ctx_verdict_suggested,
    ctx_suspicion_suggested,
    dictionary is not null as dictionary,
    count(*)::int as n
from report_missing_word_filter
group by 1, 2, 3, 4, 5, 6, 7, 8, 9;

revoke all on report_missing_word_filter, report_missing_word_filter_summary from anon, authenticated;
grant select on report_missing_word_filter, report_missing_word_filter_summary to anon, authenticated;
