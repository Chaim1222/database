-- Views לבעיות לטיפול, ממוקדים בערכי תוכן במרחב הראשי בלבד.
-- needs_attention=true (דפים ריקים) ו-is_dictionary_entry=true (תקצירים
-- מילוניים) מוחרגים מ-report_undocumented_import/report_tasks_to_handle
-- (כפי שנתבקש), אבל *לא* מ-report_possibly_deleted_source (מ-2026-09 -
-- אומת בנתונים אמיתיים ש-40 שורות עם maybe_deleted_from_wikipedia=true
-- היו מוסתרות שם בטעות רק בגלל is_dictionary_entry=true). להרצה
-- חד-פעמית בעורך ה-SQL של סופרבייס.
--
-- הוסרו (היו תלויים בעמודות שנמחקו עם המעבר לריקון-ומילוי-מחדש):
-- report_confirmed_deleted_from_wikipedia (deleted_from_wikipedia),
-- report_title_changed_since_match (matched_title).
--
-- כל ה-views רצים בהרשאות הקורא (security_invoker = true, תוקן 2026-09
-- ב-migration_review_fixes_2026_09.sql) - כפופים ל-RLS של הטבלאות
-- שמתחתן. דורש policy קריאה ל-anon על כל טבלה שהם קוראים, כולל
-- blacklist_titles (ראו schema.sql). perform_atomic_swap משמרת את
-- האפשרות הזו כשהיא בונה את ה-views מחדש בכל החלפה.

-- 1. חשוד כמחיקה/בעיית התאמה: מקור ודאי-ויקיפדי או לא-ידוע, בלי
--    התאמה לוויקיפדיה בריצה הנוכחית. עשוי לנבוע ממחיקה אמיתית, מכותרת
--    שונה + דף נעול-לקריאה (מועמד ל-manual_matches), מטעות הקלדה
--    בתבנית המיון, או מכותרת שדורשת כלל נרמול חדש. כולל גם ערכים
--    מילוניים/דפים-לטיפול (מ-2026-09 - ראו הערה למעלה).
create or replace view report_possibly_deleted_source with (security_invoker = true) as
select id, title, status, source_type, match_type
from mechalol_pages
where maybe_deleted_from_wikipedia = true
order by title;

-- 2. מיובא ללא תיעוד (בדשבורד: "ללא תבנית מיון"): אין תבנית מיון תקינה (או שמעולם
--    לא נבדק/לא שויך לקטגוריה - אין הבדלה בין השניים כרגע, ראו fetch_mechalol.py).
--    שיוך ידני (manual_matches) = טופל, ולכן מוסתר (migration_exclude_manual_matches_from_maintenance.sql,
--    הורץ בייצור ב-2026-10-01).
create or replace view report_undocumented_import with (security_invoker = true) as
select id, title, source_type, wikipedia_id, match_type
from mechalol_pages
where status = 'מיובא ללא תיעוד'
  and needs_attention = false
  and is_dictionary_entry = false
  and not exists (select 1 from manual_matches mm where mm.mechalol_page_id = mechalol_pages.id)
order by title;

-- (שינוי ב-WHERE כאן מחייב לעדכן גם את mechalol_pages_tasks_idx - ראו
-- migration_report_partial_indexes.sql)
-- 3. משימות לטיפול - עמודת task_type מבחינה בין סוגים שדורשים פעולה
--    שונה (הופרדו 2026-09, קודם היו מעורבים):
--    א. שם בתבנית המיון לא קיים בוויקיפדיה (template_referenced_title) -
--       בדרך כלל הערך שונה שם בוויקיפדיה; מתקנים את התבנית. לא כולל
--       "נשמר במכלול למרות מחיקה בוויקיפדיה" - שם זה המצב הצפוי.
--    ב. לא נמצא מקביל בוויקיפדיה (maybe_deleted_from_wikipedia, בלי תבנית
--       עם שם) - לבדוק אם נמחק או קיים בשם אחר.
--    ג. דף נעול - לא ניתן לאמת (template_check_access_denied_at).
--    ד. חסרה תבנית מיון - המכלול עצמו מסמן את הדף (source_type=missing_sort).
--    ה. מקור לא ידוע - מיובא ללא תיעוד, בלי שום סימון.
--    לא כולל דפי טיפול (needs_attention) ולא ערכים מילוניים
--    (is_dictionary_entry) - כפי שנתבקש במפורש (בניגוד ל-report_
--    possibly_deleted_source למעלה).
create or replace view report_tasks_to_handle with (security_invoker = true) as
select
    id,
    title,
    status,
    source_type,
    wikipedia_id,
    match_type,
    case
        when template_referenced_title is not null
             and status <> 'נשמר במכלול למרות מחיקה בוויקיפדיה'
            then 'שם בתבנית המיון לא קיים בוויקיפדיה'
        when maybe_deleted_from_wikipedia = true
            then 'לא נמצא מקביל בוויקיפדיה'
        when template_check_access_denied_at is not null
            then 'דף נעול - לא ניתן לאמת'
        when source_type = 'missing_sort'
            then 'חסרה תבנית מיון'
        else 'מקור לא ידוע'
    end as task_type
