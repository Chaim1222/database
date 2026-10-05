-- migration_add_wikipedia_moves_report.sql
--
-- הטאב "הועברו בוויקיפדיה" בדשבורד (קבוצת תחזוקה): ערכים שהדף שלהם בוויקיפדיה הועבר לשם חדש ואצלנו עדיין השם הישן.
-- בנוי ישר מהמסד, בלי API: טבלת הדלתא wikipedia_renames (page_id יציב, old_title, new_title, renamed_at) מתעדכנת בכל לילה
-- (fetch_wikipedia_delta.py), ולכן הרשימה מתעדכנת איתה, בלי הסריקה החודשית של rev_link_check ("העברת שם").
--
-- שני סימנים ש"עדיין נושאים את השם הישן" (נבדקו על נתוני ייצור 5.10: 28 + 7 לפני סינון):
--   title     הכותרת שלנו שווה לשם הישן בוויקיפדיה
--   template  שם התבנית (דף=) הוא שם ישן שכבר לא קיים ב-wikipedia_pages (mechalol_pages.template_referenced_title)
-- בכוונה לא "הקישור wikipedia_id לדף שהועבר": ערך שהכותרת שלו הוחלטה מקומית (למשל "רבי X" מול "X") היה מופיע לנצח.
-- ערך שהכותרת שלו כבר זהה לשם הנוכחי בוויקיפדיה לא מופיע (m.title <> w.title); ערכים מילוניים ודפי טיפול (needs_attention) כן מופיעים - גם אותם צריך להעביר.
-- ערך שנתפס בשני הסימנים מופיע פעם אחת (title קודם), כי הדשבורד משתמש ב-id כמפתח שורה.
-- הענף template נשען על אינדקס חלקי קטן על template_referenced_title (153 שורות בלבד), אחרת סריקה מלאה לוקחת 5 שניות.
-- security_invoker, כמו שאר ה-views: anon קורא את wikipedia_renames (policy "קריאה ציבורית"). בלי שינוי סכמה ובלי נפח. idempotent.

create index if not exists mechalol_pages_template_ref_idx
    on mechalol_pages (template_referenced_title) where template_referenced_title is not null;
-- הטבלה הזמנית של הסנכרון השבועי (ההחלפה האטומית משנה שמות אינדקסים דינמית)
do $$ begin
    if to_regclass('public.mechalol_pages_temp') is not null then
        create index if not exists mechalol_pages_temp_template_ref_idx
            on mechalol_pages_temp (template_referenced_title) where template_referenced_title is not null;
    end if;
end $$;

create or replace view report_wikipedia_moves with (security_invoker = true) as
with last_move as (
    select distinct on (r.page_id, r.old_title) r.page_id, r.old_title, r.renamed_at
    from wikipedia_renames r
    where r.action = 'move'
    order by r.page_id, r.old_title, r.renamed_at desc
),
tpl as (
    select m.id, m.template_referenced_title
    from mechalol_pages m
    where m.template_referenced_title is not null
      and m.status <> 'נשמר במכלול למרות מחיקה בוויקיפדיה'
),
hits as (
    select m.id, 'title'::text as via, lm.page_id, lm.old_title, lm.renamed_at
    from last_move lm
    join mechalol_pages m on m.title = lm.old_title
    union all
    select t.id, 'template', lm.page_id, lm.old_title, lm.renamed_at
    from last_move lm
    join tpl t on t.template_referenced_title = lm.old_title
)
select distinct on (h.id)
    h.id,
    m.title,
    w.title as wikipedia_title,
    h.old_title,
    h.renamed_at,
    h.via,
    m.status,
    h.page_id as wikipedia_id
from hits h
join mechalol_pages m on m.id = h.id
join wikipedia_pages w on w.id = h.page_id
where m.title <> w.title
order by h.id, (h.via = 'title') desc, h.renamed_at desc;

revoke all on report_wikipedia_moves from anon, authenticated;
grant select on report_wikipedia_moves to anon, authenticated, service_role;

notify pgrst, 'reload schema';
