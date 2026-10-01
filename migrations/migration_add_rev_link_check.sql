-- migration_add_rev_link_check.sql
--
-- ממצאי הבדיקה של קישורי המכלול↔ויקיפדיה מול גרסת המקור שבתבנית (scripts/check_rev_links.py).
-- ההתאמה ב-match.py היא לפי שם; הבדיקה הזו שואלת לאיזה דף שייכת `גרסה=` ומשווה ל-wikipedia_id.
-- מקרה מייצג: "דהוכ" (מכלול 265071, גרסה 22338104 = "דהוכ (מחוז)", 180218) קושר לפי כותרת
-- לערך אחר בשם "דהוכ" (2328166) שנוצר אחרי שהמקורי הועבר.
--
-- נשמרות רק שורות חריגות (כמה אלפים לכל היותר), ולכן הנפח זניח. בלי מפתח זר ל-mechalol_pages/
-- wikipedia_pages (החלפת הטבלאות השבועית מחליפה שמות ושוברת מפתח זר) ובלי forward-fill: זו טבלה
-- נפרדת שהחלפת הטבלאות לא נוגעת בה. ה-view מצטרף ל-mechalol_pages, ו-perform_atomic_swap בונה
-- views תלויים מחדש בעצמה.
--
-- ניתן להריץ בכל עת מחוץ לריצה השבועית. idempotent. כתיבה: service_role בלבד; קריאה ציבורית
-- (כמו שאר הדוחות).

create table if not exists rev_link_check (
    mechalol_id         bigint primary key,
    status              text not null check (status in (
                            'other_page', 'unlinked_resolves', 'rev_page_redirect',
                            'rev_missing', 'other_namespace')),
    rev_id              bigint not null,
    linked_wikipedia_id bigint,
    rev_page_id         bigint,
    rev_page_title      text,
    name_equiv          boolean,
    checked_at          timestamptz not null default now()
);

alter table rev_link_check enable row level security;
drop policy if exists "קריאה ציבורית" on rev_link_check;
create policy "קריאה ציבורית" on rev_link_check for select to anon, authenticated using (true);

revoke all on rev_link_check from anon, authenticated;
grant select on rev_link_check to anon, authenticated;
grant select, insert, update, delete on rev_link_check to service_role;

-- הדוח: מה הקישור היום מול מה שהגרסה אומרת. linked_title = הערך שההתאמה לפי שם קישרה אליו.
-- ערכים שכבר מופיעים ב-report_tasks_to_handle מוסתרים (כבר יש להם משימה); נשארים רק החדשים.
create or replace view report_rev_link_mismatch with (security_invoker = true) as
select c.mechalol_id as id,
       m.title,
       m.status,
       c.status as check_status,
       case c.status
           when 'other_page' then 'הגרסה שייכת לדף אחר מהמקושר'
           when 'unlinked_resolves' then 'אין קישור, והגרסה מצביעה על דף חי'
           when 'rev_page_redirect' then 'דף הגרסה הפך להפניה'
           when 'rev_missing' then 'הגרסה לא קיימת'
           when 'other_namespace' then 'הגרסה שייכת למרחב שם אחר'
       end as check_status_label,
       c.rev_id,
       c.linked_wikipedia_id,
       w.title as linked_title,
       c.rev_page_id,
       c.rev_page_title,
       c.name_equiv,
       c.checked_at
from rev_link_check c
join mechalol_pages m on m.id = c.mechalol_id
left join wikipedia_pages w on w.id = c.linked_wikipedia_id
where not exists (select 1 from report_tasks_to_handle t where t.id = c.mechalol_id);

revoke all on report_rev_link_mismatch from anon, authenticated;
grant select on report_rev_link_mismatch to anon, authenticated, service_role;

notify pgrst, 'reload schema';
