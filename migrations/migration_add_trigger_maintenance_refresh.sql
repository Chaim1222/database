-- migration_add_trigger_maintenance_refresh.sql
--
-- כפתור "רענן נתוני תחזוקה" בדשבורד: מפעיל את ה-workflow maintenance_refresh.yml (דלתא, התאמה ממוקדת, עדכון שעתי,
-- בדיקת גרסאות מחדש, ניקוי) ומחכה לסיומו, ואז הדשבורד נטען מחדש. הדפדפן לא יכול להפעיל workflow לבד (צריך טוקן
-- GitHub), ולכן הפונקציה במסד עושה את זה, עם טוקן ששמור ב-Vault ולא יוצא החוצה.
--
-- הגדרה חד-פעמית (ידנית, לא בקובץ הזה, כדי שהטוקן לא ייכנס לריפו):
--   1. טוקן GitHub "fine-grained" לריפו Chaim1222/database בלבד, הרשאה Actions: Read and write (ותו לא).
--   2. בעורך ה-SQL של סופרבייס:  select vault.create_secret('<הטוקן>', 'github_dispatch_token');
--   3. ה-workflow חייב להיות בענף main (GitHub מפעיל workflow רק מהענף שבו הוא קיים).
--
-- request_maintenance_refresh(): מותרת ל-service_role ול-authenticated שב-manual_match_admins (כמו שיוך ידני);
--   anon לא. ריצה אחת בכל פעם (ריצה שהתחילה לפני פחות מ-45 דקות חוסמת חדשה). שולחת בקשה אסינכרונית (pg_net).
-- maintenance_refresh_status(): אותו תנאי הרשאה; מחזירה את המצב, ואם GitHub דחה את ההפעלה (טוקן שגוי/חסר הרשאה/
--   workflow לא נמצא) את הסיבה, כי pg_net לא מחזיר שגיאה מיידית.
-- maintenance_refresh_state: שורה אחת. ה-workflow כותב אליה התחלה וסיום (scripts/maintenance_refresh_state.py).
-- לא נוגעת בטבלאות הערכים ולא בהחלפה השבועית. idempotent. יוצרת את ההרחבה pg_net (דורש אישור להרצה בייצור).

create extension if not exists pg_net;

create table if not exists maintenance_refresh_state (
    id            smallint primary key check (id = 1),
    status        text not null default 'idle' check (status in ('idle', 'requested', 'running', 'success', 'failed')),
    requested_by  uuid,
    requested_at  timestamptz,
    started_at    timestamptz,
    finished_at   timestamptz,
    request_id    bigint,        -- מזהה בקשת pg_net (net._http_response)
    updated_at    timestamptz not null default now()
);
insert into maintenance_refresh_state (id) values (1) on conflict do nothing;

alter table maintenance_refresh_state enable row level security;
do $$
begin
    if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'maintenance_refresh_state'
                   and policyname = 'קריאה ציבורית') then
        create policy "קריאה ציבורית" on maintenance_refresh_state for select to anon, authenticated using (true);
    end if;
end $$;
revoke all on maintenance_refresh_state from anon, authenticated;
grant select on maintenance_refresh_state to anon, authenticated;
grant select, update on maintenance_refresh_state to service_role;

create or replace function request_maintenance_refresh()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_state   maintenance_refresh_state;
    v_token   text;
    v_request bigint;
begin
    if not (coalesce(auth.role(), '') = 'service_role'
            or session_user in ('postgres', 'supabase_admin')
            or is_manual_match_admin()) then
        raise exception 'אין הרשאה להפעיל רענון' using errcode = '42501';
    end if;

    select * into v_state from maintenance_refresh_state where id = 1 for update;
    if v_state.status in ('requested', 'running') and v_state.requested_at > now() - interval '45 minutes' then
        return jsonb_build_object('started', false, 'reason', 'already_running', 'requested_at', v_state.requested_at);
    end if;

    select decrypted_secret into v_token from vault.decrypted_secrets where name = 'github_dispatch_token';
    if v_token is null then
        raise exception 'חסר הסוד github_dispatch_token ב-Vault (ראו הערות migration_add_trigger_maintenance_refresh.sql)' using errcode = '55000';
    end if;

    select net.http_post(
        url     := 'https://api.github.com/repos/Chaim1222/database/actions/workflows/maintenance_refresh.yml/dispatches',
        body    := jsonb_build_object('ref', 'main', 'inputs', jsonb_build_object('cleanup', 'true')),
        headers := jsonb_build_object(
            'Authorization', 'Bearer ' || v_token,
            'Accept', 'application/vnd.github+json',
            'X-GitHub-Api-Version', '2022-11-28',
            'User-Agent', 'hamichlol-dashboard',
            'Content-Type', 'application/json')
    ) into v_request;

    update maintenance_refresh_state
       set status = 'requested', requested_by = auth.uid(), requested_at = now(), started_at = null,
           finished_at = null, request_id = v_request, updated_at = now()
     where id = 1;

    return jsonb_build_object('started', true, 'requested_at', now());
end;
$$;

create or replace function maintenance_refresh_status()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
    v_state maintenance_refresh_state;
    v_code  int;
    v_body  text;
begin
    if not (coalesce(auth.role(), '') = 'service_role'
            or session_user in ('postgres', 'supabase_admin')
            or is_manual_match_admin()) then
        raise exception 'אין הרשאה' using errcode = '42501';
    end if;

    select * into v_state from maintenance_refresh_state where id = 1;
    if v_state.status = 'requested' and v_state.request_id is not null then
        select status_code, left(content, 300) into v_code, v_body from net._http_response where id = v_state.request_id;
    end if;
    return jsonb_build_object(
        'status', v_state.status, 'requested_at', v_state.requested_at, 'started_at', v_state.started_at,
        'finished_at', v_state.finished_at,
        -- GitHub מחזיר 204 כשההפעלה התקבלה; כל קוד אחר = ההפעלה נדחתה.
        'dispatch_error', case when v_code is not null and v_code <> 204 then 'GitHub ' || v_code || ': ' || coalesce(v_body, '') end);
end;
$$;

revoke all on function request_maintenance_refresh() from public, anon, authenticated;
revoke all on function maintenance_refresh_status() from public, anon, authenticated;
grant execute on function request_maintenance_refresh() to authenticated, service_role;
grant execute on function maintenance_refresh_status() to authenticated, service_role;

notify pgrst, 'reload schema';
