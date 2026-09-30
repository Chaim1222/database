-- מצב: נבדק מקומית (PostgreSQL 16, נתונים סינתטיים בהיקף ייצור: 400K ויקיפדיה / 380K מכלול + 17 מקרי קצה),
-- **לא הורץ בייצור**; הרצה רק באישור המשתמש, מחוץ לריצה השבועית. תוצאות הבדיקה המקומית:
--   זהות מול הפונקציות הישנות: 0 הבדלים ב-recompute_missing_flag, _scoped, _by_titles, _temp ובדוח
--   report_rav_prefix_normalization (38,009 שורות בשני הצדדים), כולל קידומת כפולה, רווחים, טאב, רווח קשיח.
--   זמנים (מקומי, מול הישנה עם האינדקס המלא): מלאה 11.0s מול 10.7s; _temp 7.0s; by_titles 500 כותרות 5.3s מול 4.6s.
-- עדיין לא נבדק: תוכניות הביצוע על הסטטיסטיקות האמיתיות בייצור, ומסלול perform_atomic_swap (שינוי שמות
-- האינדקס החדש). בייצור נמדד בנפרד (קריאה בלבד): 374,110 מ-381,738 כותרות זהות לנרמול, ו-376,667 התאמות
-- מנורמלות בשני הניסוחים ללא הבדל.

-- migration_partial_normalize_person_title_idx.sql
--
-- הופך את האינדקס על normalize_person_title(title) ב-mechalol_pages לחלקי.
--
-- למה: האינדקס המלא (30 MB, ועוד כמותו בטבלה הזמנית בשיא ההחלפה השבועית)
-- מכיל כמעט רק כפילות של mechalol_pages_title_key: ב-374,110 מתוך 381,738
-- שורות (98%, נמדד 2026-09-30) normalize_person_title(title) = title.
-- רק 7,628 שורות (קידומת "הרב"/"רבי") שונות.
--
-- שקילות לוגית (לא תלויה בנתונים הנוכחיים): לכל שורת מכלול m ו-n =
-- normalize_person_title(w.title):
--     normalize(m.title) = n
--  ⟺ (normalize(m.title) =  m.title AND m.title = n)   -- שורה שהנרמול לא משנה
--  או (normalize(m.title) <> m.title AND normalize(m.title) = n)  -- שורה שמשתנה
-- הפיצול הוא על תנאי הנרמול עצמו ולא על ביטוי רגולרי, ולכן הוא תופס גם
-- מקרי קצה (רווחים בקצוות, קידומת כפולה) בדיוק כמו המקור. האינדקס החלקי
-- מכסה את הענף השני (predicate זהה לתנאי בשאילתה - חובה לשמור אותו זהה),
-- והענף הראשון נשען על mechalol_pages_title_key.
--
-- בדיקת זהות על כל נתוני הייצור (2026-09-30): 376,667 התאמות בשני הניסוחים,
-- 0 הבדלים. בדיקה מקומית עם מקרי קצה: ראו את הדוח בסוף NOTES/README.
--
-- להריץ פעם אחת, לא בזמן הריצה השבועית (perform_atomic_swap משנה שמות
-- אינדקסים; ראו את ההערה על קידומת שם בהמשך). הכל בטרנזקציה אחת.
-- הקובץ מעדכן גם ב-schema/schema.sql וב-schema/views.sql.

begin;

-- 1. האינדקס החלקי. השם מתחיל ב-"<טבלה>_" כדי ש-perform_atomic_swap ישנה
-- אותו נכון בהחלפה (כמו שאר האינדקסים).
create index if not exists mechalol_pages_normalize_person_title_rav_idx
    on mechalol_pages (normalize_person_title(title))
    where normalize_person_title(title) <> title;
create index if not exists mechalol_pages_temp_normalize_person_title_rav_idx
    on mechalol_pages_temp (normalize_person_title(title))
    where normalize_person_title(title) <> title;

-- 2. הפונקציות. הגדרות מלאות (create or replace מחליף גם את SET; ההרשאות נשמרות).
-- מבנה: איחוד של כל ההתאמות (kind 1 = ישירה: wikipedia_id/כותרת זהה; kind 2 = מנורמלת),
-- min(kind) לכל id, ו-update יחיד עם left join. הסמנטיקה זהה למקור: ישירה גוברת
-- (is_missing=false, הסיבה NULL); אחרת מנורמלת (is_missing=false, 'rav_prefix_normalization');
-- אחרת חסר. למה לא exists(...)/in(select) כמו המקור: בבדיקה מקומית (400K שורות) שתי
-- הגרסאות הישירות נכשלו בביצועים - exists בשני תנאים הפך ל-SubPlan עם סריקה מלאה לכל
-- שורה, ו-in(select) מ-CTE נשבר כי המתכנן העריך 756 מיליון שורות (השוואת ביטויים בלי
-- סטטיסטיקה = ברירת מחדל 0.5%) ולא בנה hash. הצורה כאן לא תלויה בהערכות כאלה.

create or replace function recompute_missing_flag()
returns void
language sql
set search_path = public
as $$
    with s as (
        select w.id, w.title from wikipedia_pages w
    ),
    hits as (
        select id, min(kind) as k
        from (
            select s.id, 1 as kind from s join mechalol_pages m on m.wikipedia_id = s.id
            union all
            select s.id, 1 from s join mechalol_pages m on m.title = s.title
            union all
            select s.id, 2 from s join mechalol_pages m
              on m.title = normalize_person_title(s.title) and normalize_person_title(m.title) = m.title
            union all
            select s.id, 2 from s join mechalol_pages m
              on normalize_person_title(m.title) <> m.title
             and normalize_person_title(m.title) = normalize_person_title(s.title)
        ) u
        group by id
    )
    update wikipedia_pages w
    set is_missing = (h.k is null),
        missing_override_reason = case h.k when 2 then 'rav_prefix_normalization' end
    from s
    left join hits h on h.id = s.id
    where w.id = s.id
      and (w.is_missing is distinct from (h.k is null)
           or w.missing_override_reason is distinct from case h.k when 2 then 'rav_prefix_normalization' end);
