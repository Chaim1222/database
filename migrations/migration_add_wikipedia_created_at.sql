-- מיגרציה חד-פעמית להרצה בעורך ה-SQL של סופרבייס, על הסביבה הקיימת.
-- מוסיפה ל-wikipedia_pages עמודת created_at - תאריך יצירת הערך
-- בוויקיפדיה (חותמת הזמן של הגרסה הראשונה שלו), נשלפת ונשמרת על ידי
-- fetch_wikipedia.py כחלק מאותה בקשת API של allpages
-- (generator=allpages + prop=revisions&rvdir=newer&rvlimit=1) - בלי
-- סבב בקשות נפרד לכל דף.
--
-- nullable בכוונה, בלי ברירת מחדל - wikipedia_pages מתרוקנת (TRUNCATE)
-- ומתמלאת מחדש במלואה בכל ריצה שבועית (ראו schema.sql), כך שהעמודה
-- נשלפת מחדש מה-API עבור כל השורות בכל ריצה - אין נתון "תקוע" מריצה
-- קודמת. יכולה להישאר NULL במקרה הנדיר שלגרסה הראשונה של דף אין
-- חותמת זמן זמינה מה-API.

alter table wikipedia_pages
    add column if not exists created_at timestamptz;
