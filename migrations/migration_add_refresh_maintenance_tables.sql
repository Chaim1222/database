-- migration_add_refresh_maintenance_tables.sql
--
-- רענון טבלאות התחזוקה מתוך הדשבורד: refresh_maintenance_tables(p_apply) מסירה שורות שכבר לא אמורות להיות שם.
-- ברירת מחדל p_apply = false: **דוח בלבד** (מה היה נמחק), בלי שינוי. הגאדג'ט מציג את הדוח ורק אחרי אישור קורא עם true.
--
-- מה נחשב "לא אמור להיות שם" (רק מה שאפשר להכריע במסד, בלי API):
--   rev_link_check (טאבי העברת שם / הפכו להפניה / גרסה שגויה / נמחקו לפי גרסה):
--     page_gone     הערך לא קיים יותר ב-mechalol_pages
--     out_of_scope  יצא מההיקף (לא "מיובא ומתועד", ערך מילוני, needs_attention, או נעול לקריאה)
--     manual_match  קיים שיוך ידני (= טופל; report_rev_tasks כבר מסתיר, כאן הנתון עצמו נמחק)
--     rev_changed   rev_id בממצא שונה מ-sort_template_rev הנוכחי: העורך כבר עדכן את הגרסה, הממצא ישן
--   blacklist_titles (רק שורות אוטומטיות, reason 'נעול ליצירה%'; שורה ידנית אף פעם לא נמחקת, רק מדווחת):
--     exists_in_mechalol  הכותרת קיימת כבר כערך ב-mechalol_pages (נוצרה)
--     not_in_wikipedia    הכותרת כבר לא קיימת ב-wikipedia_pages (נמחקה/הועברה/הפכה להפניה)
--     שתי הסיבות לא משנות את report_missing_from_mechalol (הוא מצטלב לפי כותרת מול wikipedia_pages).
--   manual_matches (רק שורות אוטומטיות, reason 'נעול לקריאה%'; שיוך ידני של עורך אף פעם לא נמחק, רק מדווח):
--     mechalol_gone / wikipedia_gone  אחד הצדדים לא קיים יותר
--
-- מה **לא** כלול: בדיקה מול ה-API. האם נעילה הוסרה, האם ממצא גרסה עדיין נכון, ממצאים חדשים: scripts/rev_link_scan.py
-- (--recheck בדקה), scripts/check_missing_locked.py. הרענון הזה משלים אותם ולא מחליף.
--
-- הרשאות: security definer. מותר ל-service_role, ול-authenticated רק אם is_manual_match_admin() (אותה רשימת מנהלים
-- כמו שיוך ידני). anon ו-PUBLIC לא יכולים לבצע. הבדיקה בתוך הפונקציה, לא רק ב-GRANT.
-- בטיחות: מסרבת לרוץ אם אחת משתי טבלאות הערכים נראית ריקה/חלקית (reltuples < 100,000), כדי שטעינה שנכשלה
-- לא תמחק הכול; נועלת ריצה מקבילית; כל הפעולה בטרנזקציה אחת. כל השאילתות על מפתחות/אינדקסים (שניות בודדות):
-- ל-authenticated statement_timeout של 15 שניות, ופונקציה לא יכולה להאריך אותו.
-- אין שינוי סכמה ואין נפח. idempotent. הרצה בייצור רק באישור מפורש; לא בזמן ההחלפה השבועית.

-- ===== מוצאי השורות המיותרות (פנימיים; נקראים רק מ-refresh_maintenance_tables) =====

create or replace function maintenance_stale_rev_link_check()
returns table (row_id bigint, reason text)
language sql stable
set search_path = public, pg_temp
as $$
    select c.mechalol_id,
           case
               when m.id is null then 'page_gone'
               when m.status is distinct from 'מיובא ומתועד'
                    or m.is_dictionary_entry or m.needs_attention
                    or m.sort_template_denied_at is not null
                    or m.template_check_access_denied_at is not null then 'out_of_scope'
               when exists (select 1 from manual_matches mm where mm.mechalol_page_id = c.mechalol_id) then 'manual_match'
               when c.rev_id is distinct from m.sort_template_rev then 'rev_changed'
           end
    from rev_link_check c
    left join mechalol_pages m on m.id = c.mechalol_id;
$$;

