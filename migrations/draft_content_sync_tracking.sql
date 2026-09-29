-- draft_content_sync_tracking.sql
--
-- *** טיוטה - לא הורצה, ולא חלק מסדר ההקמה ב-README. ***
-- הקובץ נקרא draft_ ולא migration_ בכוונה: אסור להריץ אותו לפני שנסגרות
-- ההחלטות הפתוחות בסוף הקובץ. אחרי שנסגרו - לשנות שם ל-migration_add_content_sync_tracking.sql
-- ולתעד ב-README ובסדר ההקמה.
--
-- מטרה: לשמור על תוכן ערכי המכלול קרוב ככל האפשר לוויקיפדיה. מטא-דאטה בלבד
-- (בלי ויקיטקסט), עדכון שעתי, תור משימות לעורכים.
--
-- עיקרון מרכזי (אומת מול perform_atomic_swap ב-migration_finalize_temp_pages_naming.sql):
-- ה-swap מחליף *שמות* של wikipedia_pages/mechalol_pages, והטבלה הפיזית שמאחורי
-- השם מתחלפת. מפתח זר מטבלה חדשה אליהן היה מצביע על האובייקט הפיזי, כלומר אחרי
-- swap על הטבלה שהפכה ל-_temp, ואז truncate_temp_pages היה נכשל או חסום.
-- לכן: כל הטבלאות כאן מצביעות רק על מצאי קבוע משלהן (לשני האתרים), ולעולם לא על
-- טבלאות ה-swap. הן גם לא נוגעות בהן ולא משתנות בעקבות ה-swap.
--
-- טבלאות: wikipedia_inventory, mechalol_inventory, content_sync_links, sync_tasks,
--         scan_state, sync_editors.

-- ---------------------------------------------------------------------------
-- 1. מצאי קבוע (לא מתרוקן, לא עובר swap). דף שנמחק נשאר עם deleted_at.
-- ---------------------------------------------------------------------------

create table if not exists wikipedia_inventory (
    page_id        bigint primary key,           -- page_id בוויקיפדיה
    title          text not null,
    is_redirect    boolean not null default false,
    latest_rev_id  bigint,
    latest_rev_ts  timestamptz,
    latest_sha1    text,
    size_bytes     integer,
    first_seen_at  timestamptz not null default now(),
    last_seen_at   timestamptz not null default now(),
    deleted_at     timestamptz,                  -- null = קיים
    updated_at     timestamptz not null default now()
);

create table if not exists mechalol_inventory (
    page_id        bigint primary key,           -- page_id במכלול
    title          text not null,
    is_redirect    boolean not null default false,
    latest_rev_id  bigint,
    latest_rev_ts  timestamptz,
    latest_sha1    text,
    size_bytes     integer,
    first_seen_at  timestamptz not null default now(),
    last_seen_at   timestamptz not null default now(),
    deleted_at     timestamptz,
    updated_at     timestamptz not null default now()
);

-- כותרת ייחודית רק בין דפים חיים: כותרת של דף שנמחק יכולה להיתפס מחדש.
create unique index if not exists wikipedia_inventory_live_title_key
    on wikipedia_inventory (title) where deleted_at is null;
create unique index if not exists mechalol_inventory_live_title_key
    on mechalol_inventory (title) where deleted_at is null;
create index if not exists wikipedia_inventory_rev_ts_idx on wikipedia_inventory (latest_rev_ts);
create index if not exists mechalol_inventory_rev_ts_idx on mechalol_inventory (latest_rev_ts);

-- ---------------------------------------------------------------------------
-- 2. קישור ומעקב. שורה אחת לכל ערך מכלול עם מקור בוויקיפדיה.
--    "שולב" ו"נבדק" הם נתונים נפרדים: עורך שקבע שאין לשלב שינוי מקדם רק את
--    הנבדק, לא את השולב.
-- ---------------------------------------------------------------------------

create table if not exists content_sync_links (
    id                          bigserial primary key,
    mechalol_page_id            bigint not null unique references mechalol_inventory (page_id),
    wikipedia_page_id           bigint not null references wikipedia_inventory (page_id),

    -- מאיפה הקישור: מטבלת ההתאמות הקיימת, או ידני.
    link_origin                 text not null default 'match'
                                check (link_origin in ('match', 'manual')),

    -- גרסת המקור ששולבה בפועל במכלול. null = לא ידוע. גרסה ראשונה במכלול אינה
    -- ראיה בפני עצמה - רק ראיה מקשרת (תבנית תיעוד / הערת עריכה / קביעה ידנית).
    source_rev_integrated       bigint,
    source_rev_integrated_basis text not null default 'unknown'
                                check (source_rev_integrated_basis in
                                       ('template', 'edit_summary', 'manual', 'unknown')),
    check ((source_rev_integrated is null) = (source_rev_integrated_basis = 'unknown')),

    -- נקודת הבדיקה האחרונה של עורך (או של סריקה אוטומטית שמצאה תוכן זהה).
    last_reviewed_source_rev    bigint,
    last_reviewed_source_sha1   text,    -- ההשוואה נעשית מול תוכן זה, לא מול הסריקה הקודמת
    last_reviewed_mechalol_rev  bigint,
    last_reviewed_at            timestamptz,
    last_reviewed_by            uuid references auth.users (id) on delete set null,

    created_at                  timestamptz not null default now(),
    updated_at                  timestamptz not null default now()
);

