-- סכימת מסד הנתונים להשוואת ערכים בין ויקיפדיה העברית למכלול
-- להרצה חד-פעמית בעורך ה-SQL של סופרבייס, על טבלאות חדשות/ריקות.
--
-- ארכיטקטורה: wikipedia_pages ו-mechalol_pages מתרוקנות (TRUNCATE)
-- ומתמלאות מחדש במלואן בכל ריצה שבועית - אין מנגנון "דילוג על מה
-- שכבר נבדק" בקוד, כל שורה נבדקת מחדש כל שבוע.
--
-- id בשתי הטבלאות הוא ה-page_id האמיתי של הדף באתר המקור (לא
-- bigserial) - כלומר יציב וזהה בכל ריצה, גם אחרי TRUNCATE. אין טור
-- page_id נפרד - id הוא הוא ה-page_id. בזכות זה manual_matches (למטה)
-- שורדת ריקון בלי שום מיפוי נוסף.
--
-- manual_matches ו-blacklist_titles הן היחידות שלא מתרוקנות - תחזוקה
-- ידנית, למקרים שהאוטומציה לא פותרת לבד.

create table if not exists wikipedia_pages (
    id bigint primary key,  -- page_id בוויקיפדיה
    title text not null unique,
    checked_at timestamptz not null default now()
);

create table if not exists mechalol_pages (
    id bigint primary key,  -- page_id במכלול
    title text not null unique,

    -- נוצר במכלול / מיובא ומתועד / מיובא ללא תיעוד / ייבוא מחב"דפדיה /
    -- ייבוא מוויקישיבה / נשמר במכלול למרות מחיקה בוויקיפדיה / פוצל מתוכן ויקיפדי
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

    -- רק כאשר status = מיובא ומתועד, בפורמט YYYY-MM (נגזר מקטגוריית "עודכן לאחרונה ב-X")
    last_update_month text,

    -- מפתח זר לטבלת ויקיפדיה - id שם הוא בעצמו page_id בוויקיפדיה,
    -- אז השדה הזה הוא בפועל page_id של הדף המתאים בוויקיפדיה
    wikipedia_id bigint references wikipedia_pages(id),

    -- יובא מוויקיפדיה / כותרת זהה ללא קשר / ללא התאמה
    -- ברירת מחדל בלבד ל-INSERT חדש - fetch_mechalol.py לא שולח ערך זה,
    -- כדי לא לדרוס תוצאות התאמה שכבר חושבו ב-match.py.
    match_type text not null default 'ללא התאמה'
        check (match_type in ('יובא מוויקיפדיה', 'כותרת זהה ללא קשר', 'ללא התאמה')),

    -- הכותרת קיימת אך אין תוכן בדף (קטגוריית "ערכים לפתיחה")
    needs_attention boolean not null default false,

    -- תקציר מיובא מוויקיפדיה, לא ערך מלא (קטגוריית "ערכים מילוניים")
    is_dictionary_entry boolean not null default false,

    -- מקור השורה ודאי-ויקיפדי או לא-ידוע, ולא נמצאה לו התאמה בטבלת
    -- wikipedia_pages בריצה הנוכחית של match.py (סימון לבדיקה ידנית -
    -- מועמד ל-manual_matches אם זה חוזר על עצמו שבוע-שבוע). לא מסומן
    -- על שורות שמקורן ודאי לא-ויקיפדי (נוצר במכלול/חב"דפדיה/ויקישיבה/פוצל).
    maybe_deleted_from_wikipedia boolean not null default false,

    -- ההתאמה נמצאה דרך נרמול/תבנית מיון/manual_matches, לא כותרת זהה במדויק
    normalization_match boolean not null default false,

    -- שם הכלל/כללים שהובילו להתאמה (למשל 'כתיב_אלוהים+קרבן_לקורבן',
    -- 'תבנית_מיון', 'התאמה_ידנית')
    normalization_method text,

    -- הכותרת המנורמלת שנמצאה עבורה התאמה בוויקיפדיה
    title_normalized text,

    -- מקור השורה: created / translated / pirushon / chabadpedia /
    -- wikishiva / wikipedia_documented / missing_sort / unknown / ...
    source_type text not null default 'unknown'
);

-- התאמות ידניות - היחידה שלא מתרוקנת בריצה השבועית. למקרים שהאוטומציה
-- לא יכולה לפתור לבד (למשל כותרת שונה במכלול, והדף בוויקיפדיה נעול
-- לקריאה - כך שגם בדיקת תבנית המיון לא אפשרית). בכוונה בלי מפתח זר
-- אמיתי ל-wikipedia_pages/mechalol_pages - טבלאות אלה מתרוקנות מדי
-- שבוע, ומפתח זר היה חוסם את ה-TRUNCATE שלהן לגמרי.
create table if not exists manual_matches (
    id bigserial primary key,
    mechalol_page_id bigint not null unique,
    wikipedia_page_id bigint not null,
    reason text,
    added_at timestamptz not null default now()
);

-- רשימה שחורה - כותרות שבכוונה לא יובאו למכלול. לא מתרוקנת. תחזוקה
-- ידנית. בשימוש ב-views.sql (report_missing_from_mechalol) לסינון.
create table if not exists blacklist_titles (
    id bigserial primary key,
    title text not null unique,
    reason text,
    added_at timestamptz not null default now()
);

create index if not exists idx_mechalol_status on mechalol_pages(status);
create index if not exists idx_mechalol_match_type on mechalol_pages(match_type);
create index if not exists idx_mechalol_wikipedia_id on mechalol_pages(wikipedia_id);

-- קריאה מ-fetch_wikipedia.py (client.rpc) בתחילת כל ריצה טרייה, לפני
-- המילוי מחדש. שתי הטבלאות ביחד - יש מפתח זר ביניהן.
create or replace function truncate_pages()
returns void
language sql
as $$
    truncate table wikipedia_pages, mechalol_pages;
$$;