from mechalol_pages
where needs_attention = false
  and is_dictionary_entry = false
  and (
    maybe_deleted_from_wikipedia = true
    or status = 'מיובא ללא תיעוד'
    or (template_referenced_title is not null and status <> 'נשמר במכלול למרות מחיקה בוויקיפדיה')
    or template_check_access_denied_at is not null
  )
order by task_type, title;

-- 4. קיים בוויקיפדיה, אין לו התאמה במכלול בכלל - מסונן מרשימה שחורה
--    (blacklist_titles: ערכים שבכוונה לא יובאו, אין טעם להציג אותם
--    כ"חסרים"). התאמה לפי כותרת מדויקת בלבד, בכוונה (נבדק 2026-09):
--    כל השורות ב-blacklist_titles נוספו אוטומטית ע"י check_missing_
--    locked.py כי *הכותרת* נעולה ליצירה במכלול. הנעילה היא על כותרת,
--    לא על נושא - אם הערך בוויקיפדיה שונה שם, הכותרת החדשה לא בהכרח
--    נעולה, ולכן נכון שיופיע שוב (הבדיקה השבועית תנעל אותו אם צריך).
--    סינון לפי wikipedia_id היה מסתיר ערכים שאפשר ליצור בפועל.
-- מקור האמת: is_missing (מתוחזק ב-recompute_missing_flag/_scoped,
-- schema.sql) - לא JOIN חי כמו קודם. שינוי מדעת: join חי תמיד היה
-- מדויק ברגע השאילתה בלי תלות בשום דבר, אבל is_missing כולל גם כותרת
-- זהה ונירמול קידומת רבנית (לא רק wikipedia_id) - במחיר של פיגור עד
-- לריצה הלילית הבאה (ראו תיעוד is_missing ב-schema.sql). סדר העמודות
-- כאן חייב להישאר זהה אם מריצים על view קיים - Postgres לא מרשה
-- לשנות שם/סדר עמודות ב-CREATE OR REPLACE VIEW.
create or replace view report_missing_from_mechalol with (security_invoker = true) as
select w.id,
    w.title,
    w.checked_at,
    w.wikidata_desc,
    w.easy_import_length,
    w.easy_import_has_images,
    w.problematic_words_clean,
    w.created_at,
    w.mechalol_redirect_exists,
    w.easy_import_checked,
    w.created_at_checked
from wikipedia_pages w
where w.is_missing = true
  and not exists (
    select 1 from blacklist_titles b where b.title = w.title
  )
order by w.title;


-- 5. התאמות קידומת רבנית לבדיקה: ערכי ויקיפדיה שסומנו כלא-חסרים רק
--    מפני שנמצאה במכלול כותרת זהה אחרי הסרת הקידומת "הרב"/"רבי".
--    אין כאן יצירת wikipedia_id ואין בחירת מועמד: אם כמה דפי מכלול
--    מתנרמלים לאותו שם, כולם מוצגים ו-candidate_count מציין כמה נמצאו.
create or replace view report_rav_prefix_normalization with (security_invoker = true) as
with candidates as (
    select
        w.id as wikipedia_id,
        w.title as wikipedia_title,
        normalize_person_title(w.title) as normalized_title,
        m.id as mechalol_id,
        m.title as mechalol_title,
        m.status as mechalol_status,
        m.source_type as mechalol_source_type,
        m.match_type as mechalol_match_type,
        count(*) over (partition by w.id) as candidate_count
    from wikipedia_pages w
    join mechalol_pages m
      on normalize_person_title(m.title) = normalize_person_title(w.title)
    where w.missing_override_reason = 'rav_prefix_normalization'
)
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

-- 6. "חסר במכלול" + סינון התוכן (word-filter/, 2026-09): report_missing_from_mechalol
--    עם תוצאות word_filter_results. left join - ערך שעוד לא נסרק מופיע עם רמות ריקות.
--    נשען על ה-view (לא ישירות על wikipedia_pages), ולכן perform_atomic_swap לא
--    צריכה לבנות אותו מחדש. עמודות חדשות רק בסוף.
create or replace view report_missing_word_filter with (security_invoker = true) as
select m.id, m.title, m.checked_at, m.wikidata_desc, m.easy_import_length, m.created_at, m.mechalol_redirect_exists,
    r.verdict, r.verdict_suggested, r.has_images, r.photo_count, r.counts, r.matches_total, r.images, r.scanned_at,
    r.ctx_verdict, r.ctx_suspicion, r.ctx_verdict_suggested, r.ctx_suspicion_suggested,
    r.hidden_count, r.hidden_count_suggested,
    r.dictionary, r.dictionary_why,
    r.topic,
    r.names_count, r.names_count_suggested