create index if not exists content_sync_links_wikipedia_idx on content_sync_links (wikipedia_page_id);

-- ---------------------------------------------------------------------------
-- 3. משימות. משימה פעילה אחת לכל ערך וסוג בעיה; משימה שנסגרה נשמרת כהיסטוריה
--    ושינוי חדש פותח משימה חדשה. כל עוד המשימה פתוחה, מעדכנים אותה.
-- ---------------------------------------------------------------------------

create table if not exists sync_tasks (
    id                    bigserial primary key,
    mechalol_page_id      bigint not null references mechalol_inventory (page_id),
    wikipedia_page_id     bigint references wikipedia_inventory (page_id),

    task_type             text not null check (task_type in (
                              'source_content_changed',      -- תוכן המקור השתנה מאז הנבדק
                              'source_moved',                -- המקור הועבר
                              'source_deleted',              -- המקור נמחק
                              'link_uncertain',              -- התאמה לא ודאית
                              'no_baseline',                 -- אין גרסת מקור ששולבה
                              'mechalol_changed_since_review'-- המכלול נערך אחרי הבדיקה
                          )),
    reason_detail         text,
    priority              smallint not null default 3 check (priority between 1 and 5),  -- 1 = דחוף. גודל/דגל מינורי הם רמזים לתעדוף בלבד

    -- הגרסאות הרלוונטיות בעת הפתיחה ובעת העדכון האחרון
    source_rev_at_open    bigint,
    source_rev_latest     bigint,
    mechalol_rev_at_open  bigint,

    state                 text not null default 'open'
                          check (state in ('open', 'in_progress', 'deferred', 'resolved')),
    resolution            text check (resolution in ('integrated', 'not_needed', 'needs_inquiry')),
    -- משימה סגורה חייבת תוצאה סופית; "לבירור" משאיר אותה פעילה (deferred)
    check (state <> 'resolved' or resolution in ('integrated', 'not_needed')),
    resolved_source_rev   bigint,    -- עד איזו גרסת מקור בוצעה הבדיקה
    note                  text,

    opened_at             timestamptz not null default now(),
    updated_at            timestamptz not null default now(),
    closed_at             timestamptz,
    closed_by             uuid references auth.users (id) on delete set null
);

-- ייחודיות: פעילה אחת לכל (ערך, סוג). "deferred" (נשאר לבירור) עדיין פעילה.
create unique index if not exists sync_tasks_one_active_key
    on sync_tasks (mechalol_page_id, task_type) where state <> 'resolved';
create index if not exists sync_tasks_state_priority_idx on sync_tasks (state, priority);

-- ---------------------------------------------------------------------------
-- 4. מצב סריקות. שורה לכל זרם איסוף, עם נקודת התקדמות משלו.
--    משימה שנשענת על שני האתרים נפתחת רק כשנקודות שני הזרמים עברו את אותו זמן.
-- ---------------------------------------------------------------------------

create table if not exists scan_state (
    stream                text primary key check (stream in (
                              'wikipedia_changes', 'mechalol_changes',
                              'wikipedia_full_inventory', 'mechalol_full_inventory')),
    watermark_ts          timestamptz,     -- נקבע לפי הנתון האחרון שנקלט, לא לפי שעון הריצה
    continue_token        jsonb,           -- להמשך סריקה מלאה שנקטעה
    last_attempt_at       timestamptz,
    last_success_at       timestamptz,
    consecutive_failures  integer not null default 0,
    last_error            text,
    updated_at            timestamptz not null default now()
);

insert into scan_state (stream) values
    ('wikipedia_changes'), ('mechalol_changes'),
    ('wikipedia_full_inventory'), ('mechalol_full_inventory')
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- 5. עורכים. הזדהות: חשבון Supabase Auth אמיתי (auth.uid()), לא שם משתמש שנשלח
--    מהגאדג'ט. mechalol_username הוא תיעוד בלבד, בלי הוכחת בעלות - נקבע ידנית
--    על ידי מנהל. מבוסס על אותו עיקרון כמו manual_match_admins.
-- ---------------------------------------------------------------------------

create table if not exists sync_editors (
    user_id            uuid primary key references auth.users (id) on delete cascade,
    role               text not null default 'editor' check (role in ('editor', 'admin')),
    mechalol_username  text,
    added_at           timestamptz not null default now()
);
alter table sync_editors enable row level security;
revoke all on sync_editors from anon, authenticated;

create or replace function is_sync_editor()
returns boolean language sql stable security definer set search_path = public as $$
    select exists (select 1 from sync_editors where user_id = auth.uid());
$$;
create or replace function is_sync_admin()
returns boolean language sql stable security definer set search_path = public as $$
    select exists (select 1 from sync_editors where user_id = auth.uid() and role = 'admin');
$$;
revoke all on function is_sync_editor(), is_sync_admin() from public, anon, authenticated;
grant execute on function is_sync_editor(), is_sync_admin() to authenticated;

