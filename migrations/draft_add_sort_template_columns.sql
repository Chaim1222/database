-- draft_add_sort_template_columns.sql
--
-- *** טיוטה - לא הורצה, ולא חלק מסדר ההקמה ב-README. ***
-- (draft_ ולא migration_ בכוונה. אחרי הרצה מוצלחת - לשנות שם ל-
-- migration_add_sort_template_columns.sql ולתעד ב-README.)
--
-- מטרה: לדעת, לכל ערך מיובא ומתועד במכלול, מול איזו גרסת ויקיפדיה הוא עודכן
-- לאחרונה (`גרסה=` בתבנית {{מיון ויקיפדיה}}) ואם ויקיפדיה התקדמה מאז.
-- מטא-דאטה בלבד; הטקסטים נשלפים חי בגאדג'ט. הפענוח: scripts/sort_template.py.
--
-- היקף (אומת מול הייצור, 2026-09): רק status='מיובא ומתועד', לא ערך מילוני
-- (is_dictionary_entry) ולא "ערכים לפתיחה" (needs_attention) - כ-263.6 אלף מתוך
-- 381.6 אלף. דפי טיפול (מיובא ללא תיעוד), ערכים שאינם ויקיפדיים וערכים מילוניים
-- מחוץ להיקף: source_state נשאר NULL בהם.
-- `גרסה=0` או חסרה = "אין גרסה" (sort_template_rev NULL, source_state='no_baseline').
--
-- עמודות העשרה, בדיוק כמו wikidata_desc/created_at: נוספות לארבע הטבלאות הפיזיות
-- (הפעילות והזמניות). הטבלה הזמנית נבנית מחדש בכל ריצה שבועית, ולכן
-- forward_fill_enrichment_temp חייבת להעתיק אותן מהפעילה - אחרת הן מתאפסות בכל swap.
-- עד היום הפונקציה הזו העתיקה רק עמודות של wikipedia_pages; כאן היא מורחבת גם ל-
-- mechalol_pages.
--
-- source_state מחושב מראש (recompute_source_state) ולא JOIN חי בדוח: ה-JOIN בין שתי
-- הטבלאות חרג בעבר מ-statement_timeout של anon (ראו README, is_missing).

-- 1. עמודות. wikipedia_pages: הגרסה העדכנית בוויקיפדיה.
alter table wikipedia_pages
    add column if not exists latest_rev_id bigint,
    add column if not exists latest_rev_ts timestamptz;
alter table wikipedia_pages_temp
    add column if not exists latest_rev_id bigint,
    add column if not exists latest_rev_ts timestamptz;

-- mechalol_pages: גרסת המכלול, הנתונים מהתבנית, סמן טריות, והמצב המחושב.
alter table mechalol_pages
    add column if not exists rev_id bigint,
    add column if not exists rev_ts timestamptz,
    add column if not exists sort_template_rev bigint,
    add column if not exists sort_template_title text,
    add column if not exists sort_template_date date,
    add column if not exists sort_template_parsed_rev bigint,
    add column if not exists source_state text;
alter table mechalol_pages_temp
    add column if not exists rev_id bigint,
    add column if not exists rev_ts timestamptz,
    add column if not exists sort_template_rev bigint,
    add column if not exists sort_template_title text,
    add column if not exists sort_template_date date,
    add column if not exists sort_template_parsed_rev bigint,
    add column if not exists source_state text;

comment on column mechalol_pages.rev_id is
    'מזהה הגרסה האחרונה של הדף במכלול, כפי שנקלט בפענוח האחרון.';
comment on column mechalol_pages.sort_template_rev is
    'גרסה= בתבנית מיון ויקיפדיה: גרסת ויקיפדיה שממנה עודכן הערך. NULL = אין (גם כשכתוב 0).';
comment on column mechalol_pages.sort_template_title is
    'דף= בתבנית מיון ויקיפדיה (קו תחתון מומר לרווח).';
comment on column mechalol_pages.sort_template_date is
    'תאריך= בתבנית מיון ויקיפדיה, היום הראשון בחודש.';
comment on column mechalol_pages.sort_template_parsed_rev is
    'rev_id שבו פוענחה התבנית. שונה מ-rev_id (או NULL) = הפענוח ישן ויש לפענח מחדש.';
comment on column mechalol_pages.source_state is
    'current / ahead / no_baseline / unchecked. NULL = מחוץ להיקף. מחושב ב-recompute_source_state().';

alter table mechalol_pages drop constraint if exists mechalol_pages_source_state_check;
alter table mechalol_pages
    add constraint mechalol_pages_source_state_check
    check (source_state in ('current', 'ahead', 'no_baseline', 'unchecked'));
alter table mechalol_pages_temp drop constraint if exists mechalol_pages_temp_source_state_check;
alter table mechalol_pages_temp
    add constraint mechalol_pages_temp_source_state_check
    check (source_state in ('current', 'ahead', 'no_baseline', 'unchecked'));

-- 2. אינדקסים חלקיים (שמות בתבנית שה-swap משנה: mechalol_pages_<..> / mechalol_pages_temp_<..>).
create index if not exists mechalol_pages_source_state_idx
    on mechalol_pages (source_state) where source_state = 'ahead';
