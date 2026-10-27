import io
import sys
import threading
import time
import unittest
import weakref
from unittest import mock

import test_async_runtime_members as async_tests
from django_orm_intellisense.server import app


_Thread = threading.Thread
_Timer = threading.Timer
_start = threading.Thread.start
_run = threading.Thread.run


class _CannotStartThread(_Thread):
    def start(self):
        raise RuntimeError('runtime thread unavailable')


class RuntimeRefreshRecoveryTests(unittest.TestCase):
    setUp = async_tests.AsyncRuntimeMemberTests.setUp
    create_server = async_tests.AsyncRuntimeMemberTests.server
    snapshot = async_tests.AsyncRuntimeMemberTests.snapshot
    result = async_tests.AsyncRuntimeMemberTests.result

    def prepare(self):
        server = self.create_server()
        server._runtime_member_refresh_token = 1
        server._runtime_member_refresh_pending = True
        return server

    def recover_on_next_save(self, server):
        timer = mock.Mock()
        with mock.patch.object(app.threading, 'Timer', return_value=timer):
            server._schedule_runtime_member_refresh()
        self.assertTrue(server._runtime_member_refresh_pending)
        self.assertIs(server._runtime_member_refresh_timer, timer)
        self.run_pending(server)

    def run_pending(self, server):
        workers = []
        def record(thread):
            if thread.name == 'runtime-member-refresh':
                workers.append(thread)
            return _start(thread)
        with mock.patch.object(_Thread, 'start', record), \
                mock.patch.object(app, 'refresh_in_process', return_value=self.result()) as capture, \
                mock.patch.object(server, '_publish_current_surface_snapshot') as publish:
            server._start_runtime_member_refresh(server._runtime_member_refresh_token)
            for worker in workers:
                worker.join(3)
                self.assertFalse(worker.is_alive())
        self.assertEqual(len(workers), 1)
        capture.assert_called_once()
        publish.assert_called_once()
        self.assertIsNone(server._runtime_member_refresh_thread)
        self.assertFalse(server._runtime_member_refresh_pending)
        self.assertEqual(server._runtime_member_ready_token, server._runtime_member_refresh_token)

    def test_worker_allocation_failure_keeps_work_pending_and_next_save_recovers(self):
        server = self.prepare()
        with mock.patch.object(app.threading, 'Thread', side_effect=MemoryError('thread allocation failed')):
            with self.assertRaisesRegex(MemoryError, 'thread allocation failed'):
                server._start_runtime_member_refresh(1)
        self.assertIsNone(server._runtime_member_refresh_thread)
        self.assertTrue(server._runtime_member_refresh_pending)
        self.recover_on_next_save(server)

    def test_worker_start_failure_drops_failed_owner_and_next_save_recovers(self):
        server = self.prepare()
        with mock.patch.object(app.threading, 'Thread', _CannotStartThread):
            with self.assertRaisesRegex(RuntimeError, 'runtime thread unavailable'):
                server._start_runtime_member_refresh(1)
        self.assertIsNone(server._runtime_member_refresh_thread)
        self.assertTrue(server._runtime_member_refresh_pending)
        self.recover_on_next_save(server)

    def test_unstarted_failure_releases_server_without_forced_gc(self):
        with mock.patch.object(sys, 'stdout', io.StringIO()):
            server = app.DaemonServer(self.root)
        server._runtime_member_refresh_pending = True
        owner = weakref.ref(server)
        with mock.patch.object(app.threading, 'Thread', _CannotStartThread):
            with self.assertRaisesRegex(RuntimeError, 'runtime thread unavailable'):
                server._start_runtime_member_refresh()
        self.assertIsNone(server._runtime_member_refresh_thread)
        del server
        self.assertIsNone(owner(), 'Unstarted thread retained its server owner')

    def test_start_error_after_task_entry_preserves_live_owner_and_finishes_once(self):
        server = self.prepare()
        entered, release = threading.Event(), threading.Event()
        workers = []
        def capture(*args):
            entered.set()
            if not release.wait(3):
                raise AssertionError('Active refresh was not released')
            return self.result()
        def started_then_failed(thread):
            _start(thread)
            if thread.name == 'runtime-member-refresh':
                workers.append(thread)
                if not entered.wait(3):
                    raise AssertionError('Actual refresh did not enter capture')
                raise RuntimeError('start interrupted after entry')
        with mock.patch.object(_Thread, 'start', started_then_failed), \
                mock.patch.object(app, 'refresh_in_process', capture), \
                mock.patch.object(server, '_publish_current_surface_snapshot') as publish:
            try:
                with self.assertRaisesRegex(RuntimeError, 'after entry'):
                    server._start_runtime_member_refresh(1)
                self.assertIs(server._runtime_member_refresh_thread, workers[0])
                self.assertFalse(server._runtime_member_refresh_pending)
            finally:
                release.set()
                for worker in workers:
                    worker.join(3)
            self.assertTrue(all(not worker.is_alive() for worker in workers))
            publish.assert_called_once()

    def test_late_native_entry_is_revoked_and_cannot_run_after_retry(self):
        server = self.prepare()
        release, native_waiting = threading.Event(), threading.Event()
        workers = []
        def delayed_run(thread):
            if thread.name == 'runtime-member-refresh' and thread in workers:
                native_waiting.set()
                if not release.wait(3):
                    raise AssertionError('Late native thread was not released')
            return _run(thread)
        def failed_after_native_start(thread):
            if thread.name == 'runtime-member-refresh':
                workers.append(thread)
                _start(thread)
                if not native_waiting.wait(3):
                    raise AssertionError('Native thread did not reach its pre-entry gate')
                raise RuntimeError('start interrupted before task entry')
            return _start(thread)
        with mock.patch.object(_Thread, 'run', delayed_run), \
                mock.patch.object(_Thread, 'start', failed_after_native_start), \
                mock.patch.object(app, 'refresh_in_process', return_value=self.result()) as capture, \
                mock.patch.object(server, '_publish_current_surface_snapshot'):
            try:
                with self.assertRaisesRegex(RuntimeError, 'before task entry'):
                    server._start_runtime_member_refresh(1)
                self.assertIsNone(server._runtime_member_refresh_thread)
                self.assertTrue(server._runtime_member_refresh_pending)
            finally:
                release.set()
                for worker in workers:
                    worker.join(3)
            self.assertTrue(all(not worker.is_alive() for worker in workers))
            capture.assert_not_called()
        self.recover_on_next_save(server)

    def test_new_save_whose_timer_fired_during_failed_start_is_rearmed(self):
        server = self.prepare()
        scheduled, retry = mock.Mock(), mock.Mock()
        def failed_start(thread):
            server._schedule_runtime_member_refresh()
            server._start_runtime_member_refresh(server._runtime_member_refresh_token)
            raise RuntimeError('older worker could not start')
        with mock.patch.object(app.threading, 'Timer', side_effect=[scheduled, retry]) as timers, \
                mock.patch.object(_Thread, 'start', failed_start):
            with self.assertRaisesRegex(RuntimeError, 'older worker could not start'):
                server._start_runtime_member_refresh(1)
        self.assertIsNone(server._runtime_member_refresh_thread)
        self.assertEqual(server._runtime_member_refresh_token, 2)
        self.assertTrue(server._runtime_member_refresh_pending)
        self.assertIs(server._runtime_member_refresh_timer, retry)
        self.assertEqual(timers.call_args.kwargs['args'], (2,))
        retry.start.assert_called_once_with()
        scheduled.cancel.assert_called_once_with()
        self.run_pending(server)

    def test_stop_during_failed_start_revokes_owner_without_requeue(self):
        server = self.prepare()
        def failed_start(thread):
            server._stopping.set()
            server._cancel_runtime_member_refresh()
            raise RuntimeError('start interrupted by stop')
        with mock.patch.object(_Thread, 'start', failed_start):
            with self.assertRaisesRegex(RuntimeError, 'interrupted by stop'):
                server._start_runtime_member_refresh(1)
        self.assertIsNone(server._runtime_member_refresh_thread)
        self.assertIsNone(server._runtime_member_refresh_timer)
        self.assertFalse(server._runtime_member_refresh_pending)

    def test_timer_allocation_failure_cancels_old_timer_and_next_save_recovers(self):
        server = self.prepare()
        old = _Timer(60, lambda: None)
        old.daemon = True
        old.start()
        self.addCleanup(old.join, 3)
        self.addCleanup(old.cancel)
        server._runtime_member_refresh_timer = old
        with mock.patch.object(app.threading, 'Timer', side_effect=MemoryError('timer allocation failed')):
            with self.assertRaisesRegex(MemoryError, 'timer allocation failed'):
                server._schedule_runtime_member_refresh()
        self.assertIsNone(server._runtime_member_refresh_timer)
        self.assertTrue(old.finished.is_set())
        old.join(3)
        self.assertFalse(old.is_alive())
        self.assertTrue(server._runtime_member_refresh_pending)
        self.recover_on_next_save(server)

    def test_timer_start_failure_drops_failed_owner_and_next_save_recovers(self):
        server = self.prepare()
        timers = []
        def allocate(*args, **kwargs):
            timer = _Timer(*args, **kwargs)
            timers.append(timer)
            return timer
        with mock.patch.object(app.threading, 'Timer', allocate), \
                mock.patch.object(_Timer, 'start', side_effect=RuntimeError('timer start failed')):
            with self.assertRaisesRegex(RuntimeError, 'timer start failed'):
                server._schedule_runtime_member_refresh()
        self.assertEqual(len(timers), 1)
        self.assertIsNone(server._runtime_member_refresh_timer)
        self.assertTrue(timers[0].finished.is_set())
        self.assertTrue(server._runtime_member_refresh_pending)
        self.recover_on_next_save(server)

    def test_initial_timer_keeps_existing_two_hundred_millisecond_delay(self):
        server = self.prepare()
        with mock.patch.object(app.threading, 'Timer') as timer:
            server._schedule_runtime_member_refresh()
        self.assertEqual(timer.call_args.args[0], 0.2)

    def test_retired_timer_start_error_cannot_clear_newer_timer(self):
        server = self.prepare()
        retired, current = mock.Mock(), mock.Mock()
        def newer_save_then_failure():
            server._schedule_runtime_member_refresh()
            raise RuntimeError('retired timer start failed')
        retired.start.side_effect = newer_save_then_failure
        with mock.patch.object(app.threading, 'Timer', side_effect=[retired, current]):
            with self.assertRaisesRegex(RuntimeError, 'retired timer start failed'):
                server._schedule_runtime_member_refresh()
        self.assertIs(server._runtime_member_refresh_timer, current)
        self.assertTrue(server._runtime_member_refresh_pending)
        current.cancel.assert_not_called()
        current.start.assert_called_once_with()
        self.run_pending(server)

    def test_superseded_worker_allocation_cannot_publish_an_old_owner(self):
        server = self.prepare()
        current, allocated = mock.Mock(), []
        def allocate(*args, **kwargs):
            server._schedule_runtime_member_refresh()
            thread = _Thread(*args, **kwargs)
            allocated.append(thread)
            return thread
        with mock.patch.object(app.threading, 'Timer', return_value=current), \
                mock.patch.object(app.threading, 'Thread', allocate):
            server._start_runtime_member_refresh(1)
        self.assertIsNone(server._runtime_member_refresh_thread)
        self.assertTrue(server._runtime_member_refresh_pending)
        self.assertEqual(server._runtime_member_refresh_token, 2)
        self.assertIs(server._runtime_member_refresh_timer, current)
        self.assertEqual(len(allocated), 1)
        self.assertFalse(allocated[0].is_alive())
        self.assertIsNone(allocated[0].ident)
        self.run_pending(server)

    def test_stop_during_timer_allocation_cancels_unpublished_timer(self):
        server = self.prepare()
        timer = mock.Mock()
        def allocate(*args, **kwargs):
            server._stopping.set()
            server._cancel_runtime_member_refresh()
            return timer
        with mock.patch.object(app.threading, 'Timer', allocate):
            server._schedule_runtime_member_refresh()
        self.assertIsNone(server._runtime_member_refresh_timer)
        self.assertFalse(server._runtime_member_refresh_pending)
        timer.cancel.assert_called_once_with()
        timer.start.assert_not_called()


if __name__ == '__main__':
    unittest.main()
