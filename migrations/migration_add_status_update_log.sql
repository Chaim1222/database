-- migration_add_status_update_log.sql
--
-- מתעד היסטורית איזה page_id-ים במכלול קיבלו "הזדמנות" להיבדק מחדש
-- דרך מנגנון detect_edited_tracked_changes (עריכה רגילה שמזוהה דרך
-- fetch_edited_page_ids, לא יצירה/מחיקה/שינוי-שם) - עד עכשיו
-- mechalol_delta_changed_ids.json (קובץ זמני, נעלם בסוף כל ריצה) היה
-- המקום היחיד שבו זה נרשם, אז log_reconciliation_diff() לא היה יכול
-- לדעת בדיעבד אם id מסוים כבר "קיבל סיכוי" להיבדק מחדש דרך match.py
-- --scoped (כולל שלב ה-TEMPLATE API) לפני שהפיוס המלא תפס אותו - היה
-- סופר "פער" גם על שורות שהדלתא כבר ניסתה לטפל בהן, לא רק על שורות
-- שהיא מעולם לא ראתה.
create table if not exists mechalol_status_update_log (
    id bigserial primary key,
    page_id bigint not null,
    title text not null,
    fetched_at timestamptz not null default now(),
    unique (page_id, fetched_at)
);

alter table mechalol_status_update_log enable row level security;
-- בכוונה בלי אף policy - כמו שאר טבלאות הדלתא (wikipedia_creations
-- וכו') - anon/authenticated חסומים לגמרי, service_role עוקף RLS.

create index if not exists idx_mechalol_status_update_log_page_id
    on mechalol_status_update_log(page_id);
