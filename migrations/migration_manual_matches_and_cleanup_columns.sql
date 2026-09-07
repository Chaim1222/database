-- מיגרציה חד-פעמית להרצה בעורך ה-SQL של סופרבייס, על הסביבה הקיימת.
-- מבצעת שינוי מבנה: id בשתי הטבלאות הופך להיות ה-page_id האמיתי (לא
-- bigserial), במקום טור page_id נפרד. הרסני לנתונים הקיימים ב-
-- wikipedia_pages/mechalol_pages (הם ממילא עומדים להתרוקן ולהתמלא
-- מחדש בריצה השבועית הבאה) - לא נוגע ב-manual_matches/blacklist_titles
-- אם כבר קיימות.
--
-- אזהרה חשובה, לפני שמריצים: בכוונה *בלי* CASCADE על ה-DROP TABLE
-- למטה. יש לך בסופרבייס טבלאות/views נוספים שבנית בעצמך ואין לי שום
-- נראות אליהם (לפי מה שראיתי בעבר: mechalol_suspects,
-- mechalol_import_suspects, mechalol_duplicate_wikipedia,
-- mechalol_pages_backup, report_coincidental_..., report_dictionary_...,
-- report_unique_to_... ואולי עוד). אם מישהו מהם תלוי (view) או מצביע
-- (מפתח זר) אל wikipedia_pages/mechalol_pages - ה-DROP TABLE למטה
-- ייכשל עם שגיאה ברורה שאומרת בדיוק מי חוסם, ולא יקרה שום נזק. **לפני
-- שממשיכים בהרצה, כדאי לבדוק בעצמך** (או לשלוח לי) את ההגדרה של כל
-- אחד מהאובייקטים האלה, כדי לדעת אם צריך לגבות/לתקן אותם קודם.

-- 1. מחיקת ה-views שאני יודע שתלויים במבנה הישן (בניתי אותם בעצמי).
drop view if exists report_confirmed_deleted_from_wikipedia;
drop view if exists report_title_changed_since_match;
drop view if exists report_possibly_deleted_source;
drop view if exists report_undocumented_import;
drop view if exists report_tasks_to_handle;
drop view if exists report_missing_from_mechalol;
drop view if exists report_missing_in_mechalol;
drop view if exists report_needs_attention;

-- 2. מחיקת הטבלאות הישנות - בלי CASCADE בכוונה (ראו אזהרה למעלה).
--    אם זה נכשל עם שגיאת "cannot drop ... because other objects depend
--    on it" - זה סימן שיש עוד משהו תלוי שלא ידעתי עליו. תעצור, תבדוק
--    מה זה, ותחליט (למחוק את זה קודם / לגבות / לשלוח לי לבדיקה) -
--    אל תוסיף CASCADE בעצמך בלי לדעת מה זה בדיוק מוחק.
drop table if exists mechalol_pages;
drop table if exists wikipedia_pages;

-- 3. יצירה מחדש, במבנה החדש - id הוא page_id האמיתי בכל טבלה
create table wikipedia_pages (
    id bigint primary key,
    title text not null unique,
    checked_at timestamptz not null default now()
);

create table mechalol_pages (
    id bigint primary key,
    title text not null unique,
    status text not null check (
        status in (
            'נוצר במכלול',
            'מיובא ומתועד',
            'מיובא ללא תיעוד',
            'ייבוא מחב"דפדיה',
            'ייבוא מוויקישיבה',
            'נשמר במכלול למרות מחיקה בוויקיפדיה',
            'פוצל מתוכן ויקיפדי'
        )
    ),
    last_update_month text,
    wikipedia_id bigint references wikipedia_pages(id),
    match_type text not null default 'ללא התאמה'
        check (match_type in ('יובא מוויקיפדיה', 'כותרת זהה ללא קשר', 'ללא התאמה')),
    needs_attention boolean not null default false,
    is_dictionary_entry boolean not null default false,
    maybe_deleted_from_wikipedia boolean not null default false,
    normalization_match boolean not null default false,
    normalization_method text,
    title_normalized text,
    source_type text not null default 'unknown'
);

create index idx_mechalol_status on mechalol_pages(status);
create index idx_mechalol_match_type on mechalol_pages(match_type);
create index idx_mechalol_wikipedia_id on mechalol_pages(wikipedia_id);

-- קריאה מ-fetch_wikipedia.py (client.rpc) בתחילת כל ריצה טרייה
create or replace function truncate_pages()
returns void
language sql
as $$
    truncate table wikipedia_pages, mechalol_pages;
$$;

-- 4. טבלאות שלא מתרוקנות - נוצרות רק אם עוד לא קיימות
create table if not exists manual_matches (
    id bigserial primary key,
    mechalol_page_id bigint not null unique,
    wikipedia_page_id bigint not null,
    reason text,
    added_at timestamptz not null default now()
);

create table if not exists blacklist_titles (
    id bigserial primary key,
    title text not null unique,
    reason text,
    added_at timestamptz not null default now()
);