-- עורך רשאי לשנות רק שדות טיפול במשימה, ולא לזייף מי סגר: closed_by/closed_at
-- נקבעים בשרת. עדכון הקישור (נקודת בדיקה) נעשה דרך פונקציה נפרדת בשלב הבא.
create or replace function sync_tasks_before_update()
returns trigger language plpgsql as $$
begin
    new.updated_at := now();
    if new.state = 'resolved' and old.state <> 'resolved' then
        new.closed_at := now();
        new.closed_by := auth.uid();
    elsif new.state <> 'resolved' then
        new.closed_at := null;
        new.closed_by := null;
    end if;
    -- שדות שהעורך לא אמור לשנות
    new.mechalol_page_id := old.mechalol_page_id;
    new.task_type := old.task_type;
    new.opened_at := old.opened_at;
    return new;
end;
$$;
drop trigger if exists sync_tasks_before_update on sync_tasks;
create trigger sync_tasks_before_update before update on sync_tasks
    for each row execute function sync_tasks_before_update();

-- ---------------------------------------------------------------------------
-- 6. RLS והרשאות.
--    כתיבה למצאי, לקישורים ולמצב סריקה: רק service_role (האיסוף).
--    משימות: קריאה לציבור, עדכון רק לעורכים (state/resolution/note).
--    החלטה פתוחה: האם לקרוא ציבורית או רק authenticated (ראו בסוף).
-- ---------------------------------------------------------------------------

do $$
declare t text;
begin
    foreach t in array array['wikipedia_inventory', 'mechalol_inventory',
                             'content_sync_links', 'sync_tasks', 'scan_state']
    loop
        execute format('alter table %I enable row level security', t);
        execute format('drop policy if exists "קריאה ציבורית" on %I', t);
        execute format('create policy "קריאה ציבורית" on %I for select to anon, authenticated using (true)', t);
        execute format('revoke all on %I from anon, authenticated', t);
        execute format('grant select on %I to anon, authenticated', t);
        execute format('grant select, insert, update, delete, truncate, references, trigger on %I to service_role', t);
    end loop;
end $$;

grant update (state, resolution, note, priority) on sync_tasks to authenticated;
drop policy if exists "עורכים מטפלים במשימות" on sync_tasks;
create policy "עורכים מטפלים במשימות" on sync_tasks
    for update to authenticated
    using (is_sync_editor()) with check (is_sync_editor());

grant usage, select on all sequences in schema public to service_role;
grant all on sync_editors to service_role;

-- ---------------------------------------------------------------------------
-- 7. דוח ראשוני: "המקור השתנה מאז הבדיקה". security_invoker כמו שאר הדוחות.
-- ---------------------------------------------------------------------------

create or replace view report_source_changed with (security_invoker = true) as
select t.id as task_id,
       t.mechalol_page_id, m.title as mechalol_title,
       t.wikipedia_page_id, w.title as wikipedia_title,
       t.priority, t.state,
       t.source_rev_at_open, t.source_rev_latest,
       w.latest_rev_ts as source_latest_ts,
       l.last_reviewed_at,
       t.opened_at, t.updated_at
from sync_tasks t
join mechalol_inventory m on m.page_id = t.mechalol_page_id
left join wikipedia_inventory w on w.page_id = t.wikipedia_page_id
left join content_sync_links l on l.mechalol_page_id = t.mechalol_page_id
where t.task_type = 'source_content_changed' and t.state <> 'resolved';

grant select on report_source_changed to anon, authenticated, service_role;

notify pgrst, 'reload schema';

-- ---------------------------------------------------------------------------
-- החלטות פתוחות לפני הרצה:
-- 1. source_rev_integrated: נדרשות דוגמאות אמיתיות לתיעוד גרסת מקור במכלול כדי
--    לקבוע את ה-basis ואת שיטת החילוץ. בלי זה כולם 'unknown' ונכנסים ל-no_baseline.
-- 2. קריאה ציבורית (anon) לטבלת המשימות: הנוחות מול חשיפת מי סגר משימה (closed_by
--    הוא uuid, לא שם). חלופה: authenticated בלבד.
-- 3. טבלת המצאי מתמלאת לפי כל ערכי המרחב הראשי (allpages) והפניות - צריך למדוד
--    נפח בפועל לפני הטעינה, ולוודא מול מגבלת הדיסק בסופרבייס.
-- 4. שעתי: workflow נפרד עם scan_state משלו (לא sync_watermarks של הלילי), וניטור
--    כשל אם last_success_at ישן מ-3 שעות. לא נכלל בקובץ הזה.
-- 5. הזדהות: אין קישור מוכח בין auth.uid() לחשבון במכלול; mechalol_username הוא
--    תיעוד ידני בלבד. אם נדרש audit קשיח - OAuth של המכלול, מחוץ להיקף.
-- 6. מילוי content_sync_links ההתחלתי מ-mechalol_pages.wikipedia_id (התאמות
--    ודאיות בלבד) ו-manual_matches - סקריפט נפרד, בלי גרסאות ששולבו.
-- ---------------------------------------------------------------------------
