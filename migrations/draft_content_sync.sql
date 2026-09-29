-- draft_content_sync.sql
--
-- *** טיוטה - לא הורצה, ולא חלק מסדר ההקמה ב-README. ***
-- (draft_ ולא migration_ בכוונה. אחרי שנסגרות ההחלטות שבסוף הקובץ - לשנות שם
-- ל-migration_add_content_sync.sql ולתעד ב-README.)
--
-- מטרה: לדעת, לכל ערך במכלול, מול איזו גרסת ויקיפדיה הוא עודכן לאחרונה ואם
-- ויקיפדיה התקדמה מאז - כדי שכלי בגאדג'ט יפתח עריכה עם מיזוג תלת-כיווני
-- (בסיס = גרסת ויקיפדיה ששולבה, שלנו = המכלול היום, שלהם = ויקיפדיה היום).
-- מטא-דאטה בלבד: הטקסטים נשלפים חי מה-API בלחיצה ולא נשמרים כאן.
--
-- מקור גרסת הבסיס (אומת על מדגם של 199 ערכים): הפרמטר `גרסה=` בתבנית
-- {{מיון ויקיפדיה|דף=…|גרסה=…|פריט=…|תאריך=…}} בסוף הערך. הוא קיים בכ-95% מהערכים
-- כמספר גרסה אמיתי בוויקיפדיה; בכ-5% הוא 0 (ערכים ישנים) או מספר שאינו קיים.
--
-- נתון שלמדנו מהשטח: ערכים רבים קיבלו במכלול נתוני ויקינתונים שבוויקיפדיה נמשכים
-- דרך יחידה ולא כתובים בקוד המקור. במכלול הם נכנסים לקוד המקור בעריכה (למשל
-- "בוט מקוה: עדכון מויקינתונים"), ולכן שורות פרמטרים של תבניות יוצרות התנגשויות
-- מיזוג (~15% ממוקדי ההתנגשות במדגם). לא נפתר כאן - עניין לכלי המיזוג.
--
-- עיקרון (אומת מול perform_atomic_swap): הטבלה החדשה לא מצביעה על wikipedia_pages /
-- mechalol_pages ולא מושפעת מה-swap השבועי. מפתחה הוא page_id במכלול.

create table if not exists mechalol_content_sync (
    mechalol_page_id      bigint primary key,       -- page_id במכלול (מרחב ראשי)
    mechalol_title        text not null,
    is_redirect           boolean not null default false,
    mechalol_rev_id       bigint,
    mechalol_rev_ts       timestamptz,

    -- מתוך {{מיון ויקיפדיה}}. wikipedia_title לפי `דף=` (קו תחתון מומר לרווח).
    has_sort_template     boolean not null default false,
    wikipedia_title       text,
    wikidata_item         text,                     -- `פריט=` (Q…)
    sync_date_text        text,                     -- `תאריך=` כפי שנכתב (טקסט חופשי)

    -- גרסת ויקיפדיה ששולבה. null = לא ידוע, והסיבה ב-baseline_status.
    source_rev_integrated bigint,
    baseline_status       text not null default 'no_template'
                          check (baseline_status in (
                              'known',        -- גרסה=N>0 ונמצאה בוויקיפדיה
                              'zero',         -- גרסה=0 (ערך ישן, אין בסיס)
                              'not_found',    -- מספר שאינו קיים בוויקיפדיה (נמחק/שגוי)
                              'no_template',  -- אין תבנית מיון ויקיפדיה
                              'unchecked')),  -- טרם נבדק מול ויקיפדיה
    check ((baseline_status = 'known') = (source_rev_integrated is not null)),

    -- מצב המקור בוויקיפדיה כפי שנבדק בסריקה האחרונה
    source_rev_latest     bigint,
    source_rev_latest_ts  timestamptz,
    source_state          text not null default 'unchecked'
                          check (source_state in (
                              'unchecked', 'current', 'ahead',
                              'redirect', 'missing')),   -- missing = הדף לא קיים בוויקיפדיה
    source_checked_at     timestamptz,

    -- הפעם האחרונה שהערך נראה בסריקת המכלול; deleted_at = נמחק מהמכלול
    last_seen_at          timestamptz not null default now(),
    deleted_at            timestamptz,
    updated_at            timestamptz not null default now()
);

create index if not exists mechalol_content_sync_state_idx
    on mechalol_content_sync (source_state) where deleted_at is null;
create index if not exists mechalol_content_sync_baseline_idx
    on mechalol_content_sync (baseline_status) where deleted_at is null;
create index if not exists mechalol_content_sync_wikipedia_title_idx
    on mechalol_content_sync (wikipedia_title);
create index if not exists mechalol_content_sync_source_latest_ts_idx
    on mechalol_content_sync (source_rev_latest_ts desc);

