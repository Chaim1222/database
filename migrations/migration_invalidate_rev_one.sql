-- migration_invalidate_rev_one.sql
--
-- גרסה 1 היא גרסת העמוד הראשי בוויקיפדיה, כלומר ערך מחדל ולא גרסה אמיתית (הכרעת חיים, 2026-10-01;
-- scripts/sort_template.py parse_rev מתעלם ממנה מעתה). מנקה את הקיימות (~17 ערכים) ומחשב מחדש
-- source_state שלהן (יהפכו ל-no_baseline). נתוני הייצור נוקו בעורך ה-SQL; idempotent.
-- אחרי הרצה: match.py (דלתא) יסמן אותם כ"גרסה שגויה".

with fixed as (
    update mechalol_pages set sort_template_rev = null where sort_template_rev = 1 returning id
)
select count(*) as fixed, recompute_source_state(coalesce(array_agg(id), '{}'::bigint[])) from fixed;
