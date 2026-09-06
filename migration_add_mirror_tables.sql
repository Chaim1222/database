-- migration_add_mirror_tables.sql
--
-- מיגרציה לארכיטקטורת המראה עם החלפה אטומית (ראו mirror_architecture_
-- design.md לתכנון המלא). מבוססת על schema.sql/views.sql כפי שהם
-- באמת בסופרבייס - לא רק על הכוונה המקורית שלהם. בטוחה להרצה חוזרת
-- (כל סעיף idempotent: IF NOT EXISTS / CREATE OR REPLACE / DROP...
-- IF EXISTS לפני CREATE POLICY).
--
-- סדר ההרצה חשוב: שלב 1 (טבלאות) לפני שלב 2/3 (פונקציות שתלויות בהן).

-- =============================================================
-- שלב 1 — טבלאות מראה + אבטחת שורה
-- =============================================================

create table if not exists wikipedia_pages_shadow (like wikipedia_pages including all);
-- תיקון אחרי בדיקה אמפירית ישירה מול המסד: "including defaults" בלבד
-- (כפי שהיה בטיוטת התכנון המקורית) מעתיק *רק* ברירות מחדל של עמודות -
-- לא PRIMARY KEY, לא UNIQUE(title), לא CHECK constraints, לא אינדקסים.
-- אומת עם טבלת בדיקה זמנית: pg_constraint חזר ריק לגמרי, כולל בלי
-- מפתח ראשי על id. בלי PK, upsert(rows, on_conflict="id") ב-
-- fetch_mechalol.py היה נכשל (ל-ON CONFLICT צריך אילוץ ייחודי בפועל),
-- ו-_is_title_collision (בודקת mechalol_pages_shadow_title_key) לעולם
-- לא הייתה מזהה כלום כי האילוץ עצמו לא קיים. "including all" בשתי
-- הטבלאות, לא רק בוויקיפדיה.
create table if not exists mechalol_pages_shadow (like mechalol_pages including all);

do $$
begin
    if not exists (
        select 1 from pg_constraint
        where conname = 'mechalol_pages_shadow_wikipedia_id_fkey'
    ) then
        alter table mechalol_pages_shadow
            add constraint mechalol_pages_shadow_wikipedia_id_fkey
            foreign key (wikipedia_id) references wikipedia_pages_shadow(id);
    end if;
end $$;

-- "including all" מעתיק גם אילוצים/אינדקסים/ברירות מחדל, אבל *לא*
-- את דגל ה-RLS, את המדיניות עצמה, ואת ה-GRANTs - שלושתם חייבים הגדרה
-- ידנית, אחרת אחרי ההחלפה הטבלה הפעילה עלולה להיות בלי הגנת שורה,
-- בלי הרשאות בכלל, או (ראו המלכוד למטה) עם הרשאות רחבות מדי.
--
-- תיקון אחרי בדיקה אמפירית ישירה מול המסד (לא הנחה): פוסטגרס *לא*
-- שומר את שם האילוץ המקורי (wikipedia_pages_title_key) על הטבלה
-- החדשה - הוא בונה שם חדש לפי שם הטבלה החדשה עצמה
-- (wikipedia_pages_shadow_title_key). _is_title_collision בקוד
-- הפייתון (fetch_wikipedia.py/fetch_mechalol.py) עודכן בהתאם לבדוק
-- table_name('wikipedia_pages') + '_title_key' במקום מחרוזת קבועה.
alter table wikipedia_pages_shadow enable row level security;
alter table mechalol_pages_shadow enable row level security;

-- הניסוח המדויק כפי שהוא מוגדר היום בפועל על הטבלאות הפעילות (policy
-- יחיד לכל טבלה, קריאה פתוחה לגמרי ל-anon, בלי סינון שורות).
drop policy if exists "קריאה ציבורית" on wikipedia_pages_shadow;
create policy "קריאה ציבורית" on wikipedia_pages_shadow
    for select to anon using (true);

drop policy if exists "קריאה ציבורית" on mechalol_pages_shadow;
create policy "קריאה ציבורית" on mechalol_pages_shadow
    for select to anon using (true);

