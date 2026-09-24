-- מיגרציה: תיקוני סקירה (2026-09-24). חובה להריץ *לפני* מיזוג הקוד
-- שמגיע איתה - match.py --scoped קורא ל-recompute_missing_flag_by_titles
-- (סעיף 3), שלא קיימת לפני המיגרציה הזו.
--
-- כל הסעיפים idempotent (אפשר להריץ שוב). לא להריץ בזמן שהעדכון הלילי
-- או הסנכרון השבועי רצים - סעיף 5 יוצר אינדקס על wikipedia_pages
-- (נעילת כתיבה של שניות בודדות).

-- ---------------------------------------------------------------------------
-- 1. אבטחה: truncate_temp_pages() הייתה ניתנת להרצה ע"י anon/authenticated
-- ---------------------------------------------------------------------------
-- migration_finalize_temp_pages_naming.sql עשתה revoke רק מ-public - בדיוק
-- הטעות שמתוארת ב-migration_add_swap_function.sql: ה-GRANT ל-anon/
-- authenticated מגיע מ-pg_default_acl של סופרבייס, לא דרך public.
revoke all on function truncate_temp_pages() from public, anon, authenticated;
grant execute on function truncate_temp_pages() to service_role;

-- שורש הבעיה: ברירת המחדל של סופרבייס בסכמה public נותנת ל-anon
-- ול-authenticated הרשאות מלאות על כל טבלה/view/פונקציה/sequence *חדשים*.
-- כך קיבלו בעבר ה-views הרשאות INSERT/UPDATE/DELETE (ראו views.sql), וכך
-- נפתחה truncate_temp_pages. מעכשיו אובייקט חדש שנוצר ע"י postgres מקבל
-- רק SELECT (טבלאות/views - RLS עדיין חל) ובלי EXECUTE/sequence; כל
-- הרשאה נוספת צריכה GRANT מפורש במיגרציה שיוצרת אותו.
alter default privileges for role postgres revoke execute on functions from public;
alter default privileges for role postgres in schema public revoke execute on functions from anon, authenticated;
alter default privileges for role postgres in schema public revoke all on tables from anon, authenticated;
alter default privileges for role postgres in schema public grant select on tables to anon, authenticated;
alter default privileges for role postgres in schema public revoke all on sequences from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. manual_matches: הרשאת כתיבה רק למנהלים מורשים, לא לכל מחובר
-- ---------------------------------------------------------------------------
-- migration_add_manual_matches_auth_policy.sql הניחה "לא הרשמה עצמית
-- פתוחה", ולכן נתנה לכל authenticated הרשאה מלאה (using(true)). את
-- ההנחה הזו לא ניתן לאמת מתוך המסד, ומפתח ה-anon פומבי בקוד הגאדג'ט -
-- אם ההרשמה פתוחה, כל אחד יכול להירשם ולמחוק התאמות ידניות. מעכשיו
-- ההרשאה תלויה ברשימה מפורשת, בלי קשר להגדרת ההרשמה.
create table if not exists manual_match_admins (
    user_id uuid primary key references auth.users (id) on delete cascade,
    added_at timestamptz not null default now()
);
alter table manual_match_admins enable row level security;
revoke all on manual_match_admins from anon, authenticated;

-- security definer: RLS על manual_match_admins חוסם את המשתמש עצמו מלקרוא
-- אותה, ולכן הבדיקה חייבת לרוץ בהרשאות הבעלים.
create or replace function is_manual_match_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
    select exists (select 1 from manual_match_admins where user_id = auth.uid());
$$;
revoke all on function is_manual_match_admin() from public, anon, authenticated;
grant execute on function is_manual_match_admin() to authenticated;

drop policy if exists "authenticated יכול לנהל התאמות ידניות" on manual_matches;
drop policy if exists "מנהלים מורשים מנהלים התאמות ידניות" on manual_matches;
create policy "מנהלים מורשים מנהלים התאמות ידניות" on manual_matches
    for all
    to authenticated
    using (is_manual_match_admin())
    with check (is_manual_match_admin());

-- להוספת מנהל (פעם אחת, אחרי שמוודאים שזה החשבון הנכון):
--   insert into manual_match_admins (user_id)
--   select id from auth.users where email = '<האימייל של המנהל>';

