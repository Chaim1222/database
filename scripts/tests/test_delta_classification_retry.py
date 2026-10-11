import unittest
from unittest.mock import patch
from test_mechalol_delta_renames import FakeClient, move
import fetch_mechalol_delta as delta
import fetch_mechalol as fetch
import match

class ClassificationTests(unittest.TestCase):
    def test_move_without_edit_reclassifies_final_title_and_replays(self):
        client = FakeClient([{'id':1,'title':'old','status':'מיובא ללא תיעוד'}])
        moves = [move(1,'old','middle','2026-10-01T00:00:00Z'),move(1,'middle','final','2026-10-01T01:00:00Z')]
        with patch.object(delta,'fetch_edited_page_ids',return_value=[]), patch.object(delta,'fetch_redirect_status',return_value={'final':False}), patch.object(delta,'fetch_own_categories',return_value={'final':{fetch.CATEGORY_CREATED_IN_MECHALOL}}) as cats:
            for _ in range(2):
                deletions, updates = delta.detect_edited_tracked_changes(client,'start',set(),renames=moves)
                delta.apply_core(client,[],deletions,moves,{})
                delta.apply_status_updates(client,updates)
                self.assertEqual(client.store[1]['title'],'final')
                self.assertEqual(client.store[1]['status'],fetch.STATUS_CREATED_IN_MECHALOL)
            cats.assert_called_with(['final'])

    def test_created_or_deleted_move_stays_excluded(self):
        with patch.object(delta,'fetch_edited_page_ids',return_value=[]), patch.object(delta,'find_tracked_ids') as lookup:
            self.assertEqual(delta.detect_edited_tracked_changes(object(),'start',{1},renames=[move(1,'old','new','now')]),([],[]))
            lookup.assert_not_called()

class DrainTests(unittest.TestCase):
    def test_drains_multiple_batches(self):
        from types import SimpleNamespace
        with patch.object(match,'execute_with_retry',side_effect=[SimpleNamespace(data=500),SimpleNamespace(data=1),SimpleNamespace(data=0)]):
            self.assertEqual(match.drain_released_pages(object()),501)

    def test_failure_propagates_to_prevent_watermark_advance(self):
        from types import SimpleNamespace
        with patch.object(match,'execute_with_retry',side_effect=[SimpleNamespace(data=500),RuntimeError('timeout')]):
            with self.assertRaisesRegex(RuntimeError,'timeout'):
                match.drain_released_pages(object())
