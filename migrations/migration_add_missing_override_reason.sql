-- מיגרציה חד-פעמית להרצה בעורך ה-SQL של סופרבייס, על הסביבה הקיימת.
-- מוסיפה ל-wikipedia_pages עמודת missing_override_reason - מתעדת *למה*
-- is_missing=false כשהסיבה אינה wikipedia_id/כותרת זהה ממש. כרגע ערך
-- אפשרי יחיד: 'rav_prefix_normalization' (ההתאמה נמצאה רק אחרי הסרת
-- קידומת "הרב"/"רבי" משני הצדדים - ראו normalize_person_title
-- ב-schema.sql). NULL כשההתאמה "אמיתית" (wikipedia_id או כותרת זהה
-- לגמרי) או כשעדיין חסר.
--
-- הרעיון: נירמול קידומת רבנית הוא ניחוש שכיח אך לא ודאי - שני אנשים
-- שונים לגמרי יכולים לחלוק שם עירום אחרי הסרת הקידומת. העמודה הזו
-- מאפשרת לאתר בקלות את כל השורות שהוחרגו מ"חסר במכלול" רק בזכות
-- הניחוש הזה (select * from wikipedia_pages where
-- missing_override_reason = 'rav_prefix_normalization') ולבטל את
-- ההחרגה על כולן או על חלקן בלי לחשב הכול מחדש:
-- update wikipedia_pages set is_missing = true, missing_override_reason
-- = null where missing_override_reason = 'rav_prefix_normalization';
--
-- nullable בכוונה, בלי ברירת מחדל - מתמלאת רק על ידי
-- recompute_missing_flag()/recompute_missing_flag_scoped(), לא נכתבת
-- באף מקום אחר.

alter table wikipedia_pages
    add column if not exists missing_override_reason text;