-- ---------------------------------------------------------------------------
-- 3. "חסר במכלול" לפי כותרות - לעדכון הלילי
-- ---------------------------------------------------------------------------
-- is_missing תלוי גם בכותרת זהה ובנרמול "הרב/רבי", לא רק ב-wikipedia_id.
-- recompute_missing_flag_scoped(ids) מכסה רק דפים לפי id; כשכותרת במכלול
-- נוספה/התפנתה (יצירה, מחיקה, שינוי שם) צריך לחשב מחדש את דפי הוויקיפדיה
-- עם אותה כותרת או אותה כותרת מנורמלת. ראו match.py, שלב 2.
create or replace function recompute_missing_flag_by_titles(titles text[])
returns void
language sql
set search_path = public
as $$
    update wikipedia_pages w
    set is_missing = not exists (
            select 1 from mechalol_pages m
            where m.wikipedia_id = w.id
               or m.title = w.title
               or normalize_person_title(m.title) = normalize_person_title(w.title)
        ),
        missing_override_reason = case
            when exists (select 1 from mechalol_pages m where m.wikipedia_id = w.id or m.title = w.title)
                then null
            when exists (select 1 from mechalol_pages m where normalize_person_title(m.title) = normalize_person_title(w.title))
                then 'rav_prefix_normalization'
            else null
        end
    where w.title = any(titles)
       or normalize_person_title(w.title) = any(array(select normalize_person_title(t) from unnest(titles) as t));
$$;
revoke all on function recompute_missing_flag_by_titles(text[]) from public, anon, authenticated;
grant execute on function recompute_missing_flag_by_titles(text[]) to service_role;

-- search_path קבוע לפונקציות שחסר להן (אזהרת advisor). בכוונה לא
-- normalize_person_title: SET על פונקציית sql מונע inlining שלה, והיא
-- נקראת פעם לכל שורה ב-recompute_missing_flag המלא.
alter function recompute_missing_flag() set search_path = public;
alter function recompute_missing_flag_scoped(bigint[]) set search_path = public;
alter function truncate_mechalol_pages() set search_path = public;
alter function truncate_wikipedia_pages() set search_path = public;

-- ---------------------------------------------------------------------------
-- 4. פונקציות שאריות - לא בשימוש, ושלוש מהן כבר לא עובדות
-- ---------------------------------------------------------------------------
-- link_manual_match/unlink_manual_match: כותבות לעמודה manual_match שכבר
--   לא קיימת ובערכי match_type ישנים ('מיובא', 'ללא_התאמה') - נכשלות.
--   הוחלפו ע"י הטבלה manual_matches.
-- update_import_suspect_verification: מעדכנת טבלה mechalol_import_suspects
--   שלא קיימת.
-- truncate_pages(): מרוקנת את שתי הטבלאות הפעילות יחד. הוחלפה ב-
--   migration_split_truncate_functions.sql, שהשאירה אותה "למחיקה ידנית
--   בהמשך". אף קוד לא קורא לה.
drop function if exists link_manual_match(text, text);
drop function if exists unlink_manual_match(text);
drop function if exists update_import_suspect_verification(bigint, text, text, bigint, text, text, boolean, text, text);
drop function if exists truncate_pages();

-- ---------------------------------------------------------------------------
-- 5. אינדקסים
-- ---------------------------------------------------------------------------
-- כפילות מלאה של האילוץ הייחודי blacklist_titles_title_key (אותה עמודה).
-- לא מופיע באף קובץ בריפו - נוצר ידנית בעבר.
drop index if exists idx_blacklist_titles_title;

-- שני העותקים (פעיל/זמני) של כל טבלה היו עם סט אינדקסים שונה, וכל
-- החלפה שבועית הפכה ביניהם - כך שבשבוע אחד לטבלה הפעילה היה אינדקס
-- ובשבוע הבא לא. מיישרים את שני העותקים:
-- - match_type על mechalol: 3 ערכים בלבד, 99% מהשורות בערך אחד - אינדקס
--   שהמתכנן כמעט לא משתמש בו (21 סריקות מאז שנוצר). כבר היום חצי מהזמן
--   הטבלה הפעילה בלעדיו. מסירים משניהם.
-- - normalize_person_title(title) על wikipedia: נדרש ל-recompute_missing_
--   flag_by_titles (סעיף 3). יוצרים בשני העותקים. השם חייב להתחיל
--   ב-"<טבלה>_" כדי ש-perform_atomic_swap ישנה את שמו נכון בהחלפה.
drop index if exists mechalol_pages_match_type_idx;
drop index if exists mechalol_pages_temp_match_type_idx;

do $$
begin
    if not exists (
        select 1 from pg_indexes
        where schemaname = 'public' and tablename = 'wikipedia_pages'
          and indexdef like '%normalize_person_title(title)%'
    ) then
        create index wikipedia_pages_normalize_person_title_idx
            on wikipedia_pages (normalize_person_title(title));
    end if;

    if not exists (
        select 1 from pg_indexes
        where schemaname = 'public' and tablename = 'wikipedia_pages_temp'
          and indexdef like '%normalize_person_title(title)%'
    ) then
        create index wikipedia_pages_temp_normalize_person_title_idx
            on wikipedia_pages_temp (normalize_person_title(title));
    end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. views בהרשאות הקורא (security_invoker) במקום בהרשאות היוצר