from report_missing_from_mechalol m
left join word_filter_results r on r.wikipedia_id = m.id;

-- 7. ספירה מקובצת למחוון הפילוח בדשבורד (מאות שורות במקום 25 אלף).
--    dictionary ו-topic לפני n - שינוי בהם מחייב drop + create (migration_add_word_filter_topic.sql).
create or replace view report_missing_word_filter_summary with (security_invoker = true) as
select coalesce(mechalol_redirect_exists, false) as redirect, has_images,
    verdict, verdict_suggested, ctx_verdict, ctx_suspicion, ctx_verdict_suggested, ctx_suspicion_suggested,
    dictionary is not null as dictionary,
    topic,
    count(*)::int as n
from report_missing_word_filter
group by 1, 2, 3, 4, 5, 6, 7, 8, 9, 10;

-- 8. סימוני התראות לכל רשומה ברשימות (word_filter_feedback, migration_add_word_filter_feedback.sql).
create or replace view word_filter_feedback_summary with (security_invoker = true) as
select e.entry_id,
    count(*) filter (where f.label = 'false')::int as false_marks,
    count(*) filter (where f.label = 'true')::int as true_marks,
    count(distinct f.wikipedia_id)::int as pages,
    round(count(*) filter (where f.label = 'false')::numeric / count(*), 2) as false_share,
    (array_agg(distinct f.word) filter (where f.label = 'false'))[1:10] as false_words,
    max(f.created_at) as last_marked
from word_filter_feedback f
cross join lateral unnest(f.entries) as e(entry_id)
group by e.entry_id;

-- --- הרשאות: קיימות בייצור, מעולם לא תועדו כאן עד 2026-09 ---
-- מלכוד שהתגלה בפועל: view חדש שנוצר עם create or replace view רגיל
-- (כמו שלושת הראשונים למעלה, כשהם נוצרו לראשונה) יורש את אותה ברירת
-- מחדל רחבה-מדי כמו טבלה חדשה (pg_default_acl) - קיבל בטעות INSERT/
-- UPDATE/DELETE/TRUNCATE ל-anon/authenticated, לא רק SELECT. אומת מול
-- המסד ותוקן ב-2026-09 (report_missing_from_mechalol למטה כבר היה
-- מוגבל נכון מלכתחילה, לא ברור למה רק הוא). ראו migration_document_
-- rls_and_grants.sql לתיעוד המלא כולל הטבלאות והפונקציות.
revoke all on report_possibly_deleted_source from anon, authenticated;
revoke all on report_tasks_to_handle from anon, authenticated;
revoke all on report_undocumented_import from anon, authenticated;
revoke all on report_missing_from_mechalol from anon, authenticated;
revoke all on report_rav_prefix_normalization from anon, authenticated;
revoke all on report_missing_word_filter, report_missing_word_filter_summary from anon, authenticated;
revoke all on word_filter_feedback_summary from anon, authenticated;

grant select on report_possibly_deleted_source to anon, authenticated;
grant select on report_tasks_to_handle to anon, authenticated;
grant select on report_undocumented_import to anon, authenticated;
grant select on report_missing_from_mechalol to anon, authenticated;
grant select on report_rav_prefix_normalization to anon, authenticated;
grant select on report_missing_word_filter, report_missing_word_filter_summary to anon, authenticated;
grant select on word_filter_feedback_summary to anon, authenticated;

-- משימות גרסה (2026-10-01): ארבעה טאבים בדשבורד - העברת שם / הפכו להפניה / גרסה שגויה / נמחקו לפי גרסה.
-- מקור: rev_link_check (טבלת עבודה שמעודכנת ב-scripts/rev_link_scan.py פעם בחודש; ראו
-- migration_rev_link_check_v2.sql והסעיף "בדיקת קישורים מול גרסת המקור" ב-README). שיוך ידני = טופל.
create or replace view report_rev_tasks with (security_invoker = true) as
select c.mechalol_id as id,
       m.title,
       m.status,
       c.rev_task,
       c.rev_id as sort_template_rev,
       m.sort_template_date,
       m.wikipedia_id,
       w.title as linked_title,
       c.rev_page_id,
       c.rev_page_title,
       c.checked_at
