-- migration_add_source_update_report.sql
--
-- שני views (בלי נפח נוסף: לא עמודות, לא טבלאות, לא אינדקסים) לטאב "עדכון" בדשבורד:
-- רשימת הערכים שוויקיפדיה התקדמה בהם מאז העדכון האחרון.
--
-- report_source_update: ערכי mechalol_pages עם source_state = 'ahead'. בכוונה בלי JOIN
--   ל-wikipedia_pages: ספירה עם JOIN לקחה כ-11 שניות (ל-anon יש 15), בלי JOIN 0.2 שניות.
--   קישור ההשוואה בגאדג'ט בנוי מ-sort_template_rev (index.php?diff=cur&oldid=...), ולכן
--   לא צריך את latest_rev_id.
--   sort_template_date הוא `תאריך=` בתבנית - חודש העדכון המתועד, לא תאריך גרסת הבסיס.
--   update_bucket: חתכים לפי גיל העדכון המתועד (יחסיים להיום).
-- report_source_update_freshness: שורה אחת - הצלחה אחרונה הישנה ביותר מבין שני זרמי
--   העדכון השעתי, ומספר הכשלים הרצופים הגבוה ביותר. אינו security_invoker בכוונה
--   (הטבלה sort_template_sync_state לא חשופה ל-anon), וחושף רק את שלושת הערכים האלה.
--
-- ניתן להריץ בכל עת (create or replace view בלבד; לא בזמן ההחלפה השבועית, שמחליפה views).

create or replace view report_source_update with (security_invoker = true) as
select m.id,
       m.title,
       m.wikipedia_id,
       m.sort_template_rev,
       m.sort_template_date,
       case
           when m.sort_template_date is null then 'ללא תאריך'
           when m.sort_template_date < date '2020-01-01' then 'לפני 2020'
           when m.sort_template_date < (current_date - interval '2 years') then '2020 עד לפני שנתיים'
           when m.sort_template_date < (current_date - interval '1 year') then 'לפני שנה עד שנתיים'
           else 'בשנה האחרונה'
       end as update_bucket
from mechalol_pages m
where m.source_state = 'ahead';

grant select on report_source_update to anon, authenticated, service_role;

create or replace view report_source_update_freshness as
select min(last_success_at) as last_success_at,
       max(consecutive_failures) as max_failures,
       count(*) as streams
from sort_template_sync_state;

grant select on report_source_update_freshness to anon, authenticated, service_role;

notify pgrst, 'reload schema';