-- ---------------------------------------------------------------------------
-- views.sql תיעד את זה כ"ידוע, לא תוקן". הסיכון בפועל: ה-views כאן הן
-- SELECT פשוט על טבלה אחת, ולכן Postgres מאפשר לעדכן דרכן. הן רצות
-- בהרשאות postgres ולכן עוקפות RLS - כך שאם אי-פעם יינתן להן UPDATE
-- (כמו שכבר קרה, ראו views.sql), anon יכול לשנות את mechalol_pages דרכן.
--
-- לפני המעבר צריך ש-anon יוכל לקרוא בעצמו את כל מה שה-views קוראות:
-- - blacklist_titles: RLS פעיל בלי אף policy - בלי policy קריאה, תנאי
--   ה-not exists ב-report_missing_from_mechalol היה רואה טבלה ריקה, וכל
--   2,233 הכותרות הנעולות היו חוזרות לדוח.
-- - טבלאות הדפים: policy הקריאה קיים ל-anon בלבד; מוסיפים authenticated
--   כדי שמשתמש מחובר יקבל את אותן תוצאות.
drop policy if exists "קריאה ציבורית" on blacklist_titles;
create policy "קריאה ציבורית" on blacklist_titles
    for select to anon, authenticated using (true);
grant select on blacklist_titles to anon, authenticated;

alter policy "קריאה ציבורית" on wikipedia_pages to anon, authenticated;
alter policy "קריאה ציבורית" on wikipedia_pages_temp to anon, authenticated;
alter policy "קריאה ציבורית" on mechalol_pages to anon, authenticated;
alter policy "קריאה ציבורית" on mechalol_pages_temp to anon, authenticated;

-- perform_atomic_swap בונה מחדש את ה-views בכל החלפה עם create or replace
-- view - שמאפס את אפשרויות ה-view (reloptions) אם לא מציינים אותן. בלי
-- התיקון הזה security_invoker היה נעלם בהחלפה השבועית הראשונה. גוף
-- הפונקציה זהה לגרסה הקודמת חוץ משני המקומות המסומנים.
create or replace function perform_atomic_swap()
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
    r record;
    old_prefix text;
    new_prefix text;
    tbl text;
    n int;
begin
    perform set_config('lock_timeout', '5s', true);

    create temporary table _view_defs_capture on commit drop as
    select distinct dependent_view.relname as view_name,
           pg_get_viewdef(dependent_view.oid) as view_definition,
           dependent_view.reloptions as view_options  -- חדש: שמירת אפשרויות ה-view
    from pg_depend
    join pg_rewrite on pg_depend.objid = pg_rewrite.oid
    join pg_class as dependent_view on pg_rewrite.ev_class = dependent_view.oid
    join pg_class as source_table on pg_depend.refobjid = source_table.oid
    where source_table.relname in ('wikipedia_pages', 'mechalol_pages')
      and dependent_view.relkind = 'v';

    alter table wikipedia_pages rename to _swap_holding_wikipedia;
    alter table mechalol_pages rename to _swap_holding_mechalol;
    alter table wikipedia_pages_temp rename to wikipedia_pages;
    alter table mechalol_pages_temp rename to mechalol_pages;
    alter table _swap_holding_wikipedia rename to wikipedia_pages_temp;
    alter table _swap_holding_mechalol rename to mechalol_pages_temp;

    create temporary table _swap_rename_plan (
        seq int, holding_name text, final_name text, orig_name text,
        on_table text, is_constraint boolean
    ) on commit drop;

    foreach tbl in array array['wikipedia_pages', 'mechalol_pages']::text[]
    loop
        old_prefix := tbl || '_temp_';
        new_prefix := tbl || '_';
        n := (select coalesce(max(seq), 0) from _swap_rename_plan);

        for r in
            select conname from pg_constraint where conrelid = tbl::regclass and conname like old_prefix || '%'
            union all
            select conname from pg_constraint where conrelid = (tbl||'_temp')::regclass
                and conname like new_prefix || '%' and conname not like old_prefix || '%'
        loop
            n := n + 1;
            insert into _swap_rename_plan values (n, '_swap_tmp_' || n, null, r.conname, null, true);
        end loop;

        for r in
            select i.tablename, i.indexname from pg_indexes i
            where i.schemaname = 'public' and i.tablename = tbl and i.indexname like old_prefix || '%'
              and not exists (select 1 from pg_constraint c where c.conrelid = tbl::regclass and c.conname = i.indexname)
            union all
            select i.tablename, i.indexname from pg_indexes i
            where i.schemaname = 'public' and i.tablename = tbl||'_temp'
              and i.indexname like new_prefix || '%' and i.indexname not like old_prefix || '%'
              and not exists (select 1 from pg_constraint c where c.conrelid = (tbl||'_temp')::regclass and c.conname = i.indexname)
        loop
            n := n + 1;
            insert into _swap_rename_plan values (n, '_swap_tmp_' || n, null, r.indexname, r.tablename, false);
        end loop;

        update _swap_rename_plan p set on_table = c.conrelid::regclass::text
            from pg_constraint c where p.is_constraint and p.on_table is null and c.conname = p.orig_name;

        update _swap_rename_plan set final_name =
            case when on_table = tbl then new_prefix || substring(orig_name from length(old_prefix)+1)
                 else old_prefix || substring(orig_name from length(new_prefix)+1) end
            where final_name is null and (on_table = tbl or on_table = tbl || '_temp');
    end loop;

    for r in select * from _swap_rename_plan loop
        if r.is_constraint then
            execute format('alter table %I rename constraint %I to %I', r.on_table, r.orig_name, r.holding_name);
        else
            execute format('alter index %I rename to %I', r.orig_name, r.holding_name);
        end if;
    end loop;

    for r in select * from _swap_rename_plan loop
        if r.is_constraint then
            execute format('alter table %I rename constraint %I to %I', r.on_table, r.holding_name, r.final_name);
        else
            execute format('alter index %I rename to %I', r.holding_name, r.final_name);
        end if;
    end loop;

    -- חדש: משחזרים גם את אפשרויות ה-view (למשל security_invoker)
    for r in select view_name, view_definition, view_options from _view_defs_capture loop
        execute format(
            'create or replace view %I %s as %s',
            r.view_name,
            case when r.view_options is null then ''
                 else 'with (' || array_to_string(r.view_options, ', ') || ')' end,
            r.view_definition
        );
    end loop;

    notify pgrst, 'reload schema';
    notify pgrst, 'reload config';
