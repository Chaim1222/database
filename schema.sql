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
    checked_at timestamptz not null default now(),

    -- תיאור קצר מוויקינתונים, נשלף ונשמר על ידי fetch_wikidata_descriptions.py
    -- (סקריפט עצמאי, לא חלק מ-weekly_update.yml) עבור השורות שמופיעות
    -- בדוח report_missing_from_mechalol בלבד - ראו migration_add_wikidata_desc.sql
    wikidata_desc text,

    -- תאריך יצירת הערך בוויקיפדיה (חותמת הזמן של הגרסה הראשונה שלו),
    -- נשלף ונשמר על ידי fetch_wikipedia.py כחלק מאותה בקשת API של
    -- allpages (generator=allpages + prop=revisions&rvdir=newer) - בלי
    -- סבב בקשות נפרד. nullable - יכול לחסור אם לגרסה הראשונה אין
    -- חותמת זמן זמינה (מקרה חריג). ראו migration_add_wikipedia_created_at.sql.
    created_at timestamptz,

    -- שלוש בדיקות "קלות ייבוא", נשלפות ונשמרות על ידי
    -- fetch_easy_import_candidates.py (סקריפט עצמאי, לא חלק
    -- מ-weekly_update.yml) עבור השורות שמופיעות בדוח
    -- report_missing_from_mechalol בלבד - ראו migration_add_easy_import_columns.sql.
    -- problematic_words_clean בוליאני יחיד - ראו problematic_words.py.
    easy_import_length bigint,
    easy_import_has_images boolean,
    problematic_words_clean boolean,

    -- true אם קיימת הפניה (redirect) במכלול תחת כותרת זהה בדיוק לזו -
    -- כלומר הכותרת "לא ריקה" במכלול, גם אם אין שם ערך תוכן מלא. false
    -- אם נבדק ונמצא שאין שם כלום (לא ערך ולא הפניה). נשלף ונשמר ידנית
    -- על ידי check_missing_redirects.py (סקריפט עצמאי, לא חלק
    -- מ-weekly_update.yml) עבור השורות שמופיעות בדוח
    -- report_missing_from_mechalol בלבד - כמו wikidata_desc/easy_import
    -- למעלה. nullable בכוונה: NULL = טרם נבדק בכלל (שונה מ-false, שהוא
    -- תוצאת בדיקה בפועל). ראו migration_add_mechalol_redirect_flag.sql.
    mechalol_redirect_exists boolean,

    -- true אם אין אף שורה ב-mechalol_pages שמצביעה לכאן (wikipedia_id).
    -- מחושב מחדש בסוף כל ריצה של match.py (recompute_missing_flag,
    -- למטה) - לא חי, לא מתעדכן אוטומטית בין ריצה לריצה. הוחלף מהצטרפות
    -- (join) חיה של שתי הטבלאות ב-report_missing_from_mechalol, שהייתה
    -- לוקחת ~3.7 שניות ועפה על statement_timeout של תפקיד ה-anon -
    -- ראו migration_add_is_missing_flag.sql.
    is_missing boolean not null default false
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

    -- page_id בוויקיפדיה, כשהכותרת נחסמה ליצירה במכלול (זוהה אוטומטית
    -- על ידי check_missing_locked.py). nullable - רשומות שנוספו ידנית
    -- לא בהכרח כוללות אותו. בכוונה בלי מפתח זר אמיתי ל-wikipedia_pages -
    -- אותו טעם בדיוק שבגללו manual_matches.wikipedia_page_id למעלה גם
    -- הוא בלי מפתח זר אמיתי (הטבלה מתרוקנת מדי שבוע).
    wikipedia_id bigint,

    added_at timestamptz not null default now()
);

create index if not exists idx_mechalol_status on mechalol_pages(status);
create index if not exists idx_mechalol_match_type on mechalol_pages(match_type);
create index if not exists idx_mechalol_wikipedia_id on mechalol_pages(wikipedia_id);
create index if not exists idx_wikipedia_is_missing on wikipedia_pages(is_missing) where is_missing;

-- קריאות מ-fetch_mechalol.py ו-fetch_wikipedia.py (client.rpc), כל אחת
-- בתחילת ריצה טרייה משלה, ממש לפני המילוי מחדש - שתי פונקציות נפרדות
-- (לא אחת משותפת) בכוונה, כדי שכישלון של אחד הסקריפטים לא יגרום לריקון
-- הטבלה של השני.
--
-- הסדר קריטי בגלל המפתח הזר mechalol_pages.wikipedia_id -> wikipedia_pages.id:
-- תמיד יש לרוקן קודם את mechalol_pages (הטבלה המפנה/child) ורק אחר כך
-- את wikipedia_pages (הטבלה המופנית/parent). ריקון wikipedia_pages
-- לבד בזמן שיש עדיין שורות ב-mechalol_pages שמפנות לשורות שלה נכשל
-- עם שגיאת מפתח זר (TRUNCATE לא מרשה את זה, בניגוד ל-DELETE).
-- fetch_mechalol.py לא שולח wikipedia_id ב-INSERT שלו (הוא נקבע רק
-- ב-match.py בסוף השרשרת), כך שמיד אחרי ריצה מוצלחת של
-- truncate_mechalol_pages()+מילוי מחדש, כל wikipedia_id הוא NULL -
-- ולכן truncate_wikipedia_pages() בטוח לגמרי גם אם הוא רץ מיד אחרי.
-- ראו סדר השלבים ב-weekly_update.yml (מכלול תמיד לפני ויקיפדיה) וההערה
-- המתאימה בכל אחד מהסקריפטים. ראו migration_split_truncate_functions.sql.
create or replace function truncate_mechalol_pages()
returns void
language sql
as $$
    truncate table mechalol_pages;
$$;

create or replace function truncate_wikipedia_pages()
returns void
language sql
as $$
    truncate table wikipedia_pages;
$$;

-- קריאה מ-match.py (client.rpc) בסוף כל ריצה, אחרי שכל שורות
-- mechalol_pages כבר עודכנו עם wikipedia_id סופי. מעדכן בעדכון יחיד
-- (לא שורה-שורה) את is_missing עבור כל wikipedia_pages - מריץ עם
-- מפתח השירות (SUPABASE_SERVICE_KEY), לא עם תפקיד ה-anon, כך שלא כפוף
-- ל-statement_timeout הנמוך שלו.
create or replace function recompute_missing_flag()
returns void
language sql
as $$
    update wikipedia_pages w
    set is_missing = not exists (
        select 1 from mechalol_pages m where m.wikipedia_id = w.id
    )
    where w.is_missing <> not exists (
        select 1 from mechalol_pages m where m.wikipedia_id = w.id
    );
$$;
