-- migration_add_word_filter_results.sql (2026-09)
--
-- תוצאות סינון התוכן של "חסר במכלול" (word-filter/tools/scan-missing.js):
-- לכל ערך ויקיפדיה בדוח report_missing_from_mechalol - רמה (בעיה ודאית /
-- לבדיקה / דורש ניסוח / נקי), תמונות, וכל התאמה עם המשפט שבו נמצאה.
--
-- טבלה נפרדת, ולא עמודות על wikipedia_pages, בכוונה:
--   - wikipedia_pages מתרוקנת ומוחלפת בכל ריצה שבועית (החלפה אטומית), וכל
--     עמודת העשרה עליה צריכה forward-fill. כאן המפתח הוא page_id של ויקיפדיה
--     (יציב), והשורות שורדות את ההחלפה בלי טיפול.
--   - הסריקה מדלגת על ערך שלא השתנה: rev_id (גרסת הדף) ו-lists_version (גיבוב
--     הרשימות והמנוע) נשמרים כאן. שינוי ברשימות = סריקה מחדש של הכל.
--
-- ה-view report_missing_word_filter נשען על report_missing_from_mechalol (לא
-- ישירות על wikipedia_pages), ולכן perform_atomic_swap לא צריכה לבנות אותו
-- מחדש: היא בונה מחדש את report_missing_from_mechalol עם create or replace,
-- שמשאיר את אותו OID, וה-view כאן ממשיך להצביע עליו.
--
-- idempotent - אפשר להריץ שוב.

create table if not exists word_filter_results (
    wikipedia_id bigint primary key,           -- page_id בוויקיפדיה (= wikipedia_pages.id)
    title text not null,
    rev_id bigint,                             -- הגרסה שנסרקה
    length integer,                            -- בבתים
    -- רמת הדף: לפי הרשימות המאושרות בלבד, ולפי הרשימות כולל ההצעות.
    verdict text check (verdict in ('problem', 'review', 'wording', 'clean')),
    verdict_suggested text check (verdict_suggested in ('problem', 'review', 'wording', 'clean')),
    -- {"a": {"problem": n, "review": n, "wording": n}, "s": {...}} - a = מאושרות, s = כולל הצעות
    counts jsonb,
    -- עד 300 התאמות: [{w, line, t (נושא), a/s (רמה בכל מצב, או null), e (רשומות),
    -- d (היתרים שהורידו לבדיקה), b/x/f (המשפט: לפני / ההתאמה / אחרי)}]
    matches jsonb,
    matches_total integer,
    image_count integer,                       -- כל הקבצים שמוצגים בדף (כולל אייקונים מתבניות)
    own_image_count integer,                   -- קבצים של הערך עצמו (בקוד, או התמונה הראשית)
    photo_count integer,                       -- מתוכם - לא SVG
    has_images boolean,                        -- photo_count > 0 - זה מה שהדשבורד מסנן
    images jsonb,                              -- עד 12 שמות קבצים (לתצוגה בדשבורד)
    lists_version text,
    scanned_at timestamptz not null default now()
);

create index if not exists word_filter_results_verdict_idx on word_filter_results (verdict);
create index if not exists word_filter_results_verdict_suggested_idx on word_filter_results (verdict_suggested);

comment on table word_filter_results is
    'סינון תוכן של ערכי "חסר במכלול" לפי רשימות המילים (word-filter/). נכתב ע"י word-filter/tools/scan-missing.js.';

alter table word_filter_results enable row level security;
drop policy if exists "קריאה ציבורית" on word_filter_results;
create policy "קריאה ציבורית" on word_filter_results for select to anon, authenticated using (true);

revoke all on word_filter_results from anon, authenticated;
grant select on word_filter_results to anon, authenticated;
grant select, insert, update, delete, truncate, references, trigger on word_filter_results to service_role;

-- "חסר במכלול" + תוצאות הסינון. left join: ערך שעוד לא נסרק מופיע עם verdict ריק.
-- סדר העמודות חייב להישאר קבוע (create or replace view).
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
    r.scanned_at
from report_missing_from_mechalol m
left join word_filter_results r on r.wikipedia_id = m.id;

revoke all on report_missing_word_filter from anon, authenticated;
grant select on report_missing_word_filter to anon, authenticated;