end;
$function$;
revoke all on function perform_atomic_swap() from public, anon, authenticated;
grant execute on function perform_atomic_swap() to service_role;

alter view report_possibly_deleted_source set (security_invoker = true);
alter view report_undocumented_import set (security_invoker = true);
alter view report_missing_from_mechalol set (security_invoker = true);
alter view report_rav_prefix_normalization set (security_invoker = true);

-- ---------------------------------------------------------------------------
-- 7. report_tasks_to_handle: הפרדת סוגי משימות מעורבים
-- ---------------------------------------------------------------------------
-- קודם:
-- - "לבדוק מחיקה/השוואה" ערבב שני מצבים שונים: תבנית מיון שמציינת שם
--   שכבר לא קיים בוויקיפדיה (בדרך כלל שינוי שם שם - מתקנים את התבנית),
--   מול דף בלי שום מקביל בוויקיפדיה (בודקים אם נמחק).
-- - "סטטוס לא ברור" ערבב דפים שהמכלול עצמו מסמן כחסרי תבנית מיון
--   (missing_sort - הפעולה ידועה: להוסיף תבנית) עם דפים בלי שום סימון.
-- - "שם בתבנית לא אומת" כלל 18 דפים בסטטוס "נשמר במכלול למרות מחיקה
--   בוויקיפדיה" - שם תבנית שמצביעה על דף שנמחק היא בדיוק המצב הצפוי.
-- עמודות ה-view לא השתנו (רק ערכי task_type וסינון), כדי שה-replace
-- יעבור בלי drop.
create or replace view report_tasks_to_handle with (security_invoker = true) as
select
    id,
    title,
    status,
    source_type,
    wikipedia_id,
    match_type,
    case
        when template_referenced_title is not null
             and status <> 'נשמר במכלול למרות מחיקה בוויקיפדיה'
            then 'שם בתבנית המיון לא קיים בוויקיפדיה'
        when maybe_deleted_from_wikipedia = true
            then 'לא נמצא מקביל בוויקיפדיה'
        when template_check_access_denied_at is not null
            then 'דף נעול - לא ניתן לאמת'
        when source_type = 'missing_sort'
            then 'חסרה תבנית מיון'
        else 'מקור לא ידוע'
    end as task_type
from mechalol_pages
where needs_attention = false
  and is_dictionary_entry = false
  and (
    maybe_deleted_from_wikipedia = true
    or status = 'מיובא ללא תיעוד'
    or (template_referenced_title is not null and status <> 'נשמר במכלול למרות מחיקה בוויקיפדיה')
    or template_check_access_denied_at is not null
  )
order by task_type, title;

revoke all on report_tasks_to_handle from anon, authenticated;
grant select on report_tasks_to_handle to anon, authenticated;

notify pgrst, 'reload schema';
