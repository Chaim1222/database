-- migration_add_word_filter_occurrences.sql (2026-09)
--
-- מסד ניתוח קטן מעל תוצאות הסריקה (word_filter_results): שורה לכל מופע של
-- מילת צניעות שנמצאה ב"חסר במכלול", עם מה שיש לידה באותו משפט. המטרה: לפצל
-- את "לבדיקה" לשלוש רמות חשד (הצעה של חיים, 2026-09-25):
--   גבוה   - באותו משפט יש מילת עוגן (בעייתית כמעט תמיד), או מילה חשודה אחרת
--            באותו משפט וגם עוגן במקום כלשהו בערך.
--   בינוני - רק אחד מהשניים: מילה חשודה אחרת במשפט, או עוגן במקום אחר בערך.
-- נבדק מול 1,196 המופעים המסווגים במדגם האקראי (word-filter/analysis/suspicion.js):
-- עוגן 96% בעייתי, גבוה ~90%, בינוני 50%, נמוך 18%.
--   נמוך   - המילה לבדה במשפט נקי, ואין עוגן בכל הערך.
--
-- word_filter_anchors - מילות העוגן: רשומות צניעות שבמדגם האקראי מוויקיפדיה
-- (word-filter/analysis/wiki-random-occurrences.json) היו בעייתיות ב-85% מהמופעים
-- ומעלה, עם 4 מופעים בעייתיים לפחות. זו הצעה - הרשימה ממתינה לאישור חיים.
--
-- "אותו משפט": אותה שורה בקוד, והמילה האחרת מופיעה בהקשר-המשפט השמור (b/f,
-- עד 90 תווים לכל צד). קירוב - משפט ארוך במיוחד עלול להיחתך.
--
-- refresh_word_filter_occurrences() בונה את הטבלה מחדש מ-word_filter_results.
-- idempotent - אפשר להריץ שוב.

create table if not exists word_filter_anchors (
    entry_id text primary key,       -- מזהה ב-word-filter/lists/words.json
    pattern text,
    labeled integer,                 -- מופעים מסווגים (בעייתי + תמים) במדגם האקראי
    problematic integer,             -- מתוכם בעייתיים
    status text not null default 'suggested' check (status in ('suggested', 'approved', 'rejected'))
);

create table if not exists word_filter_occurrences (
    wikipedia_id bigint not null,
    title text not null,
    idx integer not null,            -- מיקום ההתאמה במערך matches
    line integer,
    word text,                       -- הטקסט שנתפס
    topic text,
    level_approved text,             -- הרמה לפי הרשימות המאושרות (null = לא נתפס שם)
    level_suggested text,            -- לפי הרשימות כולל הצעות
    entries text[],
    before text,
    after text,
    is_anchor boolean,               -- המילה עצמה היא עוגן
    with_anchor boolean,             -- עוגן אחר באותו משפט
    with_other boolean,              -- מילה חשודה אחרת (לא עוגן) באותו משפט
    page_anchor boolean,             -- יש עוגן במקום כלשהו בערך (מלבד המילה עצמה)
    suspicion text,                  -- anchor / high / medium / low - ראו למעלה
    primary key (wikipedia_id, idx)
);
create index if not exists word_filter_occurrences_entries_idx on word_filter_occurrences using gin (entries);

create or replace function refresh_word_filter_occurrences()
returns void
language plpgsql
set search_path = public
as $$
declare
    anchors text[] := array(select entry_id from word_filter_anchors where status <> 'rejected');
begin
    truncate word_filter_occurrences;
    insert into word_filter_occurrences
        (wikipedia_id, title, idx, line, word, topic, level_approved, level_suggested, entries, before, after, is_anchor)
    select r.wikipedia_id, r.title, o.idx::int, (o.m->>'line')::int, o.m->>'x', o.m->>'t', o.m->>'a', o.m->>'s',
           array(select jsonb_array_elements_text(o.m->'e')), o.m->>'b', o.m->>'f',
           array(select jsonb_array_elements_text(o.m->'e')) && anchors
    from word_filter_results r
    cross join lateral jsonb_array_elements(r.matches) with ordinality as o(m, idx)
    where o.m->>'t' = 'modesty'
      and coalesce(o.m->>'s', o.m->>'a') in ('problem', 'review');

    update word_filter_occurrences a set
        with_anchor = exists (
            select 1 from word_filter_occurrences b
            where b.wikipedia_id = a.wikipedia_id and b.line = a.line and b.idx <> a.idx
              and b.is_anchor and b.word <> a.word
              and (strpos(a.before, b.word) > 0 or strpos(a.after, b.word) > 0)),
        with_other = exists (
            select 1 from word_filter_occurrences b
            where b.wikipedia_id = a.wikipedia_id and b.line = a.line and b.idx <> a.idx
              and not b.is_anchor and b.word <> a.word
              and (strpos(a.before, b.word) > 0 or strpos(a.after, b.word) > 0)),
        page_anchor = exists (
            select 1 from word_filter_occurrences b
            where b.wikipedia_id = a.wikipedia_id and b.idx <> a.idx and b.is_anchor and b.word <> a.word);

    update word_filter_occurrences set suspicion = case
        when is_anchor then 'anchor'
        when with_anchor or (with_other and page_anchor) then 'high'
        when with_other or page_anchor then 'medium'
        else 'low' end;
end;
$$;

alter table word_filter_anchors enable row level security;
alter table word_filter_occurrences enable row level security;
drop policy if exists "קריאה ציבורית" on word_filter_anchors;
create policy "קריאה ציבורית" on word_filter_anchors for select to anon, authenticated using (true);
drop policy if exists "קריאה ציבורית" on word_filter_occurrences;
create policy "קריאה ציבורית" on word_filter_occurrences for select to anon, authenticated using (true);
revoke all on word_filter_anchors, word_filter_occurrences from anon, authenticated;
grant select on word_filter_anchors, word_filter_occurrences to anon, authenticated;
grant select, insert, update, delete, truncate, references, trigger on word_filter_anchors, word_filter_occurrences to service_role;
revoke all on function refresh_word_filter_occurrences() from public, anon, authenticated;
grant execute on function refresh_word_filter_occurrences() to service_role;

-- --- מדגם לסיווג ידני (2026-09-25) - ראו word-filter/analysis/word-rates.md ---
-- 30 מופעים (מופע אחד לכל ערך, בחירה אקראית קבועה לפי md5) לכל אחת מ-60 המילים
-- הנפוצות שאינן עוגן, והסיווג שלהם (p/i/u). הסיווג עצמו נשמר גם בריפו:
-- word-filter/analysis/missing-labels.json.
create table if not exists word_filter_label_sample as
with o as (select *, array_to_string(array(select unnest(entries) order by 1), ',') fam from word_filter_occurrences where not is_anchor),
top as (select fam, count(*) n, row_number() over (order by count(*) desc) frank from o group by fam order by n desc limit 60),
one_per_page as (select o.*, top.frank, row_number() over (partition by o.fam, o.wikipedia_id order by o.idx) rp from o join top using (fam)),
ranked as (select *, row_number() over (partition by fam order by md5(wikipedia_id::text || ':' || idx)) rn from one_per_page where rp = 1)
select frank, fam, rn, wikipedia_id, idx, title, word, suspicion, before, after from ranked where rn <= 30;

create table if not exists word_filter_labels (
    frank int, rn int, label text check (label in ('p', 'i', 'u')), primary key (frank, rn)
);
alter table word_filter_label_sample enable row level security;
alter table word_filter_labels enable row level security;
