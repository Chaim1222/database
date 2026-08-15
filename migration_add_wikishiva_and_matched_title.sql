-- מיגרציה חד-פעמית להרצה בעורך ה-SQL של סופרבייס, על הסביבה הקיימת.
-- לא הרסני - לא מוחק ולא נוגע בשורות קיימות.

-- 1. עמודה חדשה - כותרת המכלול בזמן ההתאמה האחרונה (ראו הסבר ב-schema.sql)
alter table public.mechalol_pages
    add column if not exists matched_title text;

-- 2. הוספת ערכי status חדשים: ייבוא מוויקישיבה, ונשמר במכלול למרות
--    מחיקה בוויקיפדיה - בנוסף לארבעת הערכים הקיימים
alter table public.mechalol_pages
    drop constraint if exists mechalol_pages_status_check;

alter table public.mechalol_pages
    add constraint mechalol_pages_status_check
    check (
        status = any (
            array[
                'נוצר במכלול'::text,
                'מיובא ומתועד'::text,
                'מיובא ללא תיעוד'::text,
                'ייבוא מחב"דפדיה'::text,
                'ייבוא מוויקישיבה'::text,
                'נשמר במכלול למרות מחיקה בוויקיפדיה'::text
            ]
        )
    );