from rev_link_check c
join mechalol_pages m on m.id = c.mechalol_id
left join wikipedia_pages w on w.id = m.wikipedia_id
where c.rev_id is not distinct from m.sort_template_rev
  and not exists (select 1 from manual_matches mm where mm.mechalol_page_id = c.mechalol_id);

revoke all on report_rev_tasks from public, anon, authenticated;
grant select on report_rev_tasks to anon, authenticated, service_role;

-- דוחות ההעברה שהוחלו בייצור ב-6–7.10.2026; דורשים את טבלאות התחזוקה שב-schema.sql.
create or replace view public.report_wikipedia_move_candidates with (security_invoker = true) as
WITH last_move AS (
         SELECT DISTINCT ON (r.page_id, r.title) r.page_id,
            r.title AS old_title,
            r.event_at AS renamed_at
           FROM maintenance_wikipedia_events r
          WHERE r.kind = 'move'::text AND r.page_id > 0
          ORDER BY r.page_id, r.title, r.event_at DESC
        ), latest_move AS (
         SELECT DISTINCT ON (r.page_id) r.page_id,
            r.target_title AS new_title,
            r.target_namespace,
            r.event_at AS renamed_at
           FROM maintenance_wikipedia_events r
          WHERE r.kind = 'move'::text AND r.page_id > 0
          ORDER BY r.page_id, r.event_at DESC, r.id DESC
        ), current_source AS (
         SELECT lm.page_id,
            COALESCE(w_1.title, lm.new_title) AS title
           FROM latest_move lm
             LEFT JOIN wikipedia_pages w_1 ON w_1.id = lm.page_id
          WHERE w_1.id IS NOT NULL OR lm.target_namespace = 118 AND NOT (EXISTS ( SELECT
                   FROM maintenance_wikipedia_events d
                  WHERE d.kind = 'delete'::text AND d.namespace = 118 AND d.title = lm.new_title AND d.event_at >= lm.renamed_at AND NOT (EXISTS ( SELECT
                           FROM maintenance_wikipedia_events c
                          WHERE c.kind = 'restore'::text AND c.namespace = 118 AND c.page_id = lm.page_id AND c.title = lm.new_title AND c.event_at > d.event_at))))
        ), tpl AS (
         SELECT m_1.id,
            m_1.template_referenced_title
           FROM mechalol_pages m_1
          WHERE m_1.template_referenced_title IS NOT NULL AND m_1.status <> 'נשמר במכלול למרות מחיקה בוויקיפדיה'::text
        ), hits AS (
         SELECT m_1.id,
            'title'::text AS via,
            lm.page_id,
            lm.old_title,
            lm.renamed_at
           FROM last_move lm
             JOIN mechalol_pages m_1 ON m_1.title = lm.old_title
        UNION ALL
         SELECT t.id,
            'template'::text AS text,
            lm.page_id,
            lm.old_title,
            lm.renamed_at
           FROM last_move lm
             JOIN tpl t ON t.template_referenced_title = lm.old_title
        )
 SELECT h.id,
    m.title,
    w.title AS wikipedia_title,
    h.old_title,
    h.renamed_at,
    h.via,
    m.status,
    h.page_id AS wikipedia_id
   FROM hits h
     JOIN mechalol_pages m ON m.id = h.id
     JOIN current_source w ON w.page_id = h.page_id
  WHERE m.title <> w.title;
revoke all on public.report_wikipedia_move_candidates from public, anon, authenticated;
grant select on public.report_wikipedia_move_candidates to anon, authenticated, service_role;

create or replace view public.report_wikipedia_moves with (security_invoker = true) as
SELECT DISTINCT ON (h.id) h.id,
    h.title,
    h.wikipedia_title,
    h.old_title,
    h.renamed_at,
    h.via,
    h.status,
    h.wikipedia_id
   FROM report_wikipedia_move_candidates h
     JOIN mechalol_pages m ON m.id = h.id
  WHERE NOT (EXISTS ( SELECT
           FROM manual_matches mm
          WHERE mm.mechalol_page_id = h.id AND mm.wikipedia_page_id <> h.wikipedia_id)) AND NOT (EXISTS ( SELECT
           FROM maintenance_move_sources e
          WHERE e.mechalol_id = h.id AND e.mechalol_rev_id = m.rev_id AND m.sort_template_parsed_rev = m.rev_id AND e.source_rev_id = m.sort_template_rev AND e.source_wikipedia_id <> h.wikipedia_id))
  ORDER BY h.id, (h.via = 'title'::text) DESC, h.renamed_at DESC;
revoke all on public.report_wikipedia_moves from public, anon, authenticated;
grant select on public.report_wikipedia_moves to anon, authenticated, service_role;
