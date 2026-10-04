// Real PostgreSQL engine (PGlite), no production connection.
// npm install --prefix /tmp/weekly-pg @electric-sql/pglite
// PGLITE_PACKAGE_JSON=/tmp/weekly-pg/package.json node scripts/tests/test_weekly_build_sql.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(process.env.PGLITE_PACKAGE_JSON || import.meta.url);
const { PGlite } = require('@electric-sql/pglite');
const root = fileURLToPath(new URL('../../', import.meta.url));
const db = new PGlite();
let checks = 0;
const one = async sql => (await db.query(sql)).rows[0];
const check = (actual, expected) => { assert.deepEqual(actual, expected); checks++; };
const rejects = async (sql, pattern) => { await assert.rejects(db.query(sql), pattern); checks++; };
const id = '11111111-1111-4111-8111-111111111111';
const nextId = '22222222-2222-4222-8222-222222222222';
const step = phase => db.query('select * from public.advance_weekly_build($1, $2)', [id, phase]);
const phase = async () => (await one('select phase from weekly_build_state')).phase;

try {
  await db.exec(`
    create role anon;
    create role authenticated;
    create role service_role bypassrls;
    create table wikipedia_pages(id bigint primary key, title text);
    create table wikipedia_pages_temp(id bigint primary key, title text);
    create table mechalol_pages(id bigint primary key, title text);
    create table mechalol_pages_temp(id bigint primary key, title text);
    create view test_pages with (security_invoker=true) as select * from wikipedia_pages;
    insert into wikipedia_pages values (1, 'old');
    insert into wikipedia_pages_temp values (2, 'new');
    insert into mechalol_pages values (1, 'old');
    insert into mechalol_pages_temp values (2, 'new');
    create table sync_watermarks(source text primary key, last_synced_ts timestamptz);
    insert into sync_watermarks values ('wikipedia', '2026-10-04T00:00:00Z');
    create table reconciliation_audit(id bigserial primary key);
    create table test_full_diff(audit_id bigint);
    create table test_faults(point text);
    create function log_reconciliation_diff() returns bigint language plpgsql security definer set search_path=public as $$
    declare audit_id bigint; begin
      insert into reconciliation_audit default values returning id into audit_id;
      if exists(select from test_faults where point='audit') then raise exception 'audit fault'; end if;
      return audit_id;
    end $$;
    create function log_reconciliation_diff_all(p_audit_id bigint, p_examples_per_class integer default 200)
    returns void language plpgsql security definer set search_path=public as $$ begin
      insert into test_full_diff values (p_audit_id);
    end $$;
    create function truncate_temp_pages() returns void language plpgsql security definer set search_path=public as $$ begin
      truncate wikipedia_pages_temp, mechalol_pages_temp;
      if exists(select from test_faults where point='clean') then raise exception 'clean fault'; end if;
    end $$;
    grant usage on schema public to anon, authenticated, service_role;
    grant select on all tables in schema public to service_role;
  `);
  // Execute the existing production swap implementation, including index renames
  // and preserving view options; audit/cleanup dependencies above inject faults.
  const source = readFileSync(root + 'migrations/migration_review_fixes_2026_09.sql', 'utf8');
  const swap = source.match(/create or replace function perform_atomic_swap\(\)[\s\S]*?\$function\$;/i)[0];
  await db.exec(swap);
  await db.exec(readFileSync(root + 'migrations/20261004164955_weekly_build_state.sql', 'utf8'));
  await db.exec(`create function test_checkpoint_fault() returns trigger language plpgsql as $$ begin
    if new.phase='swapped' and exists(select from public.test_faults where point='swap') then
      raise exception 'checkpoint fault'; end if;
    return new; end $$;
    create trigger test_checkpoint_fault before update on weekly_build_state
      for each row execute function test_checkpoint_fault();`);

  await db.exec('set role service_role');
  await db.query('select public.begin_weekly_build($1)', [id]);
  check(await phase(), 'building');
  await db.query('select public.begin_weekly_build($1)', [id]);
  check(await phase(), 'building');
  await rejects(`select public.advance_weekly_build('${id}', 'swapped')`, /Cannot advance/);
  await rejects(`select public.advance_weekly_build(null, 'matched')`, /Stale build/);
  await step('matched');
  check(new Date((await one('select delta_watermarks from weekly_build_state')).delta_watermarks.wikipedia).toISOString(),
        '2026-10-04T00:00:00.000Z');
  await step('ready');

  // Fault after ALTER TABLE: both the swap and checkpoint must roll back.
  await db.exec("reset role; insert into test_faults values ('swap'); set role service_role;");
  await rejects(`select public.advance_weekly_build('${id}', 'swapped')`, /checkpoint fault/);
  check(await phase(), 'ready');
  check((await one('select title from wikipedia_pages')).title, 'old');
  check((await one('select title from test_pages')).title, 'old');
  await db.exec('reset role; delete from test_faults; set role service_role;');
  await step('swapped');
  await step('swapped'); // Simulate retry after committed response was lost.
  check((await one('select title from wikipedia_pages')).title, 'new');
  check((await one('select title from wikipedia_pages_temp')).title, 'old');
  check((await one('select title from test_pages')).title, 'new');
  check((await one("select reloptions from pg_class where relname='test_pages'")).reloptions,
        ['security_invoker=true']);
  await rejects(`select public.begin_weekly_build('${nextId}')`, /Resume it/);
  await rejects(`select public.advance_weekly_build('${nextId}', 'source_recomputed')`, /Stale build/);
  await step('source_recomputed');
  await db.exec("reset role; insert into test_faults values ('audit'); set role service_role;");
  await rejects(`select public.advance_weekly_build('${id}', 'audited')`, /audit fault/);
  check(await phase(), 'source_recomputed');
  check(Number((await one('select count(*) as n from reconciliation_audit')).n), 0);
  check((await one('select title from wikipedia_pages_temp')).title, 'old');
  await rejects(`select public.advance_weekly_build('${id}', 'cleaned')`, /Cannot advance/);
  await db.exec('reset role; delete from test_faults; set role service_role;');
  await step('audited');
  const auditId = (await one('select audit_id from weekly_build_state')).audit_id;
  await step('audited');
  check(Number((await one('select count(*) as n from reconciliation_audit')).n), 1);
  check((await one('select audit_id from weekly_build_state')).audit_id, auditId);
  await db.exec("reset role; insert into test_faults values ('clean'); set role service_role;");
  await rejects(`select public.advance_weekly_build('${id}', 'cleaned')`, /clean fault/);
  check(await phase(), 'audited');
  check((await one('select title from wikipedia_pages_temp')).title, 'old');
  await db.exec('reset role; delete from test_faults; set role service_role;');
  await step('cleaned');
  await step('cleaned');
  await step('swapped'); // Stale retry cannot regress the state or swap again.
  check(await phase(), 'cleaned');
  check(Number((await one('select count(*) as n from wikipedia_pages_temp')).n), 0);
  check((await one('select title from wikipedia_pages')).title, 'new');
  await step('classified');
  await step('complete');
  await db.query('select public.begin_weekly_build($1)', [nextId]);
  check(await phase(), 'building');
  await rejects(`select public.advance_weekly_build('${id}', 'cleaned')`, /Stale build/);
  await db.exec('reset role; select perform_atomic_swap(); set role service_role;');
  await rejects(`select public.advance_weekly_build('${nextId}', 'matched')`, /identities changed/);
  for (const role of ['anon', 'authenticated']) {
    await db.exec(`reset role; set role ${role}`);
    await rejects('select * from weekly_build_state', /permission denied/);
    await rejects(`select public.begin_weekly_build('${id}')`, /permission denied/);
    await rejects(`select public.advance_weekly_build('${id}', 'swapped')`, /permission denied/);
  }
  await db.exec('reset role');
  check((await one("select relrowsecurity from pg_class where relname='weekly_build_state'")).relrowsecurity, true);
  console.log(`PASS: ${checks} PostgreSQL assertions (equal counts, rollback, retries, recovery, permissions)`);
} finally {
  await db.close();
}
