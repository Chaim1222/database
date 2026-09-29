-- migration_add_sort_template_sync_state.sql
--
-- מצב העדכון השעתי של מעקב גרסת המקור (scripts/sort_template_hourly.py): נקודת התקדמות נפרדת לכל
-- אתר, מתי הצליח לאחרונה, וכמה כשלונות רצופים. טבלה נפרדת מ-sync_watermarks של הדלתא הלילית
-- (שהאילוץ שלה מאפשר רק 'wikipedia'/'mechalol'), כדי שלא להתערב בה.
-- לא מושפעת מהחלפת הטבלאות השבועית. קריאה וכתיבה: service_role בלבד.
--
-- watermark_ts = מתי התחלה הריצה האחרונה שהצליחה (לא הנתון האחרון שנקלט); הסקריפט קורא
-- מ-5 דקות לפני הנקודה (חפיפה) כי רשומות recentchanges יכולות להופיע באיחור.
-- ערכי ההתחלה: מכלול - תחילת הטעינה הראשונה של הפענוח (עריכות שנעשו אחריה אחרי שדף פוענח
-- לא נקלטו); ויקיפדיה - סוף השלמת הפער אחרי הדמפ (עם חפיפה). idempotent.

create table if not exists sort_template_sync_state (
    stream               text primary key check (stream in ('mechalol_changes', 'wikipedia_changes')),
    watermark_ts         timestamptz not null,
    last_success_at      timestamptz,
    consecutive_failures integer not null default 0,
    last_error           text,
    updated_at           timestamptz not null default now()
);

insert into sort_template_sync_state (stream, watermark_ts) values
    ('mechalol_changes', timestamptz '2026-09-29 21:00:00+00'),
    ('wikipedia_changes', timestamptz '2026-09-29 22:05:00+00')
on conflict (stream) do nothing;

alter table sort_template_sync_state enable row level security;
revoke all on sort_template_sync_state from anon, authenticated;
grant select, insert, update, delete on sort_template_sync_state to service_role;

notify pgrst, 'reload schema';
