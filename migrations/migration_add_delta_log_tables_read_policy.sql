-- מוסיף מדיניות RLS "קריאה ציבורית" (זהה בדיוק לזו שכבר קיימת על
-- wikipedia_pages/mechalol_pages) לעשר טבלאות הדלתא/ביקורת. כולן כבר
-- קיבלו GRANT SELECT ל-anon/authenticated (migration_restrict_delta_
-- log_tables_grants.sql), אבל RLS מופעל עליהן בלי אף מדיניות - כשRLS
-- מופעל בלי מדיניות, כל שורה חסומה לכל תפקיד שאינו service_role, לא
-- משנה מה ה-GRANT אומר. שתי שכבות נפרדות: GRANT קובע אם מותר בכלל
-- להריץ SELECT, RLS קובע אילו שורות ייראו בפועל.
--
-- התגלה תוך כדי בניית תכונת "רמז אוטומטי" בגאדג'ט (חיפוש מול
-- wikipedia_renames/wikipedia_deletions דרך מפתח anon) - הרשאות היו
-- תקינות אבל כל שאילתה החזירה אפס שורות בשקט, בלי שגיאה.

create policy "קריאה ציבורית" on wikipedia_creations for select to anon using (true);
create policy "קריאה ציבורית" on mechalol_creations for select to anon using (true);
create policy "קריאה ציבורית" on wikipedia_deletions for select to anon using (true);
create policy "קריאה ציבורית" on mechalol_deletions for select to anon using (true);
create policy "קריאה ציבורית" on wikipedia_renames for select to anon using (true);
create policy "קריאה ציבורית" on mechalol_renames for select to anon using (true);
create policy "קריאה ציבורית" on mechalol_status_update_log for select to anon using (true);
create policy "קריאה ציבורית" on sync_watermarks for select to anon using (true);
create policy "קריאה ציבורית" on reconciliation_audit for select to anon using (true);
create policy "קריאה ציבורית" on reconciliation_audit_details for select to anon using (true);
