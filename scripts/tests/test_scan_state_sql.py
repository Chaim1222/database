"""תוקף תוצאת הסינון (migrations/20261013200000_scan_state_freshness.sql) על העתק של שלוש התצוגות החיות.
רץ על PostgreSQL מבודד בלבד (מסד זמני נפרד), לעולם לא על הייצור."""
import os
from pathlib import Path
import subprocess
import unittest

ROOT = Path(__file__).resolve().parents[2]

# ההגדרות החיות לפני המיגרציה (pg_get_viewdef, 13.10.2026)
BEFORE = '''
do $r$ begin  -- תפקידים משותפים לכל השרת; בדיקת SQL אחרת באותו שרת עשויה ליצור אותם קודם
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
end $r$;
create table wikipedia_pages (id bigint primary key, title text, checked_at timestamptz, wikidata_desc text, is_missing boolean,
  easy_import_length bigint, easy_import_has_images boolean, problematic_words_clean boolean, created_at timestamptz,
  mechalol_redirect_exists boolean, missing_override_reason text, created_at_checked boolean, easy_import_checked boolean,
  latest_rev_id bigint, latest_rev_ts timestamptz);
create table blacklist_titles (id bigint, title text, reason text, added_at timestamptz, wikipedia_id bigint);
create table word_filter_results (wikipedia_id bigint primary key, title text, rev_id bigint, length integer, verdict text,
  verdict_suggested text, counts jsonb, matches jsonb, matches_total integer, image_count integer, own_image_count integer,
  photo_count integer, has_images boolean, images jsonb, lists_version text, scanned_at timestamptz, ctx_verdict text,
  ctx_suspicion text, ctx_verdict_suggested text, ctx_suspicion_suggested text, hidden_count integer, hidden_count_suggested integer,
  dictionary text, dictionary_why text, topic text, names_count integer, names_count_suggested integer);
create view report_missing_from_mechalol with (security_invoker=true) as SELECT id, title, checked_at, wikidata_desc,
  easy_import_length, easy_import_has_images, problematic_words_clean, created_at, mechalol_redirect_exists, easy_import_checked,
  created_at_checked FROM wikipedia_pages w WHERE is_missing = true AND NOT (EXISTS ( SELECT 1 FROM blacklist_titles b
  WHERE b.title = w.title)) ORDER BY title;
create view report_missing_word_filter with (security_invoker=true) as SELECT m.id, m.title, m.checked_at, m.wikidata_desc,
  m.easy_import_length, m.created_at, m.mechalol_redirect_exists, r.verdict, r.verdict_suggested, r.has_images, r.photo_count,
  r.counts, r.matches_total, r.images, r.scanned_at, r.ctx_verdict, r.ctx_suspicion, r.ctx_verdict_suggested,
  r.ctx_suspicion_suggested, r.hidden_count, r.hidden_count_suggested, r.dictionary, r.dictionary_why, r.topic, r.names_count,
  r.names_count_suggested FROM report_missing_from_mechalol m LEFT JOIN word_filter_results r ON r.wikipedia_id = m.id;
create view report_missing_word_filter_summary with (security_invoker=true) as SELECT COALESCE(mechalol_redirect_exists, false)
  AS redirect, has_images, verdict, verdict_suggested, ctx_verdict, ctx_suspicion, ctx_verdict_suggested, ctx_suspicion_suggested,
  dictionary IS NOT NULL AS dictionary, topic, count(*)::integer AS n FROM report_missing_word_filter GROUP BY
  (COALESCE(mechalol_redirect_exists, false)), has_images, verdict, verdict_suggested, ctx_verdict, ctx_suspicion,
  ctx_verdict_suggested, ctx_suspicion_suggested, (dictionary IS NOT NULL), topic;
grant select on report_missing_from_mechalol, report_missing_word_filter, report_missing_word_filter_summary to anon, authenticated;
insert into wikipedia_pages (id, title, is_missing, latest_rev_id) values
  (1,'ישן',true,100),(2,'חדש',true,100),(3,'זהה',true,100),(4,'לא נסרק',true,100),(5,'לא ידוע',true,null),(6,'שחור',true,100),(7,'מכוסה',false,100);
insert into blacklist_titles (title) values ('שחור');
insert into word_filter_results (wikipedia_id, rev_id, verdict, ctx_verdict) values (1,99,'clean','clean'),(2,101,'clean','clean'),(3,100,'clean','clean'),(5,100,'clean','clean');
'''

AFTER = '''
do $$ begin
  if (select string_agg(id||':'||scan_state, ',' order by id) from report_missing_word_filter) <> '1:stale,2:scanned,3:scanned,4:not_scanned,5:stale' then
    raise exception 'scan_state %', (select string_agg(id||':'||scan_state, ',' order by id) from report_missing_word_filter); end if;
  if (select sum(n) from report_missing_word_filter_summary where verdict = 'clean') <> 2 then raise exception 'stale result counted as clean'; end if;
  if (select sum(n) from report_missing_word_filter_summary where scan_state = 'stale' and verdict is null) <> 2 then raise exception 'stale level'; end if;
  if (select count(*) from report_missing_from_mechalol) <> 5 then raise exception 'missing report rows changed'; end if;
  if not has_table_privilege('anon', 'report_missing_word_filter_summary', 'select') then raise exception 'grant lost'; end if;
  if (select reloptions from pg_class where relname = 'report_missing_word_filter') <> array['security_invoker=true'] then raise exception 'security_invoker lost'; end if;
end $$;
'''


@unittest.skipUnless(os.getenv('DELTA_TEST_DB_URL'), 'requires isolated PostgreSQL')
class ScanStateSqlTest(unittest.TestCase):
    def test_migration_applies_to_live_views(self):
        base = os.environ['DELTA_TEST_DB_URL']
        name = f'scan_state_test_{os.getpid()}'
        path, _, query = base.partition('?')
        url = path.rsplit('/', 1)[0] + '/' + name + ('?' + query if query else '')
        psql = lambda target, sql: subprocess.run(['psql', target, '-X', '-q', '-v', 'ON_ERROR_STOP=1'], input=sql, text=True,
                                                  check=True, capture_output=True)
        psql(base, f'create database {name}')
        try:
            migration = (ROOT / 'migrations/20261013200000_scan_state_freshness.sql').read_text()
            psql(url, BEFORE + migration + AFTER)
            psql(url, migration + AFTER)   # הרצה חוזרת: אותה תוצאה
        finally:
            psql(base, f'drop database {name}')


if __name__ == '__main__':
    unittest.main()
