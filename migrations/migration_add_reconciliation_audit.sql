-- migration_add_reconciliation_audit.sql
--
-- מטרה: לתעד לאורך זמן האם הריצה הדו-שבועית המלאה באמת תופסת פערים
-- שהעדכון היומי (nightly_delta.yml) מפספס במכוון (בעיקר: הפיכת ערך
-- להפניה בכיוון ההפוך - "became_article", שלא נרשם באף מקום בטבלאות
-- הדלתא, בניגוד ל-became_redirect שכן נרשם - ראו migration_add_delta_
-- tables.sql). המטרה הסופית: לצבור עדות מדידה שתאפשר בעוד כמה חודשים
-- להחליט אם עדיין נחוץ להריץ פיוס מלא בכלל, או שאפשר לוותר עליו.
--
-- העיקרון: ארכיטקטורת המראה כבר נותנת לנו בחינם את מה שצריך להשוואה -
-- מיד אחרי כל swap, *_previous מחזיקה את המצב לפני הריצה הזו, והטבלה
-- הפעילה מחזיקה את המצב אחריה. משווים ביניהן לפי id, *ומוציאים* כל id
-- שטבלאות הדלתא כבר ידעו עליו (יצירה/מחיקה/שינוי-שם) מאז הריצה המלאה
-- הקודמת - מה שנשאר זה בדיוק "מה שהדלתא לא הייתה יכולה לתפוס מעצם
-- העיצוב שלה", לא סתם שינויים רגילים.

create table if not exists reconciliation_audit (
    id bigserial primary key,
    run_at timestamptz not null default now(),
    -- מאיפה בדקנו בטבלאות הדלתא - run_at של השורה הקודמת בטבלה הזו,
    -- NULL בריצה הראשונה אי-פעם (או קלט לבירור ידני, לא אמור לחזור).
    since timestamptz,
    rows_compared_mechalol int not null,
    rows_compared_wikipedia int not null,
    -- הספירה שבאמת מעניינת: כמה מהשורות שהדלתא לא הייתה יכולה לדעת
    -- עליהן (id שלא הופיע בשום טבלת יצירה/מחיקה/שינוי-שם מאז) בכל
    -- זאת קיבלו סיווג שונה בריצה המלאה. אם המספר הזה נשאר 0 לאורך
    -- מספיק סבבים - זו העדות שהריצה המלאה כבר לא צריכה לרוץ בתדירות
    -- הנוכחית (או בכלל).
    untracked_changes_found int not null
);

