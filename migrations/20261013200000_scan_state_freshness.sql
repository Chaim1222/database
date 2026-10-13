-- תוקף תוצאת הסינון ב-V1 (13.10.2026), כמו scan_state ב-V2 (מיגרציה 0040 שם).
-- report_missing_word_filter צירפה את תוצאת הסינון לפי מזהה בלבד: 194 תוצאות מתוך 25,996 נסרקו על גרסה
-- קודמת לגרסה שבמראה (העדכון השעתי מעדכן latest_rev_id, והסינון רץ אחרי הלילית), ו-88 מהן הוצגו "נקי".
-- scan_state: not_scanned (אין תוצאה) / stale (הגרסה שנסרקה קודמת לגרסה במראה, או שאחת מהן לא ידועה) /
-- scanned. גרסה שנסרקה חדשה מהמראה אינה ישנה. הממשק המשותף מסנן "נקי" רק מתוך scanned (כמו ב-V2).
-- הסיכום מציג רמות רק ל-scanned, ומוסיף scan_state. אין שינוי בנתונים או בסורק.
-- latest_rev_id נוספת בסוף report_missing_from_mechalol, שכבר קוראת את השורה (חיבור נוסף ל-wikipedia_pages
-- סרק את כל הטבלה: 0.7–8 שניות; כך נשאר כ-80ms). הצרכנים בוחרים עמודות מפורשות, ולכן עמודה בסוף אינה שוברת.
-- report_missing_from_mechalol תלויה ישירות ב-wikipedia_pages ומועתקת מחדש ב-perform_atomic_swap כמו קודם.
-- עמודות חדשות נוספות בסוף בלבד (create or replace view). אחרי ההחלה מעדכנים את הגאדג'ט.

begin;

create or replace view public.report_missing_from_mechalol with (security_invoker = true) as
select id, title, checked_at, wikidata_desc, easy_import_length, easy_import_has_images, problematic_words_clean,
       created_at, mechalol_redirect_exists, easy_import_checked, created_at_checked, latest_rev_id
from public.wikipedia_pages w
where is_missing = true and not exists (select 1 from public.blacklist_titles b where b.title = w.title)
order by title;

create or replace view public.report_missing_word_filter with (security_invoker = true) as
select m.id, m.title, m.checked_at, m.wikidata_desc, m.easy_import_length, m.created_at, m.mechalol_redirect_exists,
       r.verdict, r.verdict_suggested, r.has_images, r.photo_count, r.counts, r.matches_total, r.images, r.scanned_at,
       r.ctx_verdict, r.ctx_suspicion, r.ctx_verdict_suggested, r.ctx_suspicion_suggested, r.hidden_count,
       r.hidden_count_suggested, r.dictionary, r.dictionary_why, r.topic, r.names_count, r.names_count_suggested,
       case when r.wikipedia_id is null then 'not_scanned'
            when m.latest_rev_id is null or r.rev_id is null or r.rev_id < m.latest_rev_id then 'stale'
            else 'scanned' end as scan_state
from public.report_missing_from_mechalol m
left join public.word_filter_results r on r.wikipedia_id = m.id;

create or replace view public.report_missing_word_filter_summary with (security_invoker = true) as
select coalesce(mechalol_redirect_exists, false) as redirect, has_images,
       case when scan_state = 'scanned' then verdict end as verdict,
       case when scan_state = 'scanned' then verdict_suggested end as verdict_suggested,
       case when scan_state = 'scanned' then ctx_verdict end as ctx_verdict,
       case when scan_state = 'scanned' then ctx_suspicion end as ctx_suspicion,
       case when scan_state = 'scanned' then ctx_verdict_suggested end as ctx_verdict_suggested,
       case when scan_state = 'scanned' then ctx_suspicion_suggested end as ctx_suspicion_suggested,
       dictionary is not null as dictionary, topic, count(*)::integer as n, scan_state
from public.report_missing_word_filter
group by 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12;

commit;

notify pgrst, 'reload schema';