-- deletable = שורה אוטומטית (נוספה ע"י check_missing_locked.py). ידנית: מדווחת בלבד.
create or replace function maintenance_stale_blacklist()
returns table (row_id bigint, reason text, deletable boolean)
language sql stable
set search_path = public, pg_temp
as $$
    select b.id,
           case
               when exists (select 1 from mechalol_pages m where m.title = b.title) then 'exists_in_mechalol'
               when not exists (select 1 from wikipedia_pages w where w.title = b.title) then 'not_in_wikipedia'
           end,
           coalesce(b.reason, '') like 'נעול ליצירה%'
    from blacklist_titles b;
$$;

create or replace function maintenance_stale_manual_matches()
returns table (row_id bigint, reason text, deletable boolean)
language sql stable
set search_path = public, pg_temp
as $$
    select mm.id,
           case
               when not exists (select 1 from mechalol_pages m where m.id = mm.mechalol_page_id) then 'mechalol_gone'
               when not exists (select 1 from wikipedia_pages w where w.id = mm.wikipedia_page_id) then 'wikipedia_gone'
           end,
           coalesce(mm.reason, '') like 'נעול לקריאה%'
    from manual_matches mm;
$$;

revoke all on function maintenance_stale_rev_link_check() from public, anon, authenticated;
revoke all on function maintenance_stale_blacklist() from public, anon, authenticated;
revoke all on function maintenance_stale_manual_matches() from public, anon, authenticated;
grant execute on function maintenance_stale_rev_link_check() to service_role;
grant execute on function maintenance_stale_blacklist() to service_role;
grant execute on function maintenance_stale_manual_matches() to service_role;

-- ===== הפונקציה שהדשבורד קורא לה =====

create or replace function refresh_maintenance_tables(p_apply boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_rev_ids  bigint[];
    v_bl_ids   bigint[];
    v_mm_ids   bigint[];
    v_result   jsonb;
    v_rev_deleted bigint := 0;
    v_bl_deleted  bigint := 0;
    v_mm_deleted  bigint := 0;
begin
    -- הרשאה: service_role, מנהל מורשה, או הרצה ישירה כבעלים (עורך ה-SQL).
    if not (coalesce(auth.role(), '') = 'service_role'
            or session_user in ('postgres', 'supabase_admin')
            or is_manual_match_admin()) then
        raise exception 'אין הרשאה לרענון טבלאות תחזוקה' using errcode = '42501';
    end if;

    if not pg_try_advisory_xact_lock(hashtext('refresh_maintenance_tables')) then
        raise exception 'רענון אחר כבר רץ, נסו שוב בעוד רגע' using errcode = '55P03';
    end if;

    -- טבלאות הערכים ריקות/חלקיות (טעינה שנכשלה באמצע) = כל ההשוואות שגויות; לא מוחקים כלום.
    if (select reltuples from pg_class where oid = 'public.mechalol_pages'::regclass) < 100000
       or (select reltuples from pg_class where oid = 'public.wikipedia_pages'::regclass) < 100000 then
        raise exception 'mechalol_pages/wikipedia_pages נראות ריקות או חלקיות; הרענון נעצר ללא שינוי' using errcode = '55000';
    end if;

    select coalesce(array_agg(row_id order by row_id), '{}') into v_rev_ids
    from maintenance_stale_rev_link_check() where reason is not null;

    select coalesce(array_agg(row_id order by row_id), '{}') into v_bl_ids
    from maintenance_stale_blacklist() where reason is not null and deletable;

    select coalesce(array_agg(row_id order by row_id), '{}') into v_mm_ids
    from maintenance_stale_manual_matches() where reason is not null and deletable;

    -- הדוח מחושב לפני המחיקה (מהן הסיבות, ומה נשאר לבדיקה ידנית).
    v_result := jsonb_build_object(
        'applied', p_apply,
        'rev_link_check', jsonb_build_object(
            'total', (select count(*) from rev_link_check),
            'stale', coalesce((select jsonb_object_agg(reason, n) from (
                         select reason, count(*) n from maintenance_stale_rev_link_check()
                         where reason is not null group by reason) s), '{}'::jsonb),
            'ids', to_jsonb(v_rev_ids)),
        'blacklist_titles', jsonb_build_object(
            'total', (select count(*) from blacklist_titles),
            'stale', coalesce((select jsonb_object_agg(reason, n) from (
                         select reason, count(*) n from maintenance_stale_blacklist()
                         where reason is not null and deletable group by reason) s), '{}'::jsonb),
            'titles', coalesce((select jsonb_agg(b.title order by b.title) from blacklist_titles b
                                where b.id = any (v_bl_ids)), '[]'::jsonb),
            'manual_stale_not_deleted', coalesce((select jsonb_agg(b.title order by b.title)
                from maintenance_stale_blacklist() s join blacklist_titles b on b.id = s.row_id
                where s.reason is not null and not s.deletable), '[]'::jsonb)),
        'manual_matches', jsonb_build_object(
            'total', (select count(*) from manual_matches),
            'stale', coalesce((select jsonb_object_agg(reason, n) from (
                         select reason, count(*) n from maintenance_stale_manual_matches()
                         where reason is not null and deletable group by reason) s), '{}'::jsonb),
            'ids', to_jsonb(v_mm_ids),
            'manual_stale_not_deleted', coalesce((select jsonb_agg(row_id order by row_id)
                from maintenance_stale_manual_matches()
                where reason is not null and not deletable), '[]'::jsonb))
    );

    if p_apply then
        delete from rev_link_check where mechalol_id = any (v_rev_ids);
        get diagnostics v_rev_deleted = row_count;
        delete from blacklist_titles where id = any (v_bl_ids);
        get diagnostics v_bl_deleted = row_count;
        delete from manual_matches where id = any (v_mm_ids);
        get diagnostics v_mm_deleted = row_count;
    end if;

    return v_result || jsonb_build_object('deleted', jsonb_build_object(
        'rev_link_check', v_rev_deleted, 'blacklist_titles', v_bl_deleted, 'manual_matches', v_mm_deleted));
end;
$$;

revoke all on function refresh_maintenance_tables(boolean) from public, anon, authenticated;
grant execute on function refresh_maintenance_tables(boolean) to authenticated, service_role;

notify pgrst, 'reload schema';
