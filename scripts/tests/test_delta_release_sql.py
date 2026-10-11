"""Run on an isolated PostgreSQL database, never on production."""
import os
from pathlib import Path
import re
import subprocess
import unittest

ROOT = Path(__file__).resolve().parents[2]

def fixture_sql():
    schema = (ROOT / 'schema/schema.sql').read_text()
    names = ['normalize_person_title', 'recompute_missing_flag_scoped', 'recompute_missing_flag_by_titles']
    functions = '\n'.join(re.search(r'create or replace function '+n+r'\([^$]+\$\$.*?\$\$;', schema, re.S).group() for n in names)
    migration = (ROOT / 'migrations/20261011110000_delta_release_queue.sql').read_text()
    return '''
create role anon; create role authenticated; create role service_role bypassrls;
create table wikipedia_pages(id bigint primary key,title text,is_missing boolean default false,missing_override_reason text);
create table wikipedia_pages_temp(like wikipedia_pages including all);
create table mechalol_pages(id bigint primary key,title text not null unique,wikipedia_id bigint);
create table mechalol_pages_temp(like mechalol_pages including all);
''' + functions + '''
alter function recompute_missing_flag_scoped(bigint[]) set search_path=public;
grant usage on schema public to service_role;
grant all on wikipedia_pages,mechalol_pages to service_role;
''' + migration + '''
insert into wikipedia_pages values(1,'same',false,null),(2,'different wiki title',false,null);
insert into mechalol_pages values(10,'same',null),(20,'local title',2);
-- Deletion survives a process dying before file writing/matching.
delete from mechalol_pages;
do $$ begin
 if (select count(*) from mech_release_queue)<>2 then raise exception 'lost release'; end if;
end $$;
-- Inject failure after the ID-based recompute, while titles are being recomputed.
create function fail_title_update() returns trigger language plpgsql as $$
begin if new.id=1 then raise exception 'injected'; end if; return new; end $$;
create trigger injected before update on wikipedia_pages for each row execute function fail_title_update();
do $$ begin
 begin perform recompute_released_mechalol_pages(); raise exception 'expected failure';
 exception when raise_exception then
   if SQLERRM <> 'injected' then raise; end if;
 end;
 if (select count(*) from mech_release_queue)<>2 or exists(select 1 from wikipedia_pages where is_missing) then
   raise exception 'partial acknowledgement/recompute survived rollback'; end if;
end $$;
drop trigger injected on wikipedia_pages;
set role service_role;
select recompute_released_mechalol_pages();
reset role;
do $$ begin
 if exists(select 1 from mech_release_queue) or exists(select 1 from wikipedia_pages where not is_missing) then
   raise exception 'retry did not repair titles and links'; end if;
 if recompute_released_mechalol_pages()<>0 then raise exception 'replay not empty'; end if;
 if has_table_privilege('anon','mech_release_queue','select') or has_function_privilege('authenticated','recompute_released_mechalol_pages()','execute') then
   raise exception 'queue exposed'; end if;
end $$;
-- A new holder exists by retry: recompute current truth, not blindly mark missing.
insert into mechalol_pages values(30,'same',null);
delete from mechalol_pages where id=30;
insert into mechalol_pages values(31,'same',null);
select recompute_released_mechalol_pages();
do $$ begin if (select is_missing from wikipedia_pages where id=1) then raise exception 'new holder ignored'; end if; end $$;
-- The queue write is part of DELETE: a failure must preserve the mirror row.
alter table mech_release_queue add constraint reject_test check(mechalol_id<>31);
do $$ begin
 begin delete from mechalol_pages where id=31; raise exception 'expected queue failure';
 exception when check_violation then null; end;
 if not exists(select 1 from mechalol_pages where id=31) then raise exception 'delete escaped rollback'; end if;
end $$;
alter table mech_release_queue drop constraint reject_test;
-- Both physical tables survive weekly renaming; inactive mirror deletes are ignored.
insert into mechalol_pages_temp values(40,'inactive',null);
delete from mechalol_pages_temp;
alter table mechalol_pages rename to swap_hold;
alter table mechalol_pages_temp rename to mechalol_pages;
alter table swap_hold rename to mechalol_pages_temp;
insert into mechalol_pages values(50,'active after swap',2);
delete from mechalol_pages;
do $$ begin
 if (select count(*) from mech_release_queue)<>1 or (select mechalol_id from mech_release_queue)<>50 then
   raise exception 'weekly swap capture failed'; end if;
end $$;
select recompute_released_mechalol_pages();
-- Checkpoint each batch: retry can resume with the remaining rows.
insert into mechalol_pages select i,'batch-'||i,null from generate_series(100,600) i;
delete from mechalol_pages;
do $$ declare n integer; begin
 n := recompute_released_mechalol_pages();
 if n<>500 then raise exception 'batch size %',n; end if;
 if (select count(*) from mech_release_queue)<>1 then raise exception 'batch boundary'; end if;
 n := recompute_released_mechalol_pages();
 if n<>1 then raise exception 'batch resume'; end if;
 n := recompute_released_mechalol_pages();
 if n<>0 then raise exception 'queue not drained'; end if;
end $$;
'''

@unittest.skipUnless(os.getenv('DELTA_TEST_DB_URL'), 'requires isolated PostgreSQL')
class ReleaseSqlTest(unittest.TestCase):
    def test_atomic_release_and_retry(self):
        subprocess.run(['psql', os.environ['DELTA_TEST_DB_URL'], '-X', '-v', 'ON_ERROR_STOP=1'], input=fixture_sql(), text=True, check=True, capture_output=True)