-- מלכוד: יש ל-public הרשאת ברירת מחדל (pg_default_acl) שמעניקה
-- אוטומטית לכל טבלה חדשה שנוצרת על ידי postgres גישה *מלאה*
-- (קריאה+כתיבה+מחיקה+ריקון) גם ל-anon וגם ל-authenticated - הרבה
-- יותר רחב ממה שיש בפועל על wikipedia_pages/mechalol_pages (שם
-- ל-anon/authenticated יש רק SELECT). בלי לתקן את זה במפורש, טבלת
-- המראה תיווצר עם anon שיכול למחוק/לעדכן שורות ישירות - רגרסיית
-- אבטחה, לא רק חוסר הרשאה. לכן חובה לצמצם במפורש:
revoke all on wikipedia_pages_shadow from anon, authenticated;
revoke all on mechalol_pages_shadow from anon, authenticated;
grant select on wikipedia_pages_shadow to anon, authenticated;
grant select on mechalol_pages_shadow to anon, authenticated;
grant select, insert, update, delete, truncate, references, trigger
    on wikipedia_pages_shadow, mechalol_pages_shadow to service_role;

-- =============================================================
-- שלב 3.5 — is_missing חייב להיות מחושב על המראה *לפני* ההחלפה
-- =============================================================
--
-- recompute_missing_flag() המקורית (schema.sql) מקובעת בשם הטבלה
-- (wikipedia_pages/mechalol_pages) - אם match.py קורא לה כשהוא רץ על
-- המראה (TARGET_TABLE_SUFFIX=_shadow), היא תמשיך לעדכן את הטבלה
-- הפעילה הישנה, לא את המראה. אחרי ההחלפה, wikipedia_pages_shadow
-- (שהופכת ל-wikipedia_pages) תיכנס לשירות עם is_missing=false בכל
-- השורות (ברירת המחדל) - report_missing_from_mechalol יהיה ריק מיד.
-- לכן גרסת-מראה ייעודית, זהה בלוגיקה למקור, רק על טבלאות ה-_shadow:
create or replace function recompute_missing_flag_shadow()
returns void
language sql
set search_path = public
as $$
    update wikipedia_pages_shadow w
    set is_missing = not exists (
            select 1 from mechalol_pages_shadow m
            where m.wikipedia_id = w.id
               or m.title = w.title
               or normalize_person_title(m.title) = normalize_person_title(w.title)
        ),
        missing_override_reason = case
            when exists (select 1 from mechalol_pages_shadow m where m.wikipedia_id = w.id or m.title = w.title)
                then null
            when exists (select 1 from mechalol_pages_shadow m where normalize_person_title(m.title) = normalize_person_title(w.title))
                then 'rav_prefix_normalization'
            else null
        end
    -- קריטי, לא רק אופטימיזציה: authenticator (התפקיד ש-PostgREST
    -- מתחבר דרכו) טוען session_preload_libraries=supautils,safeupdate -
    -- מרחיב שחוסם UPDATE/DELETE בלי WHERE בכל קריאת RPC, ללא תלות
    -- ב-SET ROLE פנימי. בלי ה-WHERE הזה, הקריאה הראשונה בפועל דרך
    -- match.py נכשלה עם 'UPDATE requires a WHERE clause' (SQLSTATE
    -- 21000) - אומת ותוקן ישירות מול המסד אחרי ריצה חיה. אותו טעם
    -- בדיוק שבגללו recompute_missing_flag() המקורית כוללת את אותו
    -- WHERE.
    where w.is_missing is distinct from not exists (
            select 1 from mechalol_pages_shadow m
            where m.wikipedia_id = w.id
               or m.title = w.title
               or normalize_person_title(m.title) = normalize_person_title(w.title)
        )
       or w.missing_override_reason is distinct from case
            when exists (select 1 from mechalol_pages_shadow m where m.wikipedia_id = w.id or m.title = w.title)
                then null
            when exists (select 1 from mechalol_pages_shadow m where normalize_person_title(m.title) = normalize_person_title(w.title))
                then 'rav_prefix_normalization'
            else null
        end;
$$;
-- במסד החי (אומת ישירות: proacl שלהן מוגבל ל-postgres+service_role
-- בלבד, לא ברירת המחדל הפתוחה) - מוסכמת אבטחה קיימת בפרויקט שלא
-- מתועדת ב-schema.sql. בלעדי זה, anon היה יכול לקרוא לפונקציה הזו
-- ישירות דרך ה-RPC של PostgREST (ברירת המחדל של postgres מעניקה
-- EXECUTE אוטומטית ל-anon/authenticated על כל פונקציה חדשה - אומת
-- ישירות מול pg_default_acl).
revoke all on function recompute_missing_flag_shadow() from public;
grant execute on function recompute_missing_flag_shadow() to service_role;