-- מצב סריקה: נקודת התקדמות נפרדת לכל זרם, נקבעת לפי הנתון האחרון שנקלט
-- (לא לפי שעון הריצה). ערך שנקלט בקצה של שני זרמים נבדק רק כששניהם עברו את אותו זמן.
create table if not exists content_sync_scan_state (
    stream                text primary key check (stream in (
                              'mechalol_changes',     -- recentchanges/logevents במכלול (שעתי)
                              'wikipedia_changes',    -- שינויים בוויקיפדיה בדפים המקושרים (שעתי)
                              'mechalol_full',        -- allpages מלא (טעינה ראשונית ובקרה)
                              'wikipedia_full')),     -- בדיקת גרסה עדכנית לכל המקושרים
    watermark_ts          timestamptz,
    continue_token        jsonb,
    last_attempt_at       timestamptz,
    last_success_at       timestamptz,
    consecutive_failures  integer not null default 0,
    last_error            text,
    updated_at            timestamptz not null default now()
);

insert into content_sync_scan_state (stream) values
    ('mechalol_changes'), ('wikipedia_changes'), ('mechalol_full'), ('wikipedia_full')
on conflict do nothing;

-- RLS: קריאה ציבורית (כמו שאר טבלאות הדוחות), כתיבה רק ל-service_role (האיסוף).
-- אין כתיבה מהגאדג'ט: הסימון "שולב" נקבע מגרסת ה-`גרסה=` שנכתבת בערך עצמו בעריכה.
alter table mechalol_content_sync enable row level security;
alter table content_sync_scan_state enable row level security;

drop policy if exists "קריאה ציבורית" on mechalol_content_sync;
create policy "קריאה ציבורית" on mechalol_content_sync for select to anon, authenticated using (true);
drop policy if exists "קריאה ציבורית" on content_sync_scan_state;
create policy "קריאה ציבורית" on content_sync_scan_state for select to anon, authenticated using (true);

revoke all on mechalol_content_sync, content_sync_scan_state from anon, authenticated;
grant select on mechalol_content_sync, content_sync_scan_state to anon, authenticated;
grant select, insert, update, delete, truncate, references, trigger
    on mechalol_content_sync, content_sync_scan_state to service_role;

-- דוח: ערכים שוויקיפדיה התקדמה בהם מאז הגרסה ששולבה. security_invoker כמו שאר הדוחות.
create or replace view report_source_ahead with (security_invoker = true) as
select c.mechalol_page_id,
       c.mechalol_title,
       c.wikipedia_title,
       c.source_rev_integrated,
       c.source_rev_latest,
       c.source_rev_latest_ts,
       c.mechalol_rev_ts,
       c.wikidata_item,
       c.sync_date_text,
       c.source_checked_at
from mechalol_content_sync c
where c.deleted_at is null
  and not c.is_redirect
  and c.baseline_status = 'known'
  and c.source_state = 'ahead';

-- ערכים בלי בסיס שמיש: הכלי לא יכול למזג, נדרשת קביעת בסיס ידנית.
create or replace view report_content_sync_no_baseline with (security_invoker = true) as
select c.mechalol_page_id, c.mechalol_title, c.wikipedia_title,
       c.baseline_status, c.sync_date_text
from mechalol_content_sync c
where c.deleted_at is null
  and not c.is_redirect
  and c.baseline_status in ('zero', 'not_found', 'no_template');

grant select on report_source_ahead, report_content_sync_no_baseline
    to anon, authenticated, service_role;

notify pgrst, 'reload schema';

-- ---------------------------------------------------------------------------
-- החלטות פתוחות לפני הרצה:
-- 1. מסלול העדכון אחרי שעורך שילב: הסימון נקבע מהערך עצמו (`גרסה=` בתבנית) בסריקה
--    הבאה. הכלי בגאדג'ט חייב לעדכן את `גרסה=` לגרסה האחרונה שמוזגה, אחרת הערך יישאר
--    "ahead" לנצח.
-- 2. ערכים עם `גרסה=0` או מספר שלא קיים (למשל "תלמוד": 1589756): נשארים ב-
--    report_content_sync_no_baseline עד שנקבע בסיס ידנית. אין פה טבלת החלטות.
-- 3. ויקיפדיה מגבילה קצב (429) מכתובת הקונטיינר; הסריקה מהפעולות של GitHub חייבת
--    Retry-After, maxlag ואצוות מתונות.
-- 4. מילוי ראשוני ושעתי: סקריפטים נפרדים (לא כלולים), עם watermark משלהם ב-
--    content_sync_scan_state ולא ב-sync_watermarks של הלילי.
-- 5. נפח: שורה לכל ערך מרחב ראשי (כולל הפניות). למדוד את מספר הדפים בפועל לפני
--    הטעינה ולוודא מול מגבלת הדיסק.
-- ---------------------------------------------------------------------------
