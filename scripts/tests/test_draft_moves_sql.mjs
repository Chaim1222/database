// PGLITE_PACKAGE_JSON=/path/to/package.json node scripts/tests/test_draft_moves_sql.mjs
import assert from 'node:assert/strict';
import {readFileSync, readdirSync} from 'node:fs';
import {createRequire} from 'node:module';
const require = createRequire(process.env.PGLITE_PACKAGE_JSON || import.meta.url);
const {PGlite} = require('@electric-sql/pglite');
const db = new PGlite();
let checks=0;
const ids = async () => (await db.query('select id,wikipedia_title from report_wikipedia_moves order by id')).rows;
const expect = async rows => { assert.deepEqual(await ids(),rows); checks++; };
try {
await db.exec(`
create role anon; create role authenticated; create role service_role bypassrls;
create table wikipedia_pages(id bigint primary key,title text);
create table mechalol_pages(id bigint primary key,title text,status text,wikipedia_id bigint,
 template_referenced_title text,rev_id bigint,sort_template_parsed_rev bigint,sort_template_rev bigint,sort_template_date date);
create table wikipedia_renames(id bigserial,page_id bigint,old_title text,new_title text,renamed_at timestamptz,action text);
create table wikipedia_deletions(page_id bigint,title text,deleted_at timestamptz);
create table wikipedia_creations(page_id bigint,title text,created_at timestamptz);
create table manual_matches(mechalol_page_id bigint,wikipedia_page_id bigint);
create table rev_link_check(mechalol_id bigint,rev_task text,rev_id bigint,rev_page_id bigint,rev_page_title text,checked_at timestamptz);
grant usage on schema public to anon,authenticated,service_role;
grant select on all tables in schema public to anon,authenticated,service_role;
insert into mechalol_pages(id,title,status) values (1,'שם ישן','מיובא ומתועד'),(2,'שם מקומי','מיובא ומתועד');
update mechalol_pages set template_referenced_title='שם ישן' where id=2;
insert into wikipedia_renames(page_id,old_title,new_title,renamed_at,action)
 values(10,'שם ישן','טיוטה:ערך','2026-10-01','move');
insert into wikipedia_deletions values(10,'שם ישן','2026-10-01');
`);
await db.exec(readFileSync(new URL('../../migrations/20261006205515_old_dashboard_task_validity.sql',import.meta.url),'utf8'));
const dir=new URL('../../migrations/',import.meta.url);
const migration=readFileSync(new URL(readdirSync(dir).find(f=>f.endsWith('_draft_move_report.sql')),dir),'utf8');
await db.exec(migration); await db.exec(migration);
const rows=title=>[{id:1,wikipedia_title:title},{id:2,wikipedia_title:title}];
await expect(rows('טיוטה:ערך'));
await db.exec("insert into wikipedia_renames(page_id,old_title,new_title,renamed_at,action) values(10,'טיוטה:ערך','טיוטה:חדש','2026-10-02','move_redir')");
await expect(rows('טיוטה:חדש'));
await db.exec("insert into wikipedia_deletions values(0,'טיוטה:חדש','2026-10-03')");
await expect([]);
await db.exec("insert into wikipedia_creations values(10,'טיוטה:חדש','2026-10-04')");
await expect(rows('טיוטה:חדש'));
// The API may report the current replacement page ID, not the deleted identity.
await db.exec("insert into wikipedia_deletions values(999,'טיוטה:חדש','2026-10-05')");
await expect([]);
await db.exec("insert into wikipedia_pages values(10,'אחרי חזרה')");
await expect(rows('אחרי חזרה'));
await db.exec("update wikipedia_pages set title='שם ישן' where id=10");
await expect([{id:2,wikipedia_title:'שם ישן'}]);
await db.exec("delete from wikipedia_pages; insert into wikipedia_renames(page_id,old_title,new_title,renamed_at,action) values(10,'טיוטה:חדש','שם ישן','2026-10-06','move')");
await expect([]);
await db.exec("insert into wikipedia_renames(page_id,old_title,new_title,renamed_at,action) values(0,'שם ישן','טיוטה:לא ידוע','2026-10-07','move')");
await expect([]);
for (const role of ['anon','authenticated']) {
 await db.exec(`set role ${role}`); await expect([]); await db.exec('reset role');
}
console.log(`PASS: ${checks} draft lifecycle and permission checks`);
} finally {await db.close();}