create index if not exists mechalol_pages_temp_source_state_idx
    on mechalol_pages_temp (source_state) where source_state = 'ahead';

-- שורות בהיקף שטרם פוענחו או שהפענוח שלהן ישן.
create index if not exists mechalol_pages_sort_template_pending_idx
    on mechalol_pages (id)
    where status = 'מיובא ומתועד' and not is_dictionary_entry and not needs_attention
      and sort_template_parsed_rev is distinct from rev_id;
create index if not exists mechalol_pages_temp_sort_template_pending_idx
    on mechalol_pages_temp (id)
    where status = 'מיובא ומתועד' and not is_dictionary_entry and not needs_attention
      and sort_template_parsed_rev is distinct from rev_id;

-- 3. forward-fill: מורחבת גם ל-mechalol_pages וגם לעמודות הגרסה בוויקיפדיה.
create or replace function forward_fill_enrichment_temp()
returns void
language sql
set search_path to 'public'
as $$
    update wikipedia_pages_temp as new
    set wikidata_desc = old.wikidata_desc,
        created_at = old.created_at,
        created_at_checked = old.created_at_checked,
        easy_import_length = old.easy_import_length,
        easy_import_has_images = old.easy_import_has_images,
        problematic_words_clean = old.problematic_words_clean,
        easy_import_checked = old.easy_import_checked,
        mechalol_redirect_exists = old.mechalol_redirect_exists,
        latest_rev_id = old.latest_rev_id,
        latest_rev_ts = old.latest_rev_ts
    from wikipedia_pages as old
    where new.id = old.id;

    update mechalol_pages_temp as new
    set rev_id = old.rev_id,
        rev_ts = old.rev_ts,
        sort_template_rev = old.sort_template_rev,
        sort_template_title = old.sort_template_title,
        sort_template_date = old.sort_template_date,
        sort_template_parsed_rev = old.sort_template_parsed_rev,
        source_state = old.source_state
    from mechalol_pages as old
    where new.id = old.id;
$$;

-- 4. חישוב source_state. p_ids = null: כל השורות; אחרת רק אלה (עדכון שעתי).
create or replace function recompute_source_state(p_ids bigint[] default null)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
begin
    update mechalol_pages m
    set source_state = s.state
    from (
        select m2.id,
               case
                   when m2.sort_template_rev is null then 'no_baseline'
                   when w.latest_rev_id is null then 'unchecked'
                   when w.latest_rev_id = m2.sort_template_rev then 'current'
                   else 'ahead'
               end as state
        from mechalol_pages m2
        left join wikipedia_pages w on w.id = m2.wikipedia_id
        where m2.status = 'מיובא ומתועד'
          and not m2.is_dictionary_entry
          and not m2.needs_attention
          and (p_ids is null or m2.id = any (p_ids))
    ) s
    where m.id = s.id
      and m.source_state is distinct from s.state;

    -- שורה שיצאה מההיקף (ערך הפך למילוני וכו') - מחזירים ל-NULL.
    update mechalol_pages m
    set source_state = null
    where m.source_state is not null
      and (p_ids is null or m.id = any (p_ids))
      and not (m.status = 'מיובא ומתועד' and not m.is_dictionary_entry and not m.needs_attention);
end;
$$;

revoke all on function recompute_source_state(bigint[]) from public, anon, authenticated;
grant execute on function recompute_source_state(bigint[]) to service_role;

-- 5. דוח: ערכים שוויקיפדיה התקדמה בהם. בלי JOIN (הגאדג'ט שולף את הגרסה העדכנית חי).
create or replace view report_source_ahead with (security_invoker = true) as
select m.id,
       m.title,
       m.wikipedia_id,
       m.sort_template_rev,
       m.sort_template_title,
       m.sort_template_date,
       m.rev_ts
from mechalol_pages m
where m.source_state = 'ahead';

grant select on report_source_ahead to anon, authenticated, service_role;

notify pgrst, 'reload schema';

-- ---------------------------------------------------------------------------
-- פתוח לפני הרצה:
-- 1. חלון אובדן: שינוי שנכתב לטבלה הפעילה בין forward_fill לבין ה-swap לא מגיע
--    לטבלה הזמנית, וה-watermark של הדלתא כבר עבר אותו. יש לפצות (החזרת ה-watermark
--    לתחילת הסבב, או ריצה של הדלתא מיד אחרי ה-swap). אותו חלון קיים בעמודות
--    ההעשרה האחרות; כאן הוא משפיע על עדכניות בלבד.
-- 2. מילוי ראשוני: latest_rev_id ב-wikipedia_pages מגיע מדמפ/קובץ (או ה-API);
--    rev_id וההעשרה של mechalol_pages מסקריפט חילוץ בחלקים. אין כאן קוד ריצה.
-- 3. מדידת forward_fill: הפונקציה הזו כבר נתקעה פעם בתוכנית שאילתה גרועה
--    (migration_add_analyze_function.sql). לאחר הרצה ראשונה לבדוק זמן, ולהריץ
--    ANALYZE על הטבלה הזמנית לפני העדכון השני אם צריך.
-- ---------------------------------------------------------------------------
