-- migration_refresh_word_filter_occurrences_single_pass.sql
--
-- refresh_word_filter_occurrences() הכניסה 76,822 שורות ואז הריצה שלוש פקודות UPDATE על כולן
-- (with_anchor, with_other, page_anchor + suspicion). כל UPDATE יוצר גרסת שורה חדשה, והטבלה
-- התנפחה פי שלושה: 71 MB לנתונים בגודל ~23 MB (בסטטיסטיקה: 76,822 הכנסות ו-230,466 עדכונים).
-- כאן הדגלים מחושבים בהכנסה אחת, מטבלה זמנית עם אינדקסים, בלי עדכונים.
-- שקילות אומתה בטביעת אצבע של כל הטבלה: האלגוריתם הישן על הנתונים הנוכחיים והטבלה שהחדש בנה
-- נתנו בדיוק אותה תוצאה (67,808 שורות). שימו לב: הריצה הראשונה של הפונקציה החדשה בנתה את
-- הטבלה מחדש מ-word_filter_results הנוכחי, ולכן הסנפשוט הישן (76,822 שורות, ישן ביחס לתוצאות
-- הסריקה) הוחלף; הפרש השורות נובע מהנתונים ולא מהאלגוריתם. הטבלה ירדה מ-80 MB ל-25 MB.
-- ההיגיון של כל דגל לא השתנה: ראו migration_add_word_filter_occurrences.sql.

create or replace function refresh_word_filter_occurrences()
returns void
language plpgsql
set search_path = public
as $$
declare
    anchors text[] := array(select entry_id from word_filter_anchors where status <> 'rejected');
begin
    drop table if exists _occ_base;
    create temporary table _occ_base on commit drop as
    select r.wikipedia_id, r.title, o.idx::int as idx, (o.m->>'line')::int as line,
           o.m->>'x' as word, o.m->>'t' as topic, o.m->>'a' as level_approved, o.m->>'s' as level_suggested,
           array(select jsonb_array_elements_text(o.m->'e')) as entries,
           o.m->>'b' as before, o.m->>'f' as after,
           array(select jsonb_array_elements_text(o.m->'e')) && anchors as is_anchor
    from word_filter_results r
    cross join lateral jsonb_array_elements(r.matches) with ordinality as o(m, idx)
    where o.m->>'t' = 'modesty'
      and coalesce(o.m->>'s', o.m->>'a') in ('problem', 'review');

    create index on _occ_base (wikipedia_id, line);
    create index on _occ_base (wikipedia_id) where is_anchor;
    analyze _occ_base;

    truncate word_filter_occurrences;
    insert into word_filter_occurrences
        (wikipedia_id, title, idx, line, word, topic, level_approved, level_suggested, entries,
         before, after, is_anchor, with_anchor, with_other, page_anchor, suspicion)
    select f.wikipedia_id, f.title, f.idx, f.line, f.word, f.topic, f.level_approved, f.level_suggested,
           f.entries, f.before, f.after, f.is_anchor, f.with_anchor, f.with_other, f.page_anchor,
           case
               when f.is_anchor then 'anchor'
               when f.with_anchor or (f.with_other and f.page_anchor) then 'high'
               when f.with_other or f.page_anchor then 'medium'
               else 'low'
           end
    from (
        select a.*,
               exists (
                   select 1 from _occ_base b
                   where b.wikipedia_id = a.wikipedia_id and b.line = a.line and b.idx <> a.idx
                     and b.is_anchor and b.word <> a.word
                     and (strpos(a.before, b.word) > 0 or strpos(a.after, b.word) > 0)) as with_anchor,
               exists (
                   select 1 from _occ_base b
                   where b.wikipedia_id = a.wikipedia_id and b.line = a.line and b.idx <> a.idx
                     and not b.is_anchor and b.word <> a.word
                     and (strpos(a.before, b.word) > 0 or strpos(a.after, b.word) > 0)) as with_other,
               exists (
                   select 1 from _occ_base b
                   where b.wikipedia_id = a.wikipedia_id and b.idx <> a.idx
                     and b.is_anchor and b.word <> a.word) as page_anchor
        from _occ_base a
    ) f;
end;
$$;
