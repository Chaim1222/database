-- מיגרציה חד-פעמית להרצה בעורך ה-SQL של סופרבייס, על הסביבה הקיימת.
-- שלב 1 במעבר מארכיטקטורת ריקון-ומילוי-מחדש שבועי מלא (schema.sql,
-- truncate_wikipedia_pages/truncate_mechalol_pages) לעדכון דלתא מבוסס
-- recentchanges/logevents של מדיה-ויקי. שלב זה יוצר טבלאות בלבד -
-- אינו נוגע ב-wikipedia_pages/mechalol_pages הקיימות, ואינו מוחק את
-- פונקציות ה-truncate (עדיין בשימוש עד שהסקריפטים החדשים יוחלפו
-- בפועל - ראו migration_split_truncate_functions.sql).
--
-- שש טבלאות דלתא: יצירות/מחיקות/שינויי-שם, לכל אחד משני הצדדים
-- (ויקיפדיה ומכלול). שינויי-שם קיבלו טבלה ייעודית ולא הושארו כפער
-- "נדיר" לפיוס החודשי - בבדיקת ההיתכנות מול ה-API של מכלול התברר
-- שרוב המדגם (4 מתוך 7) היו שינויי-שם בתוך מרחב השמות הראשי, כולל
-- מקרה מתועד שבו העריכה בוצעה במפורש כדי ליישר כותרת מול ויקיפדיה -
-- כלומר זה בדיוק הדפוס שמנוע ההתאמה מבוסס-הכותרת ב-match.py פגיע לו
-- (שינוי כותרת שובר התאמה אוטומטית קיימת, אלא אם יש שורת manual_matches
-- שכבר קושרת את page_id-ים - זו קבועה ולא תלוית-כותרת).
--
-- כל הטבלאות שומרות היסטוריה מלאה (לא סטייג'ינג חד-פעמי שמתרוקן) -
-- העלות זניחה בקנה המידה של הפרויקט, וטבלאות המחיקות הן הרישום
-- הקבוע היחיד לדפים שכבר לא קיימים בטבלאות הראשיות.

create table if not exists wikipedia_creations (
    id bigserial primary key,
    page_id bigint not null,
    title text not null,
    -- rcprop=timestamp מתוך אירוע recentchanges מסוג type:new -
    -- זהו תאריך היצירה עצמו, לא תאריך שליפת הדלתא. מחליף את הצורך
    -- ב-fetch_wikipedia_created_at.py הנפרד (ראו migration_add_wikipedia_created_at.sql)
    -- לדפים חדשים מכאן ואילך - הסקריפט הישן עדיין נחוץ לדפים ישנים
    -- שכבר קיימים ב-wikipedia_pages בלי created_at.
    created_at timestamptz not null,
    fetched_at timestamptz not null default now(),
    unique (page_id, created_at)
);

create table if not exists mechalol_creations (
    id bigserial primary key,
    page_id bigint not null,
    title text not null,
    created_at timestamptz not null,
    fetched_at timestamptz not null default now(),
    unique (page_id, created_at)
);

-- deleted_pageid_valid: true אם ה-pageid בפועל ברשומת logevents הוא
-- ערך תקין (לא 0). בבדיקת ההיתכנות זה עלה עקבי עם "עדיין קיים משהו
-- בכותרת הזו" (הפניה שנשארה, או דף שנוצר מחדש אחרי המחיקה) - לא
-- מתועד רשמית ב-API, ולכן נשמר כאן כשדה גולמי לבירור עתידי ולא
-- כלוגיקה מובנית שמניחה שהדפוס יחזיק תמיד.
create table if not exists wikipedia_deletions (
    id bigserial primary key,
    page_id bigint not null,
    title text not null,
    deleted_at timestamptz not null,
    deleted_pageid_valid boolean not null,
    -- 'log_event' (מ-logevents, delete/move-clearing רגיל) או
    -- 'became_redirect' (עריכה רגילה הפכה ערך במעקב להפניה - לא
    -- נראה כלל דרך logevents, מזוהה בנפרד דרך rctype=edit - ראו
    -- fetch_edited_page_ids/fetch_redirect_status ב-delta_api.py).
    reason text not null default 'log_event' check (reason in ('log_event', 'became_redirect')),
    fetched_at timestamptz not null default now(),
    unique (page_id, deleted_at)
);

create table if not exists mechalol_deletions (
    id bigserial primary key,
    page_id bigint not null,
    title text not null,
    deleted_at timestamptz not null,
    deleted_pageid_valid boolean not null,
    reason text not null default 'log_event' check (reason in ('log_event', 'became_redirect')),
    fetched_at timestamptz not null default now(),
    unique (page_id, deleted_at)
);

-- action: 'move' או 'move_redir' (הכותרת החדשה כבר הייתה קיימת
-- כהפניה ונדרסה) - שני ה-action תחת אותו type:"move" ביומן, חייבים
-- להיבדק בנפרד לפי params.
-- suppressredirect: true רק כשההעברה דיכאה השארת הפניה בכותרת הישנה
-- (מופיע ב-params רק כשרלוונטי - ברירת המחדל היא הפניה כן נשארת).
-- old_title_pageid_valid: כמו deleted_pageid_valid למעלה - סימון גולמי
-- אם ה-pageid ברשומה תקין (יש עדיין משהו בכותרת הישנה) או 0.
create table if not exists wikipedia_renames (
    id bigserial primary key,
    page_id bigint not null,
    old_title text not null,
    new_title text not null,
    renamed_at timestamptz not null,
    action text not null check (action in ('move', 'move_redir')),
    suppressredirect boolean not null default false,
    old_title_pageid_valid boolean,
    fetched_at timestamptz not null default now(),
    unique (page_id, renamed_at)
);

create table if not exists mechalol_renames (
    id bigserial primary key,
    page_id bigint not null,
    old_title text not null,
    new_title text not null,
    renamed_at timestamptz not null,
    action text not null check (action in ('move', 'move_redir')),
    suppressredirect boolean not null default false,
    old_title_pageid_valid boolean,
    fetched_at timestamptz not null default now(),
    unique (page_id, renamed_at)
);

-- שתי שורות בלבד (source = 'wikipedia' / 'mechalol'), מתעדכנות רק
-- אחרי ריצת דלתא שהצליחה במלואה על כל שלביה (יצירות+מחיקות+שינויי-שם
-- לאותו צד) - ריצה חלקית/כושלת לא מזיזה את ה-watermark, כדי שהריצה
-- הבאה תכסה מחדש את אותו טווח ולא תפספס אירועים.
create table if not exists sync_watermarks (
    source text primary key check (source in ('wikipedia', 'mechalol')),
    last_synced_ts timestamptz not null
);

create index if not exists idx_wikipedia_creations_page_id on wikipedia_creations(page_id);
create index if not exists idx_mechalol_creations_page_id on mechalol_creations(page_id);
create index if not exists idx_wikipedia_deletions_page_id on wikipedia_deletions(page_id);
create index if not exists idx_mechalol_deletions_page_id on mechalol_deletions(page_id);
create index if not exists idx_wikipedia_renames_page_id on wikipedia_renames(page_id);
create index if not exists idx_mechalol_renames_page_id on mechalol_renames(page_id);
