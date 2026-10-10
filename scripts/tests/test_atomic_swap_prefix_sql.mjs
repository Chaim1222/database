// PGLITE_PACKAGE_JSON=/path/to/package.json node scripts/tests/test_atomic_swap_prefix_sql.mjs
// מסד זמני בלבד: משחזר התנגשות template_ref_idx ומחליף בשני כיוונים.
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {createRequire} from 'node:module';
const require=createRequire(process.env.PGLITE_PACKAGE_JSON || import.meta.url);
const {PGlite}=require('@electric-sql/pglite');
const db=new PGlite();
const one=async sql=>(await db.query(sql)).rows[0];
let checks=0;
const check=(a,b)=>{assert.deepEqual(a,b);checks++;};
try {
 await db.exec(`
 create role anon; create role authenticated; create role service_role;
 create table wikipedia_pages(id bigint primary key,title text unique);
 create table wikipedia_pages_temp(id bigint primary key,title text unique);
 create table mechalol_pages(id bigint primary key,title text unique,template_ref text);
 create table mechalol_pages_temp(id bigint primary key,title text unique,template_ref text);
 create index mechalol_pages_template_ref_idx on mechalol_pages(template_ref);
 create index mechalol_pages_temp_template_ref_idx on mechalol_pages_temp(template_ref);
 create view swap_test_view with(security_invoker=true) as select id,title from mechalol_pages;
 insert into wikipedia_pages values(1,'ויקיפדיה פעילה');
 insert into wikipedia_pages_temp values(2,'ויקיפדיה חדשה');
 insert into mechalol_pages values(1,'פעיל','x');
 insert into mechalol_pages_temp values(2,'חדש','y');
 `);
 const dir=new URL('../../migrations/',import.meta.url);
 const file=readdirSync(dir).find(f=>f.endsWith('_preserve_atomic_swap_prefix_fix.sql'));
 assert.ok(file);checks++;
 const sql=readFileSync(new URL(file,dir),'utf8');
 await db.exec(sql);
 // CREATE OR REPLACE אינו מרחיב הרשאות של פונקציה קיימת.
 await db.exec('revoke all on function perform_atomic_swap() from public; grant execute on function perform_atomic_swap() to service_role;');
 const before=await one("select proacl::text as acl from pg_proc where oid='perform_atomic_swap()'::regprocedure");
 await db.exec(sql);
 check(await one("select proacl::text as acl from pg_proc where oid='perform_atomic_swap()'::regprocedure"),before);
 for(const expected of ['חדש','פעיל']) {
  await db.exec('select perform_atomic_swap()');
  check((await one('select title from mechalol_pages')).title,expected);
  check((await one('select title from swap_test_view')).title,expected);
  check((await one("select reloptions::text as opts from pg_class where oid='swap_test_view'::regclass")).opts,'{security_invoker=true}');
  check((await db.query("select tablename,indexname from pg_indexes where indexname in ('mechalol_pages_template_ref_idx','mechalol_pages_temp_template_ref_idx') order by indexname")).rows,[
   {tablename:'mechalol_pages_temp',indexname:'mechalol_pages_temp_template_ref_idx'},
   {tablename:'mechalol_pages',indexname:'mechalol_pages_template_ref_idx'}]);
  check((await one("select count(*)::int as n from pg_class where relname like '\\_swap\\_tmp\\_%' escape '\\'")).n,0);
 }
 console.log(`ok atomic_swap_prefix: ${checks} checks`);
} finally {await db.close();}