$$;

create or replace function recompute_missing_flag_scoped(ids bigint[])
returns void
language sql
set search_path = public
as $$
    with s as (
        select w.id, w.title from wikipedia_pages w
        where w.id = any(ids)
    ),
    hits as (
        select id, min(kind) as k
        from (
            select s.id, 1 as kind from s join mechalol_pages m on m.wikipedia_id = s.id
            union all
            select s.id, 1 from s join mechalol_pages m on m.title = s.title
            union all
            select s.id, 2 from s join mechalol_pages m
              on m.title = normalize_person_title(s.title) and normalize_person_title(m.title) = m.title
            union all
            select s.id, 2 from s join mechalol_pages m
              on normalize_person_title(m.title) <> m.title
             and normalize_person_title(m.title) = normalize_person_title(s.title)
        ) u
        group by id
    )
    update wikipedia_pages w
    set is_missing = (h.k is null),
        missing_override_reason = case h.k when 2 then 'rav_prefix_normalization' end
    from s
    left join hits h on h.id = s.id
    where w.id = s.id;
$$;

create or replace function recompute_missing_flag_by_titles(titles text[])
returns void
language sql
set search_path = public
as $$
    with s as (
        select w.id, w.title from wikipedia_pages w
        where w.title = any(titles)
           or normalize_person_title(w.title) = any(array(select normalize_person_title(t) from unnest(titles) as t))
    ),
    hits as (
        select id, min(kind) as k
        from (
            select s.id, 1 as kind from s join mechalol_pages m on m.wikipedia_id = s.id
            union all
            select s.id, 1 from s join mechalol_pages m on m.title = s.title
            union all
            select s.id, 2 from s join mechalol_pages m
              on m.title = normalize_person_title(s.title) and normalize_person_title(m.title) = m.title
            union all
            select s.id, 2 from s join mechalol_pages m
              on normalize_person_title(m.title) <> m.title
             and normalize_person_title(m.title) = normalize_person_title(s.title)
        ) u
        group by id
    )
    update wikipedia_pages w
    set is_missing = (h.k is null),
        missing_override_reason = case h.k when 2 then 'rav_prefix_normalization' end
    from s
    left join hits h on h.id = s.id
    where w.id = s.id;
$$;

create or replace function recompute_missing_flag_temp()
returns void
language sql
set search_path = public
as $$
    with s as (
        select w.id, w.title from wikipedia_pages_temp w
    ),
    hits as (
        select id, min(kind) as k
        from (
            select s.id, 1 as kind from s join mechalol_pages_temp m on m.wikipedia_id = s.id
            union all
            select s.id, 1 from s join mechalol_pages_temp m on m.title = s.title
            union all
            select s.id, 2 from s join mechalol_pages_temp m
              on m.title = normalize_person_title(s.title) and normalize_person_title(m.title) = m.title
            union all
            select s.id, 2 from s join mechalol_pages_temp m
              on normalize_person_title(m.title) <> m.title
             and normalize_person_title(m.title) = normalize_person_title(s.title)
        ) u
        group by id
    )
    update wikipedia_pages_temp w
    set is_missing = (h.k is null),
        missing_override_reason = case h.k when 2 then 'rav_prefix_normalization' end
    from s
    left join hits h on h.id = s.id
    where w.id = s.id
      and (w.is_missing is distinct from (h.k is null)
           or w.missing_override_reason is distinct from case h.k when 2 then 'rav_prefix_normalization' end);
$$;

-- 3. הדוח: אותה הצטרפות, בשני חלקים זרים (השורות של m מתפצלות לפי
-- normalize(m.title) = / <> m.title, כך שאין כפילויות ב-UNION ALL).
create or replace view report_rav_prefix_normalization with (security_invoker = true) as
with pairs as (
    select w.id as wikipedia_id, w.title as wikipedia_title,
           normalize_person_title(w.title) as normalized_title, m.id as mechalol_id,
           m.title as mechalol_title, m.status as mechalol_status,
           m.source_type as mechalol_source_type, m.match_type as mechalol_match_type
    from wikipedia_pages w
    join mechalol_pages m
      on m.title = normalize_person_title(w.title) and normalize_person_title(m.title) = m.title
    where w.missing_override_reason = 'rav_prefix_normalization'
    union all
    select w.id, w.title, normalize_person_title(w.title), m.id, m.title, m.status, m.source_type, m.match_type
    from wikipedia_pages w
    join mechalol_pages m
      on normalize_person_title(m.title) <> m.title
     and normalize_person_title(m.title) = normalize_person_title(w.title)
    where w.missing_override_reason = 'rav_prefix_normalization'
),
candidates as (
    select pairs.*, count(*) over (partition by wikipedia_id) as candidate_count from pairs
)
-- >>> החלק הזה חייב להישאר זהה לסוף ה-view הנוכחי ב-views.sql (עמודות והסדר). <<<
select
    wikipedia_id,
    wikipedia_title,
    normalized_title,
    mechalol_id,
    mechalol_title,
    mechalol_status,
    mechalol_source_type,
    mechalol_match_type,
    candidate_count
from candidates
order by wikipedia_title, mechalol_title;

-- 4. הסרת האינדקסים המלאים, רק אחרי שהחלופה והפונקציות במקום.
drop index if exists mechalol_pages_normalize_person_title_idx;
drop index if exists mechalol_pages_temp_normalize_person_title_idx;

commit;
