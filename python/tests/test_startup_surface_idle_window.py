"""A startup idle interval may overlap owned warmup, without changing edit delay."""
import contextlib
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from django_orm_intellisense.discovery.workspace import snapshot_python_sources, source_membership_fingerprint
from django_orm_intellisense.server import app
from django_orm_intellisense.static_index.indexer import build_static_index
from tests.test_static_fallback_surface_gap import _make_server, _ready_runtime, _warmup_patches, _write_blog_models


class RecordedTimer:
    def __init__(self, interval, callback):
        self.interval, self.callback = interval, callback
        self.started = 0
        self.cancelled = False

    def start(self):
        self.started += 1

    def cancel(self):
        self.cancelled = True


class StartupSurfaceIdleWindowTests(unittest.TestCase):
    def setUp(self):
        self.server = _make_server(Path('/workspace'))
        self.server._state_generation = 7
        self.clock = [101.25]
        self.timers = []
        self.stack = contextlib.ExitStack()
        self.addCleanup(self.stack.close)
        self.addCleanup(self.server._cancel_surface_index_idle_load)
        self.stack.enter_context(mock.patch.dict(os.environ, {}, clear=False))
        for name in ('DJLS_SURFACE_CACHE_LOAD_MODE', 'DJLS_SURFACE_CACHE_IDLE_MS'):
            os.environ.pop(name, None)
        self.stack.enter_context(mock.patch.object(app.time, 'perf_counter', side_effect=lambda: self.clock[0]))
        self.stack.enter_context(mock.patch.object(app, '_log_initialize_step'))
        self.stack.enter_context(mock.patch.object(app.threading, 'Timer', side_effect=self.timer))

    def timer(self, interval, callback):
        timer = RecordedTimer(interval, callback)
        self.timers.append(timer)
        return timer

    def schedule(self, **kwargs):
        self.server._schedule_surface_index_idle_load(reason='runtime_warmup', expected_generation=7, **kwargs)

    def test_existing_trigger_without_warmup_clock_retains_full_default_interval(self):
        self.schedule()
        self.assertEqual(len(self.timers), 1)
        self.assertEqual(self.timers[0].interval, 2.0)
        self.assertEqual(self.timers[0].started, 1)
        self.assertEqual(self.timers[0].name, 'surface-index-idle-load-timer')
        self.assertTrue(self.timers[0].daemon)

    def test_owned_warmup_overlaps_default_and_custom_intervals(self):
        for configured, elapsed, expected in ((None, 1.25, 0.75), ('5000', 2.0, 3.0), ('invalid', 1.25, 0.75)):
            with self.subTest(configured=configured):
                self.server._cancel_surface_index_idle_load()
                self.timers.clear()
                if configured is None:
                    os.environ.pop('DJLS_SURFACE_CACHE_IDLE_MS', None)
                else:
                    os.environ['DJLS_SURFACE_CACHE_IDLE_MS'] = configured
                self.clock[0] = 100 + elapsed
                self.schedule(idle_since=100.0)
                self.assertEqual(len(self.timers), 1)
                self.assertAlmostEqual(self.timers[0].interval, expected)

    def test_finished_interval_requests_complete_surface_without_an_extra_timer(self):
        for now in (102.0, 105.0):
            with self.subTest(now=now), mock.patch.object(self.server, '_request_surface_index_load') as request:
                self.clock[0] = now
                self.schedule(idle_since=100.0)
                request.assert_called_once_with(reason='idle:runtime_warmup', expected_generation=7)
                self.assertEqual(self.timers, [])

    def test_source_edits_keep_the_full_configured_interval(self):
        self.server._source_snapshot_dirty = True
        self.clock[0] = 110.0
        self.schedule(idle_since=100.0)
        self.assertEqual(len(self.timers), 1)
        self.assertEqual(self.timers[0].interval, 2.0)

    def test_explicit_disabled_ondemand_and_eager_modes_keep_their_behavior(self):
        for mode in ('0', 'off', 'false', 'disabled', 'none', 'ondemand', 'on_demand', 'on-demand', 'eager', 'immediate'):
            with self.subTest(mode=mode), mock.patch.object(self.server, '_request_surface_index_load') as request:
                os.environ['DJLS_SURFACE_CACHE_LOAD_MODE'] = mode
                self.clock[0] = 110.0
                self.schedule(idle_since=100.0)
                if mode in ('eager', 'immediate'):
                    request.assert_called_once_with(reason='eager:runtime_warmup', expected_generation=7)
                else:
                    request.assert_not_called()
                self.assertEqual(self.timers, [])
        os.environ['DJLS_SURFACE_CACHE_LOAD_MODE'] = 'idle'
        os.environ['DJLS_SURFACE_CACHE_IDLE_MS'] = '0'
        with mock.patch.object(self.server, '_request_surface_index_load') as request:
            self.schedule(idle_since=100.0)
            request.assert_called_once_with(reason='idle:runtime_warmup', expected_generation=7)

    def test_superseded_or_stopping_owner_cannot_register_a_timer_or_request(self):
        for changed in ('generation', 'stopping'):
            with self.subTest(changed=changed), mock.patch.object(self.server, '_request_surface_index_load') as request:
                self.server._state_generation = 8 if changed == 'generation' else 7
                if changed == 'stopping':
                    self.server._stopping.set()
                self.schedule(idle_since=100.0)
                request.assert_not_called()
                self.assertEqual(self.timers, [])

    def test_owner_change_during_delay_configuration_cannot_occupy_the_new_slot(self):
        def configure():
            self.server._state_generation = 8
            return 2.0
        with mock.patch.object(self.server, '_surface_cache_idle_delay_seconds', side_effect=configure):
            self.schedule(idle_since=100.0)
        self.assertEqual(self.timers, [])
        self.assertIsNone(self.server._surface_load_idle_timer)

    def test_late_retired_timer_does_not_clear_or_start_the_new_generation(self):
        self.schedule(idle_since=100.0)
        retired = self.timers[0]
        generation = self.server._reserve_state_generation(workspace_root=Path('/workspace'), initialized_at=self.server.initialized_at)
        self.assertEqual(generation, 8)
        self.assertTrue(retired.cancelled)
        self.server._schedule_surface_index_idle_load(reason='initialize', expected_generation=8)
        current = self.timers[1]
        with mock.patch.object(app.threading, 'current_thread', return_value=retired), \
                mock.patch.object(self.server, '_start_surface_index_prebuild_for_current_state') as start:
            retired.callback()
        start.assert_not_called()
        self.assertIs(self.server._surface_load_idle_timer, current)
        self.assertFalse(current.cancelled)

    def test_duplicate_trigger_and_existing_prebuild_do_not_restart_the_idle_window(self):
        self.clock[0] = 100.5
        self.schedule(idle_since=100.0)
        first = self.timers[0]
        self.clock[0] = 101.5
        self.schedule(idle_since=100.0)
        self.assertEqual(len(self.timers), 1)
        self.assertEqual(first.interval, 1.5)
        self.assertEqual(first.started, 1)
        self.assertFalse(first.cancelled)
        self.server._cancel_surface_index_idle_load()
        self.timers.clear()
        for state in ('already_attempted', 'active_prebuild'):
            with self.subTest(state=state):
                self.server._surface_load_attempted_generation = 7 if state == 'already_attempted' else None
                self.server._surface_prebuild_future = object() if state == 'active_prebuild' else None
                self.schedule(idle_since=100.0)
                self.assertEqual(self.timers, [])

    def test_real_warmup_carries_its_original_clock_after_runtime_and_cache_work(self):
        with tempfile.TemporaryDirectory(prefix='djls-warmup-window-') as name:
            root = Path(name)
            _write_blog_models(root)
            index = build_static_index(root)
            snapshot = snapshot_python_sources(root, max_workers=1)
            membership = source_membership_fingerprint(snapshot)
            server = _make_server(root)
            server._state_generation = 7
            self.addCleanup(server._cancel_surface_index_idle_load)
            runtime, notifications = _ready_runtime(), []
            self.clock[0] = 100.0
            def inspect(_settings):
                self.clock[0] = 103.0
                return runtime
            def save_graph(*args, **kwargs):
                self.clock[0] = 104.0
            with contextlib.ExitStack() as stack:
                for number, patch in enumerate(_warmup_patches(server, notifications)):
                    if number != 3:
                        stack.enter_context(patch)
                stack.enter_context(mock.patch.object(app, 'inspect_runtime', side_effect=inspect))
                stack.enter_context(mock.patch.object(app, 'save_model_graph', side_effect=save_graph))
                request = stack.enter_context(mock.patch.object(server, '_request_surface_index_load'))
                server._warm_runtime_state(generation=7, initialized_at=server.initialized_at, workspace_root=root,
                    workspace_profile=mock.Mock(), static_index=index, runtime_source_fingerprint='original-runtime-key',
                    settings_module='project.settings', source_snapshot=snapshot, source_membership=membership)
                request.assert_called_once_with(reason='idle:runtime_warmup', expected_generation=7)
            self.assertIs(server.runtime_inspection, runtime)
            self.assertEqual(server.model_graph.find_field('blog.Post', 'title').field_kind, 'CharField')
            self.assertEqual(self.clock[0], 104.0)
            self.assertEqual(len(notifications), 1)
            self.assertFalse(server._source_snapshot_dirty)
            self.assertEqual(self.timers, [])


if __name__ == '__main__':
    unittest.main()