alter table reconciliation_audit enable row level security;
-- בכוונה בלי אף policy - כמו שאר טבלאות הדלתא (wikipedia_creations
-- וכו') - anon/authenticated חסומים לגמרי, service_role עוקף RLS
-- תמיד ולכן לא זקוק לאף policy כדי לקרוא/לכתוב.

create table if not exists reconciliation_audit_details (
    id bigserial primary key,
    audit_id bigint not null references reconciliation_audit(id) on delete cascade,
    side text not null check (side in ('wikipedia', 'mechalol')),
    page_id bigint not null,
    title text,
    changed_columns text[] not null
);

alter table reconciliation_audit_details enable row level security;

create index if not exists idx_reconciliation_audit_details_audit_id
    on reconciliation_audit_details(audit_id);

-- log_reconciliation_diff() - ההשוואה עצמה. נקראת פעם אחת, מיד אחרי
-- swap_shadow_to_active.py (רק כשההחלפה באמת קרתה - אחרת אין _previous
-- רלוונטי להשוואה, ראו התנאי המקביל בשלב ה-workflow). security
-- definer לא הכרחי כאן (אין ALTER TABLE, רק INSERT/SELECT על טבלאות
-- שממילא ל-service_role יש עליהן הרשאה) - נשאר invoker רגיל בכוונה,
-- בניגוד לפונקציות ה-DDL האחרות בארכיטקטורת המראה.
--
-- תיקון עיצוב חשוב (לא רק ניסוח): הגרסה הראשונה השוותה גם עמודות
-- מונעות-תוכן (needs_attention, is_dictionary_entry, maybe_deleted_
-- from_wikipedia) שמשתנות כל הזמן בגלל עריכות רגילות בערכים - שום
-- קשר לפספוס של הדלתא, רק "רעש" שהיה מנפח את untracked_changes_found
-- בלי משמעות. צומצם לעמודות קישור טהורות בלבד (match_type,
-- wikipedia_id, is_missing, missing_override_reason,
-- mechalol_redirect_exists) - העיקרון: אם הכותרת לא השתנתה (אין
-- רשומת rename) והקיום לא השתנה (אין create/delete), והדף גם לא עבר
-- דרך מנגנון עדכון-הסיווג של הדלתא (mechalol_status_update_log - ראו
-- migration_add_status_update_log.sql), העמודות האלה יכולות להשתנות
-- רק משתי סיבות לגיטימיות: (א) קטגוריית הפניה↔ערך התהפכה בלי שהדלתא
-- ראתה את זה, או (ב) עריכה שה-fetch_edited_page_ids לא זיהתה כלל
-- (למשל מגבלת ה-API, לא תקלה בעיצוב) - אומת בפועל מול נתונים אמיתיים
-- (audit_id=1: 6 מתוך 12 היו זוגות כותרות-דומות מתיקון תבנית - לפני
-- שהוספנו את החרגת mechalol_status_update_log, אז ייתכן שחלקן דווקא
-- כן עברו דרך הדלתא ופשוט לא נספרו נכון; מהריצה הבאה זה כבר לא יקרה).
-- גם הוספה: החרגת id-ים שיש להם רשומה
-- ב-manual_matches - שינוי match_type שנגרם מקיוריישן ידני הוא מכוון,
-- לא פספוס.
create or replace function log_reconciliation_diff()
returns void
language plpgsql
set search_path = public
as $$
declare
    v_since timestamptz;
    v_audit_id bigint;
    v_mechalol_compared int;
    v_wikipedia_compared int;
    v_untracked int;
begin
    select max(run_at) into v_since from reconciliation_audit;

    -- מכלול: רק match_type/wikipedia_id (קישור טהור) - לא עמודות תוכן.
    create temporary table _mechalol_diff on commit drop as
    select cur.id as page_id, cur.title,
        array_remove(array[
            case when cur.match_type is distinct from prev.match_type then 'match_type' end,
            case when cur.wikipedia_id is distinct from prev.wikipedia_id then 'wikipedia_id' end
        ], null) as changed_columns
    from mechalol_pages cur
    join mechalol_pages_previous prev on prev.id = cur.id
    where not exists (select 1 from mechalol_creations c where c.page_id = cur.id and (v_since is null or c.fetched_at > v_since))
      and not exists (select 1 from mechalol_deletions d where d.page_id = cur.id and (v_since is null or d.fetched_at > v_since))
      and not exists (select 1 from mechalol_renames r where r.page_id = cur.id and (v_since is null or r.fetched_at > v_since))
      and not exists (select 1 from mechalol_status_update_log s where s.page_id = cur.id and (v_since is null or s.fetched_at > v_since))
      and not exists (select 1 from manual_matches mm where mm.mechalol_page_id = cur.id);

    select count(*) into v_mechalol_compared from _mechalol_diff;

    -- ויקיפדיה: אותו רעיון - is_missing/missing_override_reason/
    -- mechalol_redirect_exists הם בדיוק העמודות שסטטוס הפניה↔ערך
    -- אמור להשפיע עליהן, ורק עליהן.
    create temporary table _wikipedia_diff on commit drop as
    select cur.id as page_id, cur.title,
        array_remove(array[
            case when cur.is_missing is distinct from prev.is_missing then 'is_missing' end,
            case when cur.missing_override_reason is distinct from prev.missing_override_reason then 'missing_override_reason' end,
            case when cur.mechalol_redirect_exists is distinct from prev.mechalol_redirect_exists then 'mechalol_redirect_exists' end
        ], null) as changed_columns
    from wikipedia_pages cur
    join wikipedia_pages_previous prev on prev.id = cur.id
    where not exists (select 1 from wikipedia_creations c where c.page_id = cur.id and (v_since is null or c.fetched_at > v_since))
      and not exists (select 1 from wikipedia_deletions d where d.page_id = cur.id and (v_since is null or d.fetched_at > v_since))
      and not exists (select 1 from wikipedia_renames r where r.page_id = cur.id and (v_since is null or r.fetched_at > v_since))
      and not exists (select 1 from manual_matches mm where mm.wikipedia_page_id = cur.id);

    select count(*) into v_wikipedia_compared from _wikipedia_diff;

    select count(*) into v_untracked from (
        select page_id from _mechalol_diff where array_length(changed_columns, 1) > 0
        union all
        select page_id from _wikipedia_diff where array_length(changed_columns, 1) > 0
    ) x;

    insert into reconciliation_audit (since, rows_compared_mechalol, rows_compared_wikipedia, untracked_changes_found)
    values (v_since, v_mechalol_compared, v_wikipedia_compared, v_untracked)
    returning id into v_audit_id;

    insert into reconciliation_audit_details (audit_id, side, page_id, title, changed_columns)
    select v_audit_id, 'mechalol', page_id, title, changed_columns
    from _mechalol_diff where array_length(changed_columns, 1) > 0;

    insert into reconciliation_audit_details (audit_id, side, page_id, title, changed_columns)
    select v_audit_id, 'wikipedia', page_id, title, changed_columns
    from _wikipedia_diff where array_length(changed_columns, 1) > 0;
end;
$$;

revoke all on function log_reconciliation_diff() from public, anon, authenticated;
grant execute on function log_reconciliation_diff() to service_role;
grant select, insert on reconciliation_audit, reconciliation_audit_details to service_role;
grant usage, select on sequence reconciliation_audit_id_seq, reconciliation_audit_details_id_seq to service_role;
