import os, sys, unittest
from contextlib import ExitStack
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import Mock, patch
os.environ.setdefault('SUPABASE_URL', 'http://localhost')
os.environ.setdefault('SUPABASE_SERVICE_KEY', 'x')
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import delta_api
import mechalol_api
import sort_template_hourly as hourly
from fetch_sort_templates import fetch_contents
from config import MECHALOL_API, REQUEST_HEADERS

class HourlyAuthTests(unittest.TestCase):
    def setUp(self):
        self.old_params = dict(mechalol_api.session.params)
        self.addCleanup(lambda: setattr(mechalol_api.session, 'params', self.old_params))

    def test_failed_login_stops_normal_and_dry_run_before_reads_or_database(self):
        for argv in (['hourly'], ['hourly', '--dry-run']):
            with self.subTest(argv=argv), patch.object(sys, 'argv', argv), patch.object(hourly, 'login', return_value=False), patch.object(hourly, 'fetch_edited_page_ids') as read, patch('supabase_client.get_client') as db:
                with self.assertRaises(SystemExit): hourly.main()
                read.assert_not_called()
                db.assert_not_called()

    def test_successful_dry_run_uses_authenticated_reader(self):
        with patch.object(sys, 'argv', ['hourly', '--dry-run']), patch.object(hourly, 'login', return_value=True), patch.object(hourly, 'fetch_edited_page_ids', return_value=[]) as read, patch.object(hourly, 'collect_changes', return_value=({}, 0)):
            hourly.main()
        self.assertIs(read.call_args.kwargs['api_get'], mechalol_api.api_get_with_retry)
        self.assertEqual(mechalol_api.session.params['assert'], 'user')

    def test_pagination_and_content_share_cookies_agent_and_assertion(self):
        session = mechalol_api.session
        session.params['assert'] = 'user'
        old_cookies = session.cookies.copy()
        self.addCleanup(lambda: setattr(session, 'cookies', old_cookies))
        session.cookies.set('session', 'fixture')
        calls = []
        responses = [
            {'query': {'recentchanges': [{'pageid': 1, 'title': 'א'}]}, 'continue': {'rccontinue': 'next'}},
            {'query': {'recentchanges': [{'pageid': 2, 'title': 'ב'}]}},
            {'query': {'pages': [{'pageid': 1, 'revisions': [{'revid': 10, 'timestamp': 't', 'slots': {'main': {'content': 'text'}}}]}]}}
        ]
        def send(request, **kwargs):
            calls.append(request)
            response = Mock()
            response.json.return_value = responses.pop(0)
            return response
        with patch.object(session, 'send', side_effect=send), patch('delta_api.requests.get') as anonymous:
            rows = delta_api.fetch_edited_page_ids(MECHALOL_API, '2026-10-10T00:00:00Z', api_get=mechalol_api.api_get_with_retry)
            self.assertEqual([r['page_id'] for r in rows], [1, 2])
            self.assertEqual(fetch_contents([1])[1]['rev_id'], 10)
            anonymous.assert_not_called()
        for request in calls:
            self.assertIn('assert=user', request.url)
            self.assertIn('session=fixture', request.headers['Cookie'])
            self.assertEqual(request.headers['User-Agent'], REQUEST_HEADERS['User-Agent'])

    def test_expired_session_does_not_advance_mechalol_watermark(self):
        response = Mock()
        response.json.return_value = {'error': {'code': 'assertuserfailed'}}
        with ExitStack() as stack:
            stack.enter_context(patch.object(sys, 'argv', ['hourly']))
            stack.enter_context(patch.object(hourly, 'login', return_value=True))
            stack.enter_context(patch('supabase_client.get_client', return_value=Mock()))
            stack.enter_context(patch.object(hourly, 'read_since', return_value=datetime.now(timezone.utc)))
            stack.enter_context(patch.object(mechalol_api.session, 'get', return_value=response))
            stack.enter_context(patch.object(hourly, 'wikipedia_step'))
            process = stack.enter_context(patch.object(hourly, 'process_pages'))
            success = stack.enter_context(patch.object(hourly, 'save_success'))
            failure = stack.enter_context(patch.object(hourly, 'save_failure'))
            with self.assertRaises(SystemExit): hourly.main()
            process.assert_not_called()
            self.assertEqual(success.call_args.args[1], 'wikipedia_changes')
            self.assertEqual(success.call_count, 1)
            self.assertEqual(failure.call_args.args[1], 'mechalol_changes')

    def test_default_delta_reader_remains_unchanged(self):
        with patch.object(delta_api, '_api_get_with_retry', return_value={'query': {'recentchanges': []}}) as read:
            self.assertEqual(delta_api.fetch_edited_page_ids(MECHALOL_API, 't'), [])
            self.assertEqual(read.call_args.args[0], MECHALOL_API)
