-- Views לבעיות לטיפול, ממוקדים בערכי תוכן במרחב הראשי בלבד.
-- אינם כוללים: needs_attention=true (דפים ריקים - כבר מכוסים בקטגוריית
-- "ערכים לפתיחה"), is_dictionary_entry=true (תקצירים מילוניים, לא ערכים
-- מלאים). להרצה חד-פעמית בעורך ה-SQL של סופרבייס.

-- 1. חשוד כמחיקה/בעיית התאמה: מקור ודאי-ויקיפדי או לא-ידוע, בלי
--    התאמה לוויקיפדיה כרגע. עשוי לנבוע ממחיקה אמיתית, מהעברת שם
--    שדורשת בדיקה חוזרת, מטעות הקלדה בתבנית המיון, או מכותרת שדורשת
--    כלל נרמול חדש.
create or replace view report_possibly_deleted_source as
select id, title, status, source_type, match_type, checked_at
from mechalol_pages
where maybe_deleted_from_wikipedia = true
  and needs_attention = false
  and is_dictionary_entry = false
order by title;

-- 2. אושר ודאית מיומן ויקיפדיה: נמחק שם, או הועבר למרחב שם אחר.
--    עובדה, לא ניחוש - עדיפות ראשונה לטיפול.
create or replace view report_confirmed_deleted_from_wikipedia as
select id, title, status, wikipedia_id, checked_at
from mechalol_pages
where deleted_from_wikipedia = true
  and needs_attention = false
  and is_dictionary_entry = false
order by title;

-- 3. הכותרת השתנתה במכלול מאז ההתאמה האחרונה (הדף הועבר לשם אחר).
--    match.py יבדוק את אלה מחדש בריצה הבאה - הרשימה הזו נותנת לך
--    לראות אותן עכשיו, לפני שהריצה מתבצעת.
create or replace view report_title_changed_since_match as
select id, title, matched_title, wikipedia_id, status, checked_at
from mechalol_pages
where matched_title is not null
  and matched_title <> title
  and needs_attention = false
  and is_dictionary_entry = false
order by title;

-- 4. מיובא ללא תיעוד: אין תבנית מיון תקינה (או שמעולם לא נבדק/לא
--    שויך לקטגוריה - אין הבדלה בין השניים כרגע, ראו fetch_mechalol.py).
create or replace view report_undocumented_import as
select id, title, source_type, wikipedia_id, match_type, checked_at
from mechalol_pages
where status = 'מיובא ללא תיעוד'
  and needs_attention = false
  and is_dictionary_entry = false
order by title;
