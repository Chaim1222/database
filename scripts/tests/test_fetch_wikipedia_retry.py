import os
import sys
import types
import unittest
from pathlib import Path
from unittest import mock

os.environ.setdefault("SUPABASE_URL", "http://localhost")
os.environ.setdefault("SUPABASE_SERVICE_KEY", "x")
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.modules.setdefault("supabase", types.SimpleNamespace(create_client=lambda *a, **k: None))

import requests  # noqa: E402
import fetch_wikipedia as fw  # noqa: E402


def http_error(status, retry_after=None):
    response = requests.Response()
    response.status_code = status
    if retry_after is not None:
        response.headers["Retry-After"] = str(retry_after)
    return requests.HTTPError(f"{status} Client Error", response=response)


class RetryWaitTests(unittest.TestCase):
    def test_429_honors_retry_after(self):
        self.assertEqual(fw.retry_wait_seconds(http_error(429, 22), 1), 22)

    def test_429_retry_after_is_capped(self):
        self.assertEqual(fw.retry_wait_seconds(http_error(429, 9999), 1), 300)

    def test_429_without_header_backs_off_exponentially_up_to_120(self):
        self.assertEqual(fw.retry_wait_seconds(http_error(429), 1), 10)
        self.assertEqual(fw.retry_wait_seconds(http_error(429), 3), 40)
        self.assertEqual(fw.retry_wait_seconds(http_error(429), 6), 120)

    def test_other_errors_keep_the_old_backoff(self):
        self.assertEqual(fw.retry_wait_seconds(requests.ConnectionError("x"), 1), 1)
        self.assertEqual(fw.retry_wait_seconds(requests.ConnectionError("x"), 4), 8)
        self.assertEqual(fw.retry_wait_seconds(http_error(500), 9), 30)


class AllpagesRetryTests(unittest.TestCase):
    def test_recovers_after_429(self):
        calls = []

        def fake_get(url, **kwargs):
            calls.append(1)
            response = requests.Response()
            if len(calls) == 1:
                response.status_code = 429
                response.headers["Retry-After"] = "7"
                return response
            response.status_code = 200
            response._content = b'{"query": {"allpages": [{"title": "\\u05d0", "pageid": 1}]}}'
            return response

        with mock.patch.object(fw.requests, "get", side_effect=fake_get), \
                mock.patch.object(fw.time, "sleep") as sleep, \
                mock.patch.object(fw, "save_progress"):
            batches = list(fw.fetch_all_titles(None))
        self.assertEqual(batches, [[{"title": "א", "id": 1}]])
        self.assertEqual(len(calls), 2)
        self.assertIn(mock.call(7), sleep.call_args_list)


if __name__ == "__main__":
    unittest.main()
