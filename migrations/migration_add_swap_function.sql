-- migration_add_swap_function.sql
--
-- perform_atomic_swap() - שלב 5 בתכנון (mirror_architecture_design.md),
-- ארוז כפונקציית Postgres יחידה במקום סקריפט SQL רב-שלבי עם BEGIN/
-- COMMIT ידניים. הסיבה: קריאה דרך client.rpc(...) מפייתון (PostgREST)
-- כבר עוטפת את כל קריאת ה-RPC בטרנזקציה אחת משלה - BEGIN/COMMIT
-- מפורשים בגוף פונקציה רגילה הם שגיאת הרצה, לא נתמכים. האטומיות כאן
-- מגיעה מהעטיפה הטבעית של קריאת הפונקציה עצמה: אם ALTER TABLE כלשהו
-- נכשל (כולל lock_timeout שמוגדר בפנים) הפונקציה כולה זורקת שגיאה,
-- כל מה שבוצע עד כה בתוכה מתבטל אוטומטית, שום דבר לא נשאר במצב חלקי.
--
-- security definer: מריצה בהרשאות הבעלים (postgres, מי שיצר את
-- הפונקציה) ולא בהרשאות הקורא - כי service_role (התפקיד שקורא ל-RPC
-- הזה בפועל, ראו GRANT למטה) עוקף RLS אבל לא בהכרח מחזיק הרשאת ALTER
-- TABLE על הטבלאות בעצמו. set search_path קבוע כתקן אבטחה סטנדרטי
-- לפונקציית security definer (מונע חטיפת search_path על ידי הקורא).
create or replace function perform_atomic_swap()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
    r record;
begin
    -- ננעל רק לזמן קצר - אם יש שאילתה ארוכה פתוחה על אחת הטבלאות
    -- כרגע, עדיף שהקריאה כולה תיכשל מהר ותנוסה שוב (ראו לוגיקת
    -- הניסיון-החוזר ב-swap_shadow_to_active.py) מאשר שתיתקע בתור.
    perform set_config('lock_timeout', '5s', true);

    -- ללכוד את הגדרת כל view שתלוי בשתי הטבלאות, בזמן שהשם עדיין הפעיל
    -- (wikipedia_pages/mechalol_pages) - גילוי דינמי דרך pg_depend, כדי
    -- שview עתידי שיתווסף ולא נדע עליו כאן ייתפס אוטומטית, לא רק
    -- ארבעת אלה שקיימים היום. on commit drop - מתבטלת אוטומטית בסיום
    -- הטרנזקציה שעוטפת את קריאת ה-RPC הזו.
    create temporary table _view_defs_capture on commit drop as
    select distinct dependent_view.relname as view_name,
           pg_get_viewdef(dependent_view.oid) as view_definition
    from pg_depend
    join pg_rewrite on pg_depend.objid = pg_rewrite.oid
    join pg_class as dependent_view on pg_rewrite.ev_class = dependent_view.oid
    join pg_class as source_table on pg_depend.refobjid = source_table.oid
    where source_table.relname in ('wikipedia_pages', 'mechalol_pages')
      and dependent_view.relkind = 'v';

    -- ההחלפה עצמה. שם "_previous" ולא "_old" בכוונה - חלון rollback
    -- (ראו promote_previous_to_shadow_and_truncate ב-migration_add_
    -- mirror_tables.sql), לא מחיקה מיידית.
    alter table wikipedia_pages rename to wikipedia_pages_previous;
    alter table mechalol_pages rename to mechalol_pages_previous;
    alter table wikipedia_pages_shadow rename to wikipedia_pages;
    alter table mechalol_pages_shadow rename to mechalol_pages;

    -- בנייה מחדש אוטומטית של כל view שנלכד למעלה - קריטי (ראו "תגלית
    -- חשובה" בתכנון: view עוקב אחרי OID, לא אחרי שם, ובלי זה הוא
    -- ממשיך להצביע על הטבלה הישנה לנצח בשקט, בלי שגיאה). הרשאות
    -- ה-view עצמו נשמרות אוטומטית - create or replace על view קיים
    -- לא מאפס grants.
    for r in select view_name, view_definition from _view_defs_capture loop
        execute format('create or replace view %I as %s', r.view_name, r.view_definition);
    end loop;

    -- לרענן את מטמון הסכימה/ההרשאות של PostgREST. שימו לב: לפי הניסיון
    -- בפועל (ראו התיעוד ב-mirror_architecture_design.md), notify לבדו
    -- לא תמיד מספיק אמין לשינויי הרשאות על סופרבייס מנוהל - אם אחרי
    -- ריצה בפועל מתגלה שוב שגיאת הרשאה חולפת בגאדג'ט, יש לשקול גם
    -- קריאה ל-Management API של סופרבייס (Restart/Reload) כצעד נוסף
    -- ב-swap_shadow_to_active.py, לא רק כאן.
    notify pgrst, 'reload schema';
    notify pgrst, 'reload config';
