-- migration_add_analyze_function.sql
--
-- analyze_pages_tables(table_suffix) - תיקון נדרש אחרי תקלה אמיתית
-- (2026-09): forward_fill_enrichment_shadow() נתקע 10+ דקות בתוכנית
-- שאילתה גרועה (nested loop במקום merge join) על wikipedia_pages_shadow
-- טרי-אחרי-מילוי-מלא, כי לטבלה לא היו סטטיסטיקות מעודכנות (ANALYZE
-- לא רץ עליה מעולם - autovacuum עוד לא הספיק להגיע אליה). ANALYZE
-- ידני תיקן את התוכנית מיידית. הפונקציה הזו מבצעת את זה אוטומטית,
-- כשלב קבוע בזרימה - לא משהו שדורש התערבות ידנית בפעם הבאה.
--
-- מקבלת את הסיומת כפרמטר (לא שם טבלה מלא) כדי שתעבוד גם על הטבלאות
-- הפעילות (table_suffix='') וגם על המראה (table_suffix='_shadow') -
-- אותה פונקציה אחת, לא שתיים. format(%I) עם concatenation במקום
-- interpolation ישירה של הפרמטר - מונע SQL injection גם אם הקלט
-- אי-פעם יגיע ממקור פחות סגור מ-table_names.py.
--
-- security definer: ANALYZE דורש בעלות על הטבלה (או הרשאת MAINTAIN,
-- מ-Postgres 17) - service_role (הקורא בפועל) לא הבעלים
-- (הטבלאות בבעלות postgres), ולא קיבל GRANT MAINTAIN מפורש. אותו טעם
-- בדיוק כמו promote_previous_to_shadow_and_truncate/perform_atomic_swap.
create or replace function analyze_pages_tables(table_suffix text default '')
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
    -- הגנה נוספת: מגבילה את table_suffix לערכים הידועים בלבד, למרות
    -- ש-format(%I) כבר חוסם SQL injection קלאסי - זה עדיין מונע קריאה
    -- ל-ANALYZE על טבלה שרירותית כלשהי דרך פרמטר שנשלח בטעות/בזדון,
    -- כי הפונקציה security definer וה-EXECUTE שלה נתון לשירות בלבד.
    if table_suffix not in ('', '_shadow') then
        raise exception 'table_suffix לא מוכר: %', table_suffix;
    end if;

    execute format('analyze %I', 'wikipedia_pages' || table_suffix);
    execute format('analyze %I', 'mechalol_pages' || table_suffix);
end;
$$;

revoke all on function analyze_pages_tables(text) from public, anon, authenticated;
grant execute on function analyze_pages_tables(text) to service_role;