-- =============================================================
-- שלב 6 — חלון rollback: קידום העותק previous + ריקון, לא ניקוי מיידי
-- =============================================================
--
-- נקראת (במקום truncate_wikipedia_pages/truncate_mechalol_pages הישנות
-- בסבב מראה) כצעד המקדים היחיד בתחילת fetch_wikipedia.py, לפני כתיבת
-- שורה ראשונה לסבב הבא. fetch_mechalol.py לא קורא לריקון בכלל בסבב
-- מראה (ראו is_shadow_mode() ב-table_names.py).
--
-- אם קיים עותק "previous" מהסבב הקודם (המצב הרגיל) - מקדמים אותו
-- לתפקיד מראה חדש ורק אז מרוקנים, כדי לשמר את חלון ה-rollback עד
-- הרגע האחרון האפשרי. בהרצה הראשונה אי-פעם (אין עדיין _previous) -
-- מדלגים על שלב הקידום ופשוט מרוקנים את טבלאות המראה הריקות ממילא.
--
-- truncate על שתי הטבלאות יחד, באותה פקודה - מרוקן את שתיהן בלי
-- להזדקק ל-CASCADE (בניגוד ל-truncate_wikipedia_pages() המקורית),
-- ובלי תלות בסדר ריקון בין השתיים.
--
-- security definer: מבצעת ALTER TABLE RENAME (DDL) - הטבלאות בבעלות
-- postgres (אומת ישירות: pg_class.relowner), לא service_role (התפקיד
-- שקורא לפונקציה הזו בפועל מ-fetch_wikipedia.py). בלי security
-- definer, ה-RENAME היה נכשל תמיד בהרשאה - GRANT רגיל לא מספיק בשביל
-- DDL, רק בעלות (או superuser). אותו טעם בדיוק כמו perform_atomic_swap
-- ב-migration_add_swap_function.sql.
create or replace function promote_previous_to_shadow_and_truncate()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
    if exists (
        select 1 from pg_tables
        where schemaname = 'public' and tablename = 'wikipedia_pages_previous'
    ) then
        alter table wikipedia_pages_previous rename to wikipedia_pages_shadow;
        alter table mechalol_pages_previous rename to mechalol_pages_shadow;
    end if;
    truncate table mechalol_pages_shadow, wikipedia_pages_shadow;

    -- תיקון: בניגוד ל-perform_atomic_swap/revert_atomic_swap (שכן כוללות
    -- notify בסוף), הפונקציה הזו לא כללה אותו למרות שהיא גם מבצעת ALTER
    -- TABLE RENAME - מטמון הסכימה של PostgREST לא התעדכן מיד, וכל קריאת
    -- client.table("wikipedia_pages_shadow") מ-fetch_wikipedia.py נכשלה
    -- עם PGRST205 עד שהמטמון התרענן מעצמו (נצפה בפועל בריצה חיה - 2
    -- כשלים מתוך 5 ניסיונות מותרים, לא ערובה שזה תמיד יספיק).
    notify pgrst, 'reload schema';
    notify pgrst, 'reload config';
end;
$$;

revoke all on function promote_previous_to_shadow_and_truncate() from public;
grant execute on function promote_previous_to_shadow_and_truncate() to service_role;

-- =============================================================
-- תיקון הרשאות ל-4 ה-views הקיימים (כבר הוחל ידנית במסד החי - כלול
-- כאן שוב לצורך idempotency/תיעוד, כדי שסביבה חדשה תקבל את אותו מצב
-- בלי צעד ידני נוסף). לא נוגע במבנה ה-views עצמו, רק בהרשאות.
-- =============================================================
revoke all on report_possibly_deleted_source from anon, authenticated;
revoke all on report_tasks_to_handle from anon, authenticated;
revoke all on report_undocumented_import from anon, authenticated;

grant select on report_possibly_deleted_source to anon, authenticated;
grant select on report_tasks_to_handle to anon, authenticated;
grant select on report_undocumented_import to anon, authenticated;

-- report_missing_from_mechalol כבר היה מוגבל נכון (SELECT בלבד) -
-- לא נוגעים בו, רק לתיעוד שהוא כבר תקין.

notify pgrst, 'reload schema';
notify pgrst, 'reload config';

-- =============================================================
-- הצעה לביצוע עתידי (לא מבוצעת כאן בכוונה - שינוי רחב-היקף ברמת
-- הסכימה כולה, דורש אישור נפרד): ALTER DEFAULT PRIVILEGES לתפקיד
-- postgres בסכימת public כדי שכל טבלה/view חדשים ייווצרו מלכתחילה
-- עם SELECT-בלבד ל-anon/authenticated, במקום גישה מלאה - היה מונע
-- מראש גם את המלכוד בשלב 1 למעלה וגם את בעיית ההרשאות שהתגלתה
-- ב-3 מתוך 4 ה-views הקיימים. לא כלול כאן כי זו החלטה חד-פעמית
-- שמשפיעה על כל אובייקט עתידי בסכימה, לא רק על המראה.
