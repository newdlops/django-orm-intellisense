import io
import json
import sys
import tempfile
import threading
import unittest
import weakref
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest import mock

from django_orm_intellisense.server import app


class StdioShutdownTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='djls-stdio-test-')
        self.addCleanup(temporary.cleanup)
        self.output = io.StringIO()
        with mock.patch.object(sys, 'stdout', self.output):
            self.server = app.DaemonServer(Path(temporary.name))
        current_thread = threading.current_thread()
        self.addCleanup(setattr, current_thread, 'name', current_thread.name)

    def run_with_input(self, lines):
        with mock.patch.object(sys, 'stdin', io.StringIO(lines)):
            self.server.run_stdio()

    def assert_stopped(self):
        self.assertTrue(self.server._stopping.is_set())
        self.assertEqual(self.server._state_generation, 1)

    def test_handler_failure_stops_actual_refresh_thread_and_both_pools(self):
        thread = threading.Thread(target=self.server._stopping.wait, daemon=True)
        thread.start()
        self.server._runtime_member_refresh_thread = thread
        self.addCleanup(thread.join, 1)
        self.addCleanup(self.server._stopping.set)
        self.server._bg_pool = mock.Mock()
        self.server._fallback_bg_pool = mock.Mock()
        failure = RuntimeError('request failed')
        with mock.patch.object(self.server, '_handle_request', side_effect=failure):
            with self.assertRaises(RuntimeError) as raised:
                self.run_with_input('{"id": 1, "method": "health"}\n')
        self.assertIs(raised.exception, failure)
        self.assert_stopped()
        self.assertFalse(thread.is_alive())
        self.server._bg_pool.shutdown.assert_called_once_with(wait=False)
        self.server._fallback_bg_pool.shutdown.assert_called_once_with(wait=False)

    def test_input_failure_cancels_idle_load_and_pending_runtime_refresh(self):
        failure = OSError('input disconnected')
        class BrokenInput:
            def __iter__(self):
                raise failure
        idle_timer = mock.Mock()
        refresh_timer = mock.Mock()
        self.server._surface_load_idle_timer = idle_timer
        self.server._runtime_member_refresh_timer = refresh_timer
        self.server._runtime_member_refresh_pending = True
        with mock.patch.object(sys, 'stdin', BrokenInput()):
            with self.assertRaises(OSError) as raised:
                self.server.run_stdio()
        self.assertIs(raised.exception, failure)
        self.assert_stopped()
        idle_timer.cancel.assert_called_once_with()
        refresh_timer.cancel.assert_called_once_with()
        self.assertIsNone(self.server._surface_load_idle_timer)
        self.assertIsNone(self.server._runtime_member_refresh_timer)
        self.assertFalse(self.server._runtime_member_refresh_pending)

    def test_keyboard_interrupt_still_runs_shutdown(self):
        self.server._fallback_bg_pool = mock.Mock()
        with mock.patch.object(self.server, '_handle_request', side_effect=KeyboardInterrupt):
            with self.assertRaises(KeyboardInterrupt):
                self.run_with_input('{"id": 1, "method": "health"}\n')
        self.assert_stopped()
        self.server._fallback_bg_pool.shutdown.assert_called_once_with(wait=False)

    def test_error_response_write_failure_still_runs_shutdown(self):
        failure = BrokenPipeError('output disconnected')
        with mock.patch.object(self.server, '_write_error', side_effect=failure):
            with self.assertRaises(BrokenPipeError) as raised:
                self.run_with_input('not-json\n')
        self.assertIs(raised.exception, failure)
        self.assert_stopped()

    def test_background_dispatch_failure_still_shuts_down_pool(self):
        self.server._bg_pool = mock.Mock()
        with mock.patch.object(self.server, '_submit_bg', side_effect=RuntimeError('dispatch failed')):
            with self.assertRaisesRegex(RuntimeError, 'dispatch failed'):
                self.run_with_input('{"id": 1, "method": "health", "background": true}\n')
        self.assert_stopped()
        self.server._bg_pool.shutdown.assert_called_once_with(wait=False)

    def test_normal_eof_keeps_existing_shutdown_behavior(self):
        self.server._bg_pool = mock.Mock()
        self.server._fallback_bg_pool = mock.Mock()
        self.run_with_input('')
        self.assert_stopped()
        self.server._bg_pool.shutdown.assert_called_once_with(wait=False)
        self.server._fallback_bg_pool.shutdown.assert_called_once_with(wait=False)

    def test_invalid_json_does_not_discard_next_valid_request(self):
        with mock.patch.object(self.server, '_handle_request') as handle:
            self.run_with_input('not-json\n{"id": 2, "method": "health"}\n')
        messages = [json.loads(line) for line in self.output.getvalue().splitlines()]
        self.assertEqual([message['error']['code'] for message in messages], ['invalid_json'])
        handle.assert_called_once()
        self.assertEqual(handle.call_args.args[0]['id'], 2)
        self.assertIn('_dequeued_at', handle.call_args.args[0])
        self.assert_stopped()

    def test_non_object_json_is_rejected_and_next_valid_request_is_processed(self):
        invalid = [[], None, True, 42, 'request']
        lines = ''.join(json.dumps(value) + '\n' for value in invalid)
        with mock.patch.object(self.server, '_handle_request') as handle:
            self.run_with_input(lines + '{"id": 3, "method": "health"}\n')
        messages = [json.loads(line) for line in self.output.getvalue().splitlines()]
        self.assertEqual(len(messages), len(invalid))
        self.assertTrue(all(message['id'] is None for message in messages))
        self.assertEqual([message['error']['code'] for message in messages], ['invalid_request'] * len(invalid))
        handle.assert_called_once()
        self.assertEqual(handle.call_args.args[0]['id'], 3)
        self.assert_stopped()

    def schedule_publication_retry(self):
        self.server._schedule_surface_snapshot_retry(0, delay_seconds=60)
        timer = self.server._surface_publish_retry_timer
        timer_ref = weakref.ref(timer)
        def cleanup():
            pending = timer_ref()
            if pending is not None:
                pending.cancel()
                pending.join(1)
        self.addCleanup(cleanup)
        return timer

    def test_shutdown_cancels_actual_publication_retry_timer(self):
        timer = self.schedule_publication_retry()
        self.run_with_input('')
        timer.join(1)
        self.assertFalse(timer.is_alive(), 'Stopped server kept its publication retry thread waiting')
        self.assertIsNone(self.server._surface_publish_retry_timer)
        self.assertIsNone(self.server._surface_publish_retry_generation)

    def test_shutdown_releases_publication_retry_owner_without_gc(self):
        timer = self.schedule_publication_retry()
        owner = weakref.ref(self.server)
        self.run_with_input('')
        timer.join(1)
        self.assertFalse(timer.is_alive())
        del self.server
        del timer
        self.assertIsNone(owner(), 'Canceled retry retained its server owner')


