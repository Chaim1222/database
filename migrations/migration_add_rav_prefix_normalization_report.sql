-- דוח לבדיקת ההתאמות שהוציאו ערך מרשימת "חסר במכלול" רק בזכות
-- נרמול הקידומת "הרב"/"רבי". הדוח אינו יוצר התאמה ואינו משנה
-- wikipedia_id; הוא רק חושף את המועמד או המועמדים שכבר גרמו ל-
-- missing_override_reason='rav_prefix_normalization'.
--
-- שורה אחת נוצרת לכל מועמד במכלול. candidate_count הוא מספר המועמדים
-- שנמצאו לאותו ערך בוויקיפדיה, כדי שלא לבחור בשקט מועמד יחיד כשיש
-- יותר מאפשרות אחת.

create or replace view report_rav_prefix_normalization as
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

-- בפרויקט הזה ברירת המחדל של הרשאות על עצם חדש רחבה מדי, לכן נועלים
-- במפורש ל-select בלבד, כמו שאר דוחות report_*.
revoke all on report_rav_prefix_normalization from anon, authenticated;
grant select on report_rav_prefix_normalization to anon, authenticated;

notify pgrst, 'reload schema';
notify pgrst, 'reload config';
