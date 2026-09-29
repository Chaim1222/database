-- migration_add_word_filter_feedback.sql (2026-09)
--
-- סימון התראות מהדשבורד: ליד כל מילה בשורת "הקשר" יש ✗ (התראת שווא - זו לא
-- המילה, או שימוש תמים) ו-✓ (בעייתי באמת). הסימונים מצטברים כאן, ולכל
-- רשומה ברשימות רואים כמה פעמים סומנה כשגויה (word_filter_feedback_summary).
--
-- הכלל (חיים, 2026-09-29): מתקנים דפוס, לא מופע. תבנית עולה לתיקון רק כשהטעות
-- חוזרת - 10 סימוני ✗ ומעלה, או 20% מהמופעים שלה. מופע בודד נשאר בבדיקה הידנית.
-- הסימונים הם גם נתוני האימון של המסווג (NOTES סעיף 3א, שלב ג).
--
-- כתיבה: רק מנהלים מורשים (is_manual_match_admin - אותה רשימה כמו שיוך ידני),
-- עם הטוקן של המשתמש המחובר. קריאה: ציבורית, כמו שאר טבלאות הסינון.
-- הרשאות מפורשות (מ-30.10.2026 סופבייס לא נותן אותן אוטומטית לטבלה חדשה).
-- idempotent - אפשר להריץ שוב.

create table if not exists word_filter_feedback (
    id bigint generated always as identity primary key,
    wikipedia_id bigint not null,
    title text,
    match_key text not null,               -- שורה:מילה:רשומות (ממוינות) - זיהוי ההתאמה בערך
    word text not null,                    -- הטקסט שנתפס (x)
    entries text[] not null,               -- מזהי הרשומות ב-words.json
    topic text,
    hidden text,                           -- סוג הקוד, אם ההתאמה בקוד המוסתר (h)
    label text not null check (label in ('false', 'true')),  -- false = התראת שווא, true = בעייתי באמת
    level text,                            -- הרמה שהוצגה בעת הסימון
    before text,
    after text,
    lists_version text,
    user_id uuid not null default auth.uid(),
    created_at timestamptz not null default now(),
    unique (wikipedia_id, match_key, user_id)
);
create index if not exists word_filter_feedback_entries_idx on word_filter_feedback using gin (entries);

alter table word_filter_feedback enable row level security;
drop policy if exists "קריאה ציבורית" on word_filter_feedback;
create policy "קריאה ציבורית" on word_filter_feedback for select to anon, authenticated using (true);
drop policy if exists "מנהלים מורשים מסמנים" on word_filter_feedback;
create policy "מנהלים מורשים מסמנים" on word_filter_feedback
    for all to authenticated
    using (is_manual_match_admin() and user_id = auth.uid())
    with check (is_manual_match_admin() and user_id = auth.uid());

revoke all on word_filter_feedback from anon, authenticated;
grant select on word_filter_feedback to anon;
grant select, insert, update, delete on word_filter_feedback to authenticated;
grant select, insert, update, delete, truncate, references, trigger on word_filter_feedback to service_role;

-- לכל רשומה: כמה סימוני ✗ ו-✓, בכמה ערכים, ומה החלק של השגויים.
create or replace view word_filter_feedback_summary with (security_invoker = true) as
select e.entry_id,
    count(*) filter (where f.label = 'false')::int as false_marks,
    count(*) filter (where f.label = 'true')::int as true_marks,
    count(distinct f.wikipedia_id)::int as pages,
    round(count(*) filter (where f.label = 'false')::numeric / count(*), 2) as false_share,
    (array_agg(distinct f.word) filter (where f.label = 'false'))[1:10] as false_words,
    max(f.created_at) as last_marked
from word_filter_feedback f
cross join lateral unnest(f.entries) as e(entry_id)
group by e.entry_id;

revoke all on word_filter_feedback_summary from anon, authenticated;
grant select on word_filter_feedback_summary to anon, authenticated;