class StdioShutdownFailureTests(unittest.TestCase):
    setUp = StdioShutdownTests.setUp
    run_with_input = StdioShutdownTests.run_with_input
    assert_stopped = StdioShutdownTests.assert_stopped

    def test_shutdown_handles_refresh_registered_before_thread_start(self):
        self.check_refresh_start_boundary(pause_after_ident=False)

    def test_shutdown_handles_ident_assigned_before_started_signal(self):
        self.check_refresh_start_boundary(pause_after_ident=True)

    def check_refresh_start_boundary(self, *, pause_after_ident):
        self.server._runtime_member_refresh_pending = True
        registered = threading.Event()
        release_start = threading.Event()
        workers = []
        signals = []
        failures = []
        original_start = threading.Thread.start

        def delayed_start(thread):
            if thread.name == 'runtime-member-refresh':
                workers.append(thread)
                if pause_after_ident:
                    signal = thread._started
                    original_signal = signal.set
                    signals.append((signal, original_signal))
                    def paused_signal():
                        registered.set()
                        if not release_start.wait(3):
                            raise AssertionError('Paused started signal was not released')
                        original_signal()
                    signal.set = paused_signal
                else:
                    registered.set()
                    if not release_start.wait(3):
                        raise AssertionError('Paused refresh startup was not released')
            return original_start(thread)

        def prepare_refresh():
            try:
                self.server._start_runtime_member_refresh()
            except BaseException as error:
                failures.append(error)

        with mock.patch.object(threading.Thread, 'start', delayed_start), \
                mock.patch.object(app, 'snapshot_python_sources') as snapshot:
            preparer = threading.Thread(target=prepare_refresh, daemon=True, name='stdio-start-control')
            preparer.start()
            try:
                self.assertTrue(registered.wait(3))
                self.run_with_input('')
                self.assert_stopped()
            finally:
                release_start.set()
                preparer.join(3)
                for thread in workers:
                    if thread.ident is not None:
                        thread.join(3)
                for signal, original_signal in signals:
                    signal.set = original_signal
            self.assertFalse(preparer.is_alive())
            self.assertTrue(all(not thread.is_alive() for thread in workers))
            self.assertEqual(failures, [])
            snapshot.assert_not_called()

    def test_failed_pool_shutdown_still_stops_fallback_pool(self):
        self.server._bg_pool = mock.Mock()
        pool = ThreadPoolExecutor(max_workers=1)
        self.server._fallback_bg_pool = pool
        self.addCleanup(pool.shutdown, wait=True)
        self.addCleanup(self.server._stopping.set)
        entered = threading.Event()
        workers = []
        def wait_for_stop():
            workers.append(threading.current_thread())
            entered.set()
            return self.server._stopping.wait(3)
        future = pool.submit(wait_for_stop)
        self.assertTrue(entered.wait(3))
        failure = OSError('pool shutdown failed')
        self.server._bg_pool.shutdown.side_effect = failure
        with self.assertRaises(OSError) as raised:
            self.run_with_input('')
        self.assertIs(raised.exception, failure)
        self.assert_stopped()
        self.assertTrue(future.result(3))
        workers[0].join(3)
        self.assertFalse(workers[0].is_alive(), 'Failed pool cleanup left the fallback worker alive')

    def test_cleanup_failure_retains_original_request_exception(self):
        self.server._bg_pool = mock.Mock()
        self.server._fallback_bg_pool = mock.Mock()
        request_failure = ValueError('request failure')
        cleanup_failure = OSError('cleanup failure')
        self.server._bg_pool.shutdown.side_effect = cleanup_failure
        with mock.patch.object(self.server, '_handle_request', side_effect=request_failure):
            with self.assertRaises(OSError) as raised:
                self.run_with_input('{"id":1,"method":"health"}\n')
        self.assertIs(raised.exception, cleanup_failure)
        chain = []
        error = raised.exception
        while error is not None and all(error is not previous for previous in chain):
            chain.append(error)
            error = error.__context__
        self.assertIn(request_failure, chain)
        self.server._fallback_bg_pool.shutdown.assert_called_once_with(wait=False)


if __name__ == '__main__':
    unittest.main()
