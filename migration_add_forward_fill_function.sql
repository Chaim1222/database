-- migration_add_forward_fill_function.sql
--
-- forward_fill_enrichment_shadow() - שלב 3 בתכנון (mirror_architecture_
-- design.md), ארוז כפונקציית RPC כדי שיהיה ניתן לקרוא לו מ-
-- forward_fill_enrichment.py (client.rpc), באותה סיבה בדיוק כמו
-- perform_atomic_swap: אין דרך להריץ UPDATE גולמי דרך PostgREST חוץ
-- מקריאה לפונקציה מוגדרת מראש.
--
-- לא security definer בכוונה - זה לא DDL הרסני כמו ההחלפה, רק UPDATE
-- רגיל על wikipedia_pages_shadow, וה-GRANT הרגיל ל-service_role
-- (migration_add_mirror_tables.sql, שלב 1) כבר כולל UPDATE על הטבלה
-- הזו - מספיק כדי שהפונקציה תרוץ בהרשאות הקורא (service_role) בלי
-- צורך בהרשאות בעלים מורחבות.
create or replace function forward_fill_enrichment_shadow()
returns void
language sql
set search_path = public
as $$
    -- תיקון אחרי אימות מול המסד החי (execute_sql, לא רק schema.sql):
    -- created_at_checked ו-easy_import_checked *כן* קיימות בפועל
    -- (boolean not null default false) - הן פשוט לא מתועדות ב-
    -- schema.sql, בדיוק כמו recompute_missing_flag_scoped שכבר תועד
    -- כפער דומה בעבר. בלעדיהן, אחרי כל החלפה כל השורות היו חוזרות
    -- ל-false (ברירת המחדל), וסקריפטי ההעשרה (fetch_wikipedia_
    -- created_at.py, fetch_easy_import_candidates.py) היו בודקים
    -- מחדש מאפס שורות שכבר נבדקו - בדיוק ההפך ממטרת השלב הזה.
    update wikipedia_pages_shadow as new
    set wikidata_desc = old.wikidata_desc,
        created_at = old.created_at,
        created_at_checked = old.created_at_checked,
        easy_import_length = old.easy_import_length,
        easy_import_has_images = old.easy_import_has_images,
        problematic_words_clean = old.problematic_words_clean,
        easy_import_checked = old.easy_import_checked,
        mechalol_redirect_exists = old.mechalol_redirect_exists
    from wikipedia_pages as old
    where new.id = old.id;
$$;

-- תיקון אחרי בדיקה בפועל במסד: revoke ... from public לא מספיק -
-- pg_default_acl מעניק הרשאה מפורשת גם ל-anon/authenticated בנפרד,
-- לא רק ל-PUBLIC. יש לנקוב בשמם במפורש (אומת על recompute_missing_
-- flag_shadow/promote_previous_to_shadow_and_truncate - ראו
-- migration_add_mirror_tables.sql, שם זה תוקן אחרי שהתגלה live).
revoke all on function forward_fill_enrichment_shadow() from public, anon, authenticated;
grant execute on function forward_fill_enrichment_shadow() to service_role;
