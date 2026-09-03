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
    -- תאריך יצירת הערך בוויקיפדיה (חותמת הזמן של הגרסה הראשונה שלו).
    -- *לא* נשלף בסריקה השבועית המלאה - מדיה-ויקי דוחה כל ניסיון לשלב
    -- rvdir=newer (הדרך היחידה לקבל את הגרסה הראשונה) עם generator/
    -- titles שמספקים כמה דפים בבת אחת ("invalidparammix"). נשלף ונשמר
    -- ידנית על ידי fetch_wikipedia_created_at.py (סקריפט עצמאי, לא
    -- חלק מ-weekly_update.yml) עבור השורות שמופיעות בדוח
    -- report_missing_from_mechalol בלבד - כמו wikidata_desc/easy_import
    -- למטה. nullable: NULL = טרם נבדק (או חסר חותמת זמן במקרה חריג).
    -- ראו migration_add_wikipedia_created_at.sql.
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

    -- true אם אין אף שורה ב-mechalol_pages שמצביעה לכאן (wikipedia_id),
    -- או עם כותרת זהה בדיוק, או עם כותרת זהה אחרי הסרת קידומת "הרב"/
    -- "רבי" (ראו normalize_person_title, למטה) - שלושת התנאים יחד, לא
    -- רק wikipedia_id כמו במקור. מחושב מחדש בסוף כל ריצה של match.py
    -- (recompute_missing_flag/recompute_missing_flag_scoped, למטה) - לא
    -- חי, לא מתעדכן אוטומטית בין ריצה לריצה. הוחלף מהצטרפות (join) חיה
    -- של שתי הטבלאות ב-report_missing_from_mechalol, שהייתה לוקחת ~3.7
    -- שניות ועפה על statement_timeout של תפקיד ה-anon - ראו
    -- migration_add_is_missing_flag.sql.
    is_missing boolean not null default false,

    -- מתעד *למה* is_missing=false כשהסיבה אינה wikipedia_id/כותרת זהה
    -- ממש - כרגע רק 'rav_prefix_normalization' (תוצאת normalize_
    -- person_title בלבד). NULL כשההתאמה "אמיתית" (wikipedia_id או
    -- כותרת זהה) או כשעדיין חסר. מאפשר לאתר ולבטל בקלות את כל השורות
    -- שהוחרגו רק בגלל נירמול קידומת רבנית, בלי לצטט מחדש - ראו
    -- migration_add_missing_override_reason.sql.
    missing_override_reason text
);

-- מסיר קידומת "הרב "/"רבי " מתחילת כותרת בלבד - בכוונה לא נוגע ב"רבנית"
-- ולא ב-"(רב)" בסוף כותרת (שיקול דעת אנושי מפורש, ראו דיון בפועל).
-- language sql immutable כדי לאפשר אינדקס-ביטוי עליה בעתיד אם יידרש.
-- משמש רק בחישוב is_missing (recompute_missing_flag/_scoped, למטה) -
-- לעולם לא בקישור wikipedia_id עצמו.
create or replace function normalize_person_title(t text)
returns text
language sql
immutable
as $$
    select trim(regexp_replace(t, '^(הרב|רבי)\s+', ''));
