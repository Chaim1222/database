-- מיגרציה חד-פעמית להרצה בעורך ה-SQL של סופרבייס, על הסביבה הקיימת.
-- מוסיפה ל-blacklist_titles עמודת wikipedia_id - כדי לתעד גם את ה-
-- page_id בוויקיפדיה של הכותרות שנחסמו ליצירה במכלול, לא רק את השם.
--
-- בכוונה בלי מפתח זר אמיתי ל-wikipedia_pages(id) - הטבלה הזו מתרוקנת
-- מדי שבוע (ראו schema.sql), ומפתח זר היה חוסם את ה-TRUNCATE שלה
-- לגמרי. אותו טעם בדיוק שבגללו manual_matches.wikipedia_page_id גם
-- הוא בלי מפתח זר אמיתי.
--
-- nullable בכוונה - רשומות קיימות/שנוספו ידנית בעבר לא בהכרח כוללות
-- אותו.

alter table blacklist_titles
    add column if not exists wikipedia_id bigint;