end;
$$;

-- פונקציית DDL הרסנית - הרשאת הרצה לתפקיד service_role בלבד, לא
-- ל-anon/authenticated/public. security definer בלי revoke מפורש
-- מ-public היה משאיר את זה קרוא-להרצה לכל תפקיד כברירת מחדל.
-- תיקון אחרי בדיקה בפועל: revoke ... from public לא מספיק - יש
-- לנקוב במפורש גם ב-anon/authenticated (pg_default_acl מעניק להם
-- הרשאה נפרדת, לא רק ל-PUBLIC - אומת live).
revoke all on function perform_atomic_swap() from public, anon, authenticated;
grant execute on function perform_atomic_swap() to service_role;

-- =============================================================
-- revert_atomic_swap() - רולבק חירום בתוך חלון ה-_previous (שלב 6
-- בתכנון). אותו בלוק בדיוק כמו perform_atomic_swap, כולל אותה לוגיקת
-- גילוי-views דינמית ואותו lock_timeout - רק שם ההחלפה הפוך
-- (wikipedia_pages <-> wikipedia_pages_previous). לא לוגיקה חדשה.
-- שימו לב: זו לא מקדמת עותק "previous" חדש - זה תפקידה של
-- promote_previous_to_shadow_and_truncate בתחילת הסבב הבא, לא של
-- הרולבק. אחרי רולבק, אין יותר עותק _previous עד שסבב מלא חדש ירוץ.
create or replace function revert_atomic_swap()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
    r record;
begin
    perform set_config('lock_timeout', '5s', true);

    create temporary table _view_defs_capture_revert on commit drop as
    select distinct dependent_view.relname as view_name,
           pg_get_viewdef(dependent_view.oid) as view_definition
    from pg_depend
    join pg_rewrite on pg_depend.objid = pg_rewrite.oid
    join pg_class as dependent_view on pg_rewrite.ev_class = dependent_view.oid
    join pg_class as source_table on pg_depend.refobjid = source_table.oid
    where source_table.relname in ('wikipedia_pages', 'mechalol_pages')
      and dependent_view.relkind = 'v';

    -- שימו לב: בניגוד ל-perform_atomic_swap (ששם היעד תמיד שונה בכל
    -- שלב, אין התנגשות), כאן זו החלפה של שני שמות זה בזה ממש
    -- (wikipedia_pages <-> wikipedia_pages_previous) - מכנית, ALTER
    -- TABLE RENAME לא מאפשר שם יעד שכבר תפוס, אז נדרש שם ביניים זמני.
    -- בסיום, הטבלה שהייתה "פעילה-אבל-שגויה" מסתיימת תחת השם
    -- wikipedia_pages_previous בדיוק כמו בזרימה הרגילה - חלון rollback
    -- נוסף ידני-בלבד, לא אוטומטי (promote_previous_to_shadow_and_truncate
    -- בסבב הבא ירוקן/ידרוס אותה בבוא העת, כמו כל _previous אחר).
    alter table wikipedia_pages rename to _revert_swap_temp_wikipedia;
    alter table mechalol_pages rename to _revert_swap_temp_mechalol;
    alter table wikipedia_pages_previous rename to wikipedia_pages;
    alter table mechalol_pages_previous rename to mechalol_pages;
    alter table _revert_swap_temp_wikipedia rename to wikipedia_pages_previous;
    alter table _revert_swap_temp_mechalol rename to mechalol_pages_previous;

    for r in select view_name, view_definition from _view_defs_capture_revert loop
        execute format('create or replace view %I as %s', r.view_name, r.view_definition);
    end loop;

    notify pgrst, 'reload schema';
    notify pgrst, 'reload config';
end;
$$;

revoke all on function revert_atomic_swap() from public, anon, authenticated;
grant execute on function revert_atomic_swap() to service_role;

