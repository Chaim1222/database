-- migration_add_checked_columns.sql
--
-- מיגרציה רטרואקטיבית - מתעדת שתי עמודות שכבר קיימות בפועל בייצור
-- (נוצרו ישירות בעורך ה-SQL של סופרבייס בשלב מסוים, כמו
-- recompute_missing_flag_scoped) אך מעולם לא קיבלו קובץ מיגרציה
-- משלהן ולא הופיעו ב-schema.sql. התגלה ב-2026-09 תוך כדי בניית
-- ארכיטקטורת המראה (migration_add_forward_fill_function.sql) - forward_
-- fill_enrichment_shadow() היה צריך להעתיק אותן קדימה, ורק אז התברר
-- שהן לא מתועדות בכלל. `add column if not exists` כדי שההרצה תהיה
-- בטוחה גם על סביבה שכבר יש בה את העמודות (הייצור) וגם על התקנה חדשה
-- שרק עכשיו מריצה את schema.sql מההתחלה.

alter table wikipedia_pages
    add column if not exists created_at_checked boolean not null default false;

alter table wikipedia_pages
    add column if not exists easy_import_checked boolean not null default false;

comment on column wikipedia_pages.created_at_checked is
    'true אם fetch_wikipedia_created_at.py כבר ניסה לשלוף תאריך יצירה לשורה הזו (בין אם הצליח ובין אם לא) - נבדל מ-created_at is null, כי כישלון API לא נחשב "נבדק" בלי הדגל הזה. נבדק ב-fetch_wikipedia_created_at.py לפני עיבוד מחדש.';

comment on column wikipedia_pages.easy_import_checked is
    'true אם fetch_easy_import_candidates.py כבר בדק את השורה הזו לקלות-ייבוא (כולל תוצאה "missing"). נבדק ב-fetch_easy_import_candidates.py לפני עיבוד מחדש.';
