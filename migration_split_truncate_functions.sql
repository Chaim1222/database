-- מיגרציה חד-פעמית להרצה בעורך ה-SQL של סופרבייס, על הסביבה הקיימת.
-- מחליפה את truncate_pages() המשותפת (מרוקנת את שתי הטבלאות יחד,
-- קריאה יחידה מתוך fetch_wikipedia.py) בשתי פונקציות עצמאיות -
-- truncate_mechalol_pages() ו-truncate_wikipedia_pages().
--
-- הסיבה: truncate_pages() המשותפת גרמה בפועל לאובדן נתונים כשריצה
-- אחת (fetch_wikipedia.py) הצליחה לרוקן+למלא מחדש בהצלחה, אבל הריצה
-- השנייה (fetch_mechalol.py) נכשלה אחר כך (למשל חסימת בוטים) -
-- mechalol_pages נשארה ריקה, כי היא כבר רוקנה כתוצאת-לוואי מהריצה
-- הראשונה, בלי שום סיכוי להתמלא מחדש.
--
-- אחרי המיגרציה הזו, כל טבלה מתרוקנת רק על ידי הסקריפט שאחראי עליה,
-- ורק ברגע שיש לו כבר אישור לנתונים אמיתיים מה-API (ריקון עצל, ראו
-- fetch_mechalol.py/fetch_wikipedia.py) - כשלון של סקריפט אחד כבר לא
-- יכול לגרום לריקון הטבלה של הסקריפט השני.
--
-- דורש גם את סדר השלבים המעודכן ב-weekly_update.yml (fetch_mechalol.py
-- לפני fetch_wikipedia.py) - ראו ההערה המפורטת ליד שתי הפונקציות
-- למטה (מפתח זר mechalol_pages.wikipedia_id -> wikipedia_pages.id
-- מחייב לרוקן קודם את mechalol_pages).
--
-- truncate_pages() הישנה לא נמחקת כאן (drop function) - אין בה עוד
-- קריאה בקוד אחרי המיגרציה הזו, ואפשר למחוק אותה ידנית בנוחות בהמשך.

create or replace function truncate_mechalol_pages()
returns void
language sql
as $$
    truncate table mechalol_pages;
$$;

create or replace function truncate_wikipedia_pages()
returns void
language sql
as $$
    truncate table wikipedia_pages;
$$;
