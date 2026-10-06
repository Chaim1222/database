// PGLITE_PACKAGE_JSON=/path/to/package.json node scripts/tests/test_dashboard_task_validity_sql.mjs
// Runs the actual pending migration in isolated PostgreSQL; no production connection.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(process.env.PGLITE_PACKAGE_JSON || import.meta.url);
const { PGlite } = require('@electric-sql/pglite');
const db = new PGlite();
let checks = 0;
const query = async sql => (await db.query(sql)).rows;
const check = async (sql, expected) => { assert.deepEqual(await query(sql), expected); checks++; };
const ids = () => query('select id from report_wikipedia_moves order by id');
try {
  await db.exec(`
    create role anon; create role authenticated; create role service_role bypassrls;
    create table wikipedia_pages(id bigint primary key, title text);
    create table mechalol_pages(id bigint primary key, title text, status text,
      wikipedia_id bigint, template_referenced_title text, rev_id bigint,
      sort_template_parsed_rev bigint, sort_template_rev bigint, sort_template_date date);
    create table wikipedia_renames(page_id bigint, old_title text, renamed_at timestamptz, action text);
    create table manual_matches(mechalol_page_id bigint primary key, wikipedia_page_id bigint);
    create table rev_link_check(mechalol_id bigint primary key, rev_task text, rev_id bigint,
      rev_page_id bigint, rev_page_title text, checked_at timestamptz);
    insert into wikipedia_pages values(10,'new title'),(20,'old title'),(30,'other new title');
    insert into wikipedia_renames values(10,'old title','2026-10-01','move');
    insert into mechalol_pages values
      (1,'old title','מיובא ומתועד',20,null,100,100,200,null),
      (2,'local title','מיובא ומתועד',null,'old title',101,101,201,null),
      (3,'untouched','מיובא ומתועד',null,null,102,102,null,null);
    insert into rev_link_check values
      (1,'bad_rev',199,null,null,now()), (2,'redirect',201,10,'new title',now()),
      (3,'bad_rev',null,null,null,now());
    grant usage on schema public to anon,authenticated,service_role;
    grant select on all tables in schema public to anon,authenticated,service_role;
  `);
  const migration = readFileSync(new URL('../../migrations/20261006205515_old_dashboard_task_validity.sql', import.meta.url), 'utf8');
  await db.exec(migration);
  await db.exec(migration); // Reapplication preserves data and grants.
  assert.deepEqual(await ids(), [{id:1},{id:2}]); checks++; // title-only link never suppresses.
  await check('select id from report_rev_tasks order by id', [{id:2},{id:3}]); // NULL baseline still a real finding.
  await db.exec('insert into maintenance_move_sources values(1,100,200,20,now())');
  assert.deepEqual(await ids(), [{id:2}]); checks++; // verified different identity suppresses false candidate.
  await db.exec('update maintenance_move_sources set source_wikipedia_id=10 where mechalol_id=1');
  assert.deepEqual(await ids(), [{id:1},{id:2}]); checks++; // evidence for moved identity retains genuine task.
  await db.exec('update maintenance_move_sources set source_wikipedia_id=20 where mechalol_id=1');
  await db.exec('update mechalol_pages set rev_id=999 where id=1');
  assert.deepEqual(await ids(), [{id:1},{id:2}]); checks++;
  await db.exec('update mechalol_pages set rev_id=100,sort_template_rev=999 where id=1');
  assert.deepEqual(await ids(), [{id:1},{id:2}]); checks++;
  await db.exec('update mechalol_pages set sort_template_rev=200,sort_template_parsed_rev=999 where id=1');
  assert.deepEqual(await ids(), [{id:1},{id:2}]); checks++;
  await db.exec('update mechalol_pages set sort_template_parsed_rev=100 where id=1');
  await db.exec('insert into manual_matches values(2,20)');
  assert.deepEqual(await ids(), []); checks++;
  await db.exec('update manual_matches set wikipedia_page_id=10 where mechalol_page_id=2');
  assert.deepEqual(await ids(), [{id:2}]); checks++; // same identity does not hide move.
  // Multiple title/template hits remain one row; title priority is retained after filtering.
  await db.exec(`insert into wikipedia_renames values(30,'old title','2026-10-02','move');
    update mechalol_pages set template_referenced_title='old title' where id=1;`);
  await check("select id,via from report_wikipedia_moves where id=1", []);
  await db.exec('update maintenance_move_sources set source_wikipedia_id=null where mechalol_id=1');
  await check("select id,via,wikipedia_id from report_wikipedia_moves where id=1", [{id:1,via:'title',wikipedia_id:30}]);
  for (const role of ['anon','authenticated']) {
    await db.exec(`set role ${role}`);
    await check('select id from report_rev_tasks order by id', [{id:3}]);
    await check('select count(*)::int as n from report_wikipedia_moves', [{n:2}]);
    for (const sql of ['insert into maintenance_move_sources(mechalol_id) values(99)',
                      'update maintenance_move_sources set source_wikipedia_id=10',
                      'delete from maintenance_move_sources']) {
      await assert.rejects(db.query(sql), /permission denied/); checks++;
    }
    await db.exec('reset role');
  }
  await db.exec('set role service_role');
  await db.exec('update maintenance_move_sources set source_wikipedia_id=10 where mechalol_id=1');
  await db.exec('reset role');
  checks++;
  await check("select relname,reloptions from pg_class where relname in ('report_wikipedia_moves','report_wikipedia_move_candidates','report_rev_tasks') order by relname", [
    {relname:'report_rev_tasks',reloptions:['security_invoker=true']},
    {relname:'report_wikipedia_move_candidates',reloptions:['security_invoker=true']},
    {relname:'report_wikipedia_moves',reloptions:['security_invoker=true']}
  ]);
  await db.exec(readFileSync(new URL('../../docs/old-dashboard-task-validity-rollback.sql', import.meta.url), 'utf8'));
  assert.deepEqual(await ids(), [{id:1},{id:2}]); checks++;
  await check('select id from report_rev_tasks order by id', [{id:1},{id:3}]);
  await check('select count(*)::int as n from maintenance_move_sources', [{n:1}]);
  console.log(`PASS: ${checks} SQL behavior and permission checks`);
} finally { await db.close(); }
