-- סכימת מסד הנתונים להשוואת ערכים בין ויקיפדיה העברית למכלול
-- להרצה חד-פעמית בעורך ה-SQL של סופרבייס, על טבלאות חדשות/ריקות.
--
-- הערה: קובץ זה עודכן כדי לשקף את המבנה החי בפועל (לאחר שינוי שמות
-- העמודות לאנגלית ואחרי migration_status_labels.sql). אם אתה מריץ את
-- זה מחדש על סביבה קיימת - אין בכך צורך, הטבלה כבר במצב הזה.

create table if not exists wikipedia_pages (
    id bigserial primary key,
    title text not null unique,
    page_id bigint not null unique,
    checked_at timestamptz not null default now()
);

create table if not exists mechalol_pages (
    id bigserial primary key,
    title text not null unique,
    page_id bigint not null unique,

    -- נוצר במכלול / מיובא ומתועד / מיובא ללא תיעוד
    status text not null check (status in ('נוצר במכלול', 'מיובא ומתועד', 'מיובא ללא תיעוד')),

    -- רק כאשר status = מיובא ומתועד, בפורמט YYYY-MM (נגזר מקטגוריית "עודכן לאחרונה ב-X")
    last_update_month text,

    -- מפתח זר לטבלת ויקיפדיה, אם נמצאה התאמת כותרת
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

    -- הערך מסומן כמיובא, אך כותרתו לא נמצאה בריצה הנוכחית של רשימת ויקיפדיה
    -- (סימון בלבד לבדיקה ידנית - לא גורר מחיקה אוטומטית בשום מקום)
    maybe_deleted_from_wikipedia boolean not null default false,

    -- אושר ודאית מיומן המחיקות/ההעברות של ויקיפדיה: הערך המקורי נמחק שם,
    -- או הועבר ממרחב הערכים למרחב אחר
    deleted_from_wikipedia boolean not null default false,

    -- שידוך ידני - אם true, match.py מדלג לגמרי על השורה ולא נוגע בה
    manual_match boolean not null default false,

    -- האם שורה זו כבר עברה את שלב הנרמול/תבנית המיון (בין אם נמצאה
    -- התאמה ובין אם לא) - כדי שריצות עתידיות ידלגו עליה
    normalization_checked boolean not null default false,

    -- ההתאמה נמצאה דרך נרמול/תבנית מיון, לא כותרת זהה במדויק
    normalization_match boolean not null default false,

    -- שם הכלל/כללים שהובילו להתאמה (למשל 'כתיב_אלוהים+קרבן_לקורבן',
    -- או 'תבנית_מיון')
    normalization_method text,

    -- הכותרת המנורמלת שנמצאה עבורה התאמה בוויקיפדיה
    title_normalized text,

    -- מקור השורה: created / translated / pirushon / unknown
    source_type text not null default 'unknown',

    checked_at timestamptz not null default now()
);

create index if not exists idx_mechalol_status on mechalol_pages(status);
create index if not exists idx_mechalol_match_type on mechalol_pages(match_type);
create index if not exists idx_mechalol_wikipedia_id on mechalol_pages(wikipedia_id);

-- שאילתה לדוגמה: מה קיים בוויקיפדיה ואין במכלול
-- select w.* from wikipedia_pages w
-- left join mechalol_pages m on m.wikipedia_id = w.id
-- where m.id is null;

-- שאילתה לדוגמה: מה קיים במכלול וייחודי לו (לא נמצאה התאמה בוויקיפדיה)
-- select * from mechalol_pages where match_type = 'ללא התאמה';
