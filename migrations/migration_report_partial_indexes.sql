-- אינדקסים חלקיים לדוחות הגאדג'ט (2026-09-24). כל דוח מחפש כמה מאות
-- שורות בתוך טבלה של ~400 אלף, ובלי אינדקס מתאים כל שאילתה סרקה את
-- הטבלה כולה. כשהמטמון קר והגאדג'ט שולח כתריסר שאילתות במקביל, חלק
-- מהן חרגו מ-statement_timeout (15 שניות ל-anon) והחזירו 500.
--
-- התנאי של כל אינדקס זהה בדיוק ל-WHERE של ה-view (views.sql) - אחרת
-- המתכנן לא ישתמש בו. שינוי תנאי ב-view מחייב לעדכן גם את האינדקס.
-- נוצרים על שני העותקים (פעיל וזמני), עם שם שמתחיל בשם הטבלה, כדי ש-
-- perform_atomic_swap ישנה את שמם נכון בהחלפה השבועית.

create index if not exists mechalol_pages_tasks_idx on mechalol_pages (title) where needs_attention = false and is_dictionary_entry = false and (maybe_deleted_from_wikipedia = true or status = 'מיובא ללא תיעוד' or (template_referenced_title is not null and status <> 'נשמר במכלול למרות מחיקה בוויקיפדיה') or template_check_access_denied_at is not null);
create index if not exists mechalol_pages_temp_tasks_idx on mechalol_pages_temp (title) where needs_attention = false and is_dictionary_entry = false and (maybe_deleted_from_wikipedia = true or status = 'מיובא ללא תיעוד' or (template_referenced_title is not null and status <> 'נשמר במכלול למרות מחיקה בוויקיפדיה') or template_check_access_denied_at is not null);

create index if not exists mechalol_pages_maybe_deleted_idx on mechalol_pages (title) where maybe_deleted_from_wikipedia = true;
create index if not exists mechalol_pages_temp_maybe_deleted_idx on mechalol_pages_temp (title) where maybe_deleted_from_wikipedia = true;

create index if not exists mechalol_pages_undocumented_idx on mechalol_pages (title) where status = 'מיובא ללא תיעוד' and needs_attention = false and is_dictionary_entry = false;
create index if not exists mechalol_pages_temp_undocumented_idx on mechalol_pages_temp (title) where status = 'מיובא ללא תיעוד' and needs_attention = false and is_dictionary_entry = false;

create index if not exists wikipedia_pages_rav_override_idx on wikipedia_pages (title) where missing_override_reason = 'rav_prefix_normalization';
create index if not exists wikipedia_pages_temp_rav_override_idx on wikipedia_pages_temp (title) where missing_override_reason = 'rav_prefix_normalization';

analyze mechalol_pages;
analyze wikipedia_pages;
