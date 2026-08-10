-- סכימת מסד הנתונים להשוואת ערכים בין ויקיפדיה העברית למכלול
-- להרצה חד-פעמית בעורך ה-SQL של סופרבייס

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

    -- נוצר_במכלול / מיובא_מתועד / מיובא_ללא_תיעוד
    status text not null check (status in ('נוצר_במכלול', 'מיובא_מתועד', 'מיובא_ללא_תיעוד')),

    -- רק כאשר status = מיובא_מתועד, בפורמט YYYY-MM (נגזר מקטגוריית "עודכן לאחרונה ב-X")
    last_update_month text,

    -- מפתח זר לטבלת ויקיפדיה, אם נמצאה התאמת כותרת
    wikipedia_id bigint references wikipedia_pages(id),

    -- מיובא / כותרת_זהה_בלי_קשר / ללא_התאמה
    match_type text not null check (match_type in ('מיובא', 'כותרת_זהה_בלי_קשר', 'ללא_התאמה')),

    -- הכותרת קיימת אך אין תוכן בדף (קטגוריית "ערכים לפתיחה")
    דף_לטיפול boolean not null default false,

    -- תקציר מיובא מוויקיפדיה, לא ערך מלא (קטגוריית "ערכים מילוניים")
    מילוני boolean not null default false,

    -- הערך מסומן כמיובא, אך לא נמצאה עבורו כותרת תואמת בטבלת wikipedia_pages הנוכחית
    -- (חוסר-התאמה בלבד - ייתכן שהערך נמחק, אך גם ייתכנו סיבות אחרות כמו פער תזמון)
    אולי_נמחק_בוויקיפדיה boolean not null default false,

    -- אושר ודאית מיומן המחיקות/ההעברות של ויקיפדיה: הערך המקורי נמחק שם, או הועבר ממרחב הערכים למרחב אחר
    נמחק_בוויקיפדיה boolean not null default false,

    -- הערך מסומן כמיובא, אך כותרתו לא נמצאה בריצה הנוכחית של רשימת ויקיפדיה
    -- (סימון בלבד לבדיקה ידנית - לא גורר מחיקה אוטומטית בשום מקום)
    אולי_נמחק_מוויקיפדיה boolean not null default false,

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
-- select * from mechalol_pages where match_type = 'ללא_התאמה';
