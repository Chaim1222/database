-- migration_add_word_filter_topic.sql (2026-09)
--
-- נושא הערך בסינון התוכן (word-filter/topics.js, scan-missing.js) - למסנן "נושאים" בדשבורד,
-- שמאפשר לבחור כמה נושאים. קוד אחד לכל ערך: 'people_congress', 'art', 'sensitive' (נושאים
-- בעייתיים), 'years' (ערכי שנים), 'disambig' (פירושונים), 'dictionary' (ערך מילוני), 'other'...
-- השמות לתצוגה - ב-topics.js ובגאדג'ט. ערך שנסרק לפני העמודה - null (הסריקה הבאה ממלאת).
--
-- report_missing_word_filter_summary מקבל את topic - כדי שהמחוון יסונן גם לפי הנושאים שנבחרו.
-- העמודה לפני n, ולכן ה-view נבנה מחדש (drop + create). idempotent.

alter table word_filter_results add column if not exists topic text;

create or replace view report_missing_word_filter with (security_invoker = true) as
select m.id, m.title, m.checked_at, m.wikidata_desc, m.easy_import_length, m.created_at, m.mechalol_redirect_exists,
    r.verdict, r.verdict_suggested, r.has_images, r.photo_count, r.counts, r.matches_total, r.images, r.scanned_at,
    r.ctx_verdict, r.ctx_suspicion, r.ctx_verdict_suggested, r.ctx_suspicion_suggested,
    r.hidden_count, r.hidden_count_suggested,
    r.dictionary, r.dictionary_why,
    r.topic
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
    topic,
    count(*)::int as n
from report_missing_word_filter
group by 1, 2, 3, 4, 5, 6, 7, 8, 9, 10;

revoke all on report_missing_word_filter, report_missing_word_filter_summary from anon, authenticated;
grant select on report_missing_word_filter, report_missing_word_filter_summary to anon, authenticated;