$$;

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
-- הסדר קריטי בגלל המפתח הזר mechalol_pages.wikipedia_id -> wikipedia_pages.id,
-- ובגלל ש-truncate_wikipedia_pages() משתמשת ב-CASCADE (למטה): ב-פוסטגרס,
-- TRUNCATE...CASCADE לא "מוחק שורות עם מפתח זר תלוי" - הוא מרוקן *לגמרי*
-- את כל טבלה שיש לה מפתח זר לטבלה המרוקנת, ברמת הטבלה השלמה, ללא קשר
-- לערכים בפועל בעמודת המפתח הזר (גם אם כולם NULL). לכן: תמיד יש לרוקן
-- ולמלא קודם את wikipedia_pages (הטבלה המופנית/parent), ורק אחר כך את
-- mechalol_pages (הטבלה המפנה/child) - הפוך ממה שהיה נהוג פה בעבר. אם
-- מכלול היה ממולא *לפני* ריקון ויקיפדיה, ה-CASCADE היה מוחק את מה שהוא
-- עתה מילא (בדיוק התקלה שקרתה בפועל, 2026-09 - ראו postmortem). אחרי
-- הריקון-עם-CASCADE של ויקיפדיה, mechalol_pages ריקה ממילא (או שעדיין
-- לא מולאה השבוע) - כך שה-CASCADE לא מזיק, רק מבצע ריקון שהיה קורה
-- ממילא כמה שניות אחר כך על ידי truncate_mechalol_pages(). ראו סדר
-- השלבים המעודכן ב-weekly_update.yml/biweekly_full_reconciliation.yml/
-- initial_run.yml (ויקיפדיה תמיד לפני מכלול) וההערה המתאימה בכל אחד
-- מהסקריפטים.
create or replace function truncate_mechalol_pages()
returns void
language sql
as $$
    truncate table mechalol_pages;
$$;

-- CASCADE כאן הוא במכוון (ראו ההערה למעלה) - לא ניסיון "לעקוף" את
-- החסימה של פוסטגרס בלי להבין מה הוא עושה. בלי CASCADE, הקריאה הזו
-- הייתה נכשלת *תמיד* כל עוד קיים מפתח זר מ-mechalol_pages לכאן - גם
-- אם כל הערכים NULL - כי TRUNCATE רגיל חוסם מטבלה שיש אליה הפניה,
-- ברמת המטא-דאטה, בלי לבדוק את הנתונים בפועל. RESTART IDENTITY +
-- statement_timeout מקומי (300 שניות) - זו הגרסה שרצה בפועל בסופרבייס;
-- ראו גם truncate_pages() הישנה (לא בשימוש, לא נמחקה - migration_split_truncate_functions.sql).
create or replace function truncate_wikipedia_pages()
returns void
language plpgsql
as $$
begin
    set local statement_timeout = '300s';
    truncate table wikipedia_pages restart identity cascade;
end;
$$;

-- קריאה מ-match.py (client.rpc) בסוף כל ריצה מלאה (לא --scoped), אחרי
-- שכל שורות mechalol_pages כבר עודכנו עם wikipedia_id סופי. מעדכן
-- בעדכון יחיד (לא שורה-שורה) את is_missing/missing_override_reason
-- עבור כל wikipedia_pages - מריץ עם מפתח השירות (SUPABASE_SERVICE_KEY),
-- לא עם תפקיד ה-anon, כך שלא כפוף ל-statement_timeout הנמוך שלו.
create or replace function recompute_missing_flag()
returns void
language sql
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
    where w.is_missing is distinct from not exists (
            select 1 from mechalol_pages m
            where m.wikipedia_id = w.id
               or m.title = w.title
               or normalize_person_title(m.title) = normalize_person_title(w.title)
        )
       or w.missing_override_reason is distinct from case
            when exists (select 1 from mechalol_pages m where m.wikipedia_id = w.id or m.title = w.title)
                then null
            when exists (select 1 from mechalol_pages m where normalize_person_title(m.title) = normalize_person_title(w.title))
                then 'rav_prefix_normalization'
            else null
        end;
$$;

-- זהה ל-recompute_missing_flag אבל מוגבל ל-ids נתונים - קריאה מ-match.py
-- --scoped (הריצה הלילית) על affected_wikipedia_ids בלבד, כדי לא לסרוק
-- את כל הטבלה בכל ריצת דלתא. נוצרה ישירות ב-Supabase SQL editor
-- ב-2026-09-01 ולא הייתה מתועדת כאן עד עכשיו - זה עצמו היה הפער
-- שהוביל לתיקון schema.sql הזה.
create or replace function recompute_missing_flag_scoped(ids bigint[])
returns void
language sql
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
    where w.id = any(ids);
$$;
