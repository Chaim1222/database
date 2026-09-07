-- migration_add_manual_matches_auth_policy.sql
--
-- מאפשר לתפקיד authenticated (מי שהתחבר בהצלחה דרך Supabase Auth
-- בפאנל הניהול בגאדג'ט) לנהל את manual_matches - קריאה, הוספה,
-- עדכון ומחיקה. anon לא מקבל שום גישה נוספת (RLS ממשיך לחסום אותו
-- לגמרי - אין לו policy בכלל, בדיוק כמו היום).
--
-- מצב היום, אומת ישירות (2026-09): GRANT SELECT כבר קיים ל-anon/
-- authenticated על manual_matches, אבל אין אף RLS policy - כלומר גם
-- SELECT חסום בפועל לשניהם. חסרים גם GRANT INSERT/UPDATE/DELETE.
--
-- מי בכלל "authenticated" כאן: רק מי שיש לו חשבון אמיתי בסופרבייס
-- (Authentication -> Users) - לא הרשמה עצמית פתוחה. לכן "כל authenticated
-- מותר" (using(true)) סביר - יצירת החשבון עצמה כבר השער.

grant insert, update, delete on manual_matches to authenticated;

create policy "authenticated יכול לנהל התאמות ידניות" on manual_matches
    for all
    to authenticated
    using (true)
    with check (true);

notify pgrst, 'reload schema';
