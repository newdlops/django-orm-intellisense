import dataclasses
import contextlib
import io
import json
import subprocess
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock

from django_orm_intellisense.discovery.workspace import WorkspaceProfile
from django_orm_intellisense.features.health import build_health_snapshot
from django_orm_intellisense.runtime.inspector import create_pending_runtime_inspection
from django_orm_intellisense.runtime import inspector, source_imports
from django_orm_intellisense.semantic.graph import build_model_graph, build_semantic_graph
from django_orm_intellisense.server import app
from django_orm_intellisense.static_index.indexer import build_static_index


class HealthSnapshotRefreshTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='djls-health-refresh-')
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        output = sys.stdout
        try:
            self.server = app.DaemonServer(self.root)
        finally:
            sys.stdout = output
        self.addCleanup(self.server._cancel_runtime_member_refresh)
        self.server.workspace_profile = WorkspaceProfile(str(self.root), None, None, None, [])
        self.server.static_index = build_static_index(self.root)
        self.server.runtime_inspection = dataclasses.replace(create_pending_runtime_inspection(None),
            bootstrap_status='ready', model_count=7)
        self.server.model_graph = build_model_graph(self.server.static_index, self.server.runtime_inspection)
        self.server.semantic_graph = build_semantic_graph(self.server.workspace_profile,
            self.server.static_index, self.server.runtime_inspection)
        self.server.health_snapshot = build_health_snapshot(workspace=self.server.workspace_profile,
            static_index=self.server.static_index, runtime=self.server.runtime_inspection,
            semantic_graph=self.server.semantic_graph, initialized_at=self.server.initialized_at)
        self.server.health_snapshot['futureHealth'] = {'keep': True}
        for section in ('staticIndex', 'runtime', 'semanticGraph'):
            self.server.health_snapshot[section]['futureField'] = {'keep': True}

    def reindex(self, source):
        server = self.server
        with mock.patch.object(server, '_schedule_runtime_member_refresh'):
            return server._reindex_file({'filePath': str(source)})

    def assert_current(self, previous):
        current = self.server._health()
        self.assertIsNot(current, previous)
        for key, value in self.server.static_index.to_dict().items():
            self.assertEqual(current['staticIndex'][key], value)
        for key, value in self.server.semantic_graph.to_dict().items():
            self.assertEqual(current['semanticGraph'][key], value)
        self.assertEqual(current['semanticGraph']['moduleCount'],
            self.server.static_index.python_file_count)
        self.assertEqual(current['startedAt'], previous['startedAt'])
        self.assertIs(current['futureHealth'], previous['futureHealth'])
        for section in ('staticIndex', 'runtime', 'semanticGraph'):
            self.assertIs(current[section]['futureField'], previous[section]['futureField'])
        return current

    def test_helper_create_delete_updates_counts_and_phase_without_mutating_published_health(self):
        source = self.root / 'helper.py'
        initial = self.server._health()
        source.write_text('value = 1\n')
        self.assertEqual(self.reindex(source), {'unchanged': True})
        added = self.assert_current(initial)
        self.assertEqual(added['staticIndex']['pythonFileCount'], 1)
        self.assertEqual(added['phase'], 'ready')
        self.assertEqual(initial['staticIndex']['pythonFileCount'], 0)
        self.assertEqual(initial['phase'], 'degraded')
        source.unlink()
        self.assertEqual(self.reindex(source), {'unchanged': True})
        removed = self.assert_current(added)
        self.assertEqual(removed['staticIndex']['pythonFileCount'], 0)
        self.assertEqual(removed['phase'], 'degraded')
        self.assertEqual(added['staticIndex']['pythonFileCount'], 1)
        self.assertEqual(added['phase'], 'ready')

    def test_model_create_delete_updates_both_commit_branches_and_preserves_latest_runtime_counts(self):
        source = self.root / 'models.py'
        initial = self.server._health()
        # The fresh child can be newer than the parent's original Django registry.
        initial['runtime']['modelCount'] = 12
        source.write_text('from django.db import models\nclass New(models.Model):\n    value = models.IntegerField()\n')
        self.assertIn('surfaceIndexDelta', self.reindex(source))
        added = self.assert_current(initial)
        self.assertEqual(added['staticIndex']['modelCandidateCount'], 1)

        self.assertEqual(added['semanticGraph']['modelCandidateCount'], 1)
        self.assertEqual(added['semanticGraph']['runtimeModelCount'], 12)
        self.assertIs(added['runtime'], initial['runtime'])
        source.unlink()
        self.assertIn('surfaceIndexDelta', self.reindex(source))
        removed = self.assert_current(added)
        self.assertEqual(removed['staticIndex']['modelCandidateCount'], 0)
        self.assertEqual(removed['semanticGraph']['modelCandidateCount'], 0)
        self.assertEqual(removed['semanticGraph']['runtimeModelCount'], 12)
        self.assertEqual(initial['staticIndex']['modelCandidateCount'], 0)
        self.assertEqual(added['staticIndex']['modelCandidateCount'], 1)

    def test_actual_daemon_topology_and_helper_saves_match_fresh_django_diagnostics(self):
        result = subprocess.run([sys.executable, '-m', 'benchmarks.check_runtime_health_refresh',
            '--check-surface', '--output-dir', str(self.root / 'probe-output')],
            capture_output=True, text=True, timeout=35)
        self.assertEqual(result.returncode, 0, result.stderr[-4000:])
        value = json.loads(result.stdout)
        self.assertEqual(value['daemonExitCode'], 0)
        self.assertEqual([row['modelCount'] for row in value['rows']], [15, 16, 14, 14, 14])
        self.assertTrue(all(row['runtimeEqualsFreshOracle'] and row['notificationMatchesHealthRpc']
            and row['wholeSurfaceEqualsFreshOracle'] and row['reachableCatalogueEqualsFreshOracle']
            for row in value['rows']))

    def prewarm(self, update):
        from django_orm_intellisense.runtime import inspector
        runtime = dataclasses.replace(self.server.runtime_inspection, settings_module='fixture_settings')
        self.server.runtime_inspection = runtime
        initial = self.server.health_snapshot
        with mock.patch.object(app.threading, 'Thread') as thread, \
                mock.patch.object(inspector, '_ensure_runtime_field_registry',
                    side_effect=lambda settings, **kwargs: update(settings)), \
                mock.patch.object(inspector, 'runtime_field_registry_is_ready', return_value=True), \
                mock.patch.object(self.server, '_write_notification') as publish:
            self.server._start_runtime_field_registry_prewarm(runtime, initial)
            thread.call_args.kwargs['target']()
        return initial, publish

    def test_delayed_initial_registry_notification_uses_latest_health_after_a_save(self):
        latest = {**self.server.health_snapshot, 'detail': 'Current source diagnostics'}
        initial, publish = self.prewarm(lambda _: setattr(self.server, 'health_snapshot', latest))
        publish.assert_called_once_with('healthChanged', {'health': latest})
        self.assertIsNot(initial, latest)

    def test_initial_registry_notification_is_rejected_after_generation_or_environment_changes(self):
        for changed in ('generation', 'settings', 'python', 'stop'):
            with self.subTest(changed=changed):
                self.server._stopping.clear()
                def update(_):
                    if changed == 'generation':
                        self.server._state_generation += 1
                    elif changed == 'stop':
                        self.server._stopping.set()
                    else:
                        field = 'settings_module' if changed == 'settings' else 'python_executable'
                        self.server.runtime_inspection = dataclasses.replace(self.server.runtime_inspection,
                            **{field: 'new-environment'})
                _, publish = self.prewarm(update)
                publish.assert_not_called()


class RegistryPrewarmLifecycleTests(unittest.TestCase):
    def setUp(self):
        self.stack = contextlib.ExitStack()
        self.addCleanup(self.stack.close)
        folder = self.stack.enter_context(tempfile.TemporaryDirectory(prefix='djls-registry-prewarm-'))
        self.root = Path(folder).resolve()
        output = sys.stdout
        try:
            self.server = app.DaemonServer(self.root)
        finally:
            sys.stdout = output
        self.runtime = dataclasses.replace(create_pending_runtime_inspection('fixture_settings'),
            bootstrap_status='ready',django_version='test')
        self.server.runtime_inspection = self.runtime
        self.server.health_snapshot = {'revision':0}
        self.threads, self.notifications = [], []
        self.published = threading.Event()
        self.release = threading.Event()
        self.lock_attempted = threading.Event()
        self.lock = threading.Lock()
        owner = self
        class ObservedLock:
            def acquire(self, *args, **kwargs):
                owner.lock_attempted.set()
                return owner.lock.acquire(*args, **kwargs)
            def release(self):
                owner.lock.release()
            def __enter__(self):
                self.acquire()
                return self
            def __exit__(self, *args):
                self.release()
        self.stack.enter_context(mock.patch.multiple(inspector,
            _RUNTIME_FIELD_REGISTRY_LOCK=ObservedLock(),_RUNTIME_FIELD_REGISTRY_READY=False,
            _RUNTIME_FIELD_REGISTRY_SETTINGS_MODULE=None,_RUNTIME_FIELD_REGISTRY={},
            _RUNTIME_LOOKUP_FIELD_ALIASES={},_RUNTIME_FIELD_REGISTRY_LOCK_TIMEOUT_S=0.02))
        self.stack.enter_context(mock.patch.object(inspector,'_ensure_runtime_field_registry_locked',
            side_effect=lambda settings: inspector._set_runtime_field_registry(settings,{})))
        real_thread = threading.Thread
        self.real_thread = real_thread
        def thread(*args, **kwargs):
            worker = real_thread(*args, **kwargs)
            self.threads.append(worker)
            return worker
        self.stack.enter_context(mock.patch.object(app.threading,'Thread',side_effect=thread))
        self.stack.enter_context(mock.patch.object(self.server,'_write_notification',side_effect=self.publish))
        self.log = io.StringIO()
        self.stack.enter_context(contextlib.redirect_stderr(self.log))
        self.addCleanup(self.finish)

    def publish(self, event, params):
        self.notifications.append((event,params,inspector.runtime_field_registry_is_ready('fixture_settings')))
        self.published.set()

    def finish(self):
        self.server._stopping.set()
        self.release.set()
        if self.lock.locked():
            self.lock.release()
        for worker in self.threads:
            worker.join(2)

    def start(self, runtime=None, roots=None):
        self.server._start_runtime_field_registry_prewarm(runtime or self.runtime,
            source_roots=roots,expected_generation=self.server._state_generation)

    def join(self):
        for worker in self.threads:
            worker.join(2)
            self.assertFalse(worker.is_alive())

    def test_held_registry_does_not_publish_timeout_as_ready_and_later_uses_current_health(self):
        self.lock.acquire()
        self.start()
        self.assertTrue(self.lock_attempted.wait(2))
        self.assertFalse(self.published.wait(0.08),self.notifications)
        self.assertNotIn('runtime_field_registry(background) ready',self.log.getvalue())
        latest = {'revision':1}
        self.server.health_snapshot = latest
        inspector._set_runtime_field_registry('fixture_settings',{})
        self.lock.release()
        self.assertTrue(self.published.wait(2))
        self.join()
        self.assertEqual(self.notifications,[('healthChanged',{'health':latest},True)])
        self.assertIsNone(getattr(self.server,'_registry_prewarm_request',None))
        self.assertIsNone(getattr(self.server,'_registry_prewarm_thread',None))

    def blocking(self, settings, *, cancelled=None):
        self.lock_attempted.set()
        while not self.release.wait(0.005):
            if cancelled is not None and cancelled():
                return
        inspector._set_runtime_field_registry(settings,{})

    def test_duplicate_requests_use_one_worker_and_one_current_notification(self):
        with mock.patch.object(inspector,'_ensure_runtime_field_registry',side_effect=self.blocking):
            self.start()
            self.assertTrue(self.lock_attempted.wait(2))
            for _ in range(8):
                self.start()
            self.assertEqual(len(self.threads),1)
            self.server.health_snapshot = {'revision':8}
            self.release.set()
            self.join()
        self.assertEqual(self.notifications,[('healthChanged',{'health':{'revision':8}},True)])

    def test_replaced_generation_and_stop_cancel_waiting_source_contexts(self):
        for change in ('generation','stop'):
            with self.subTest(change=change):
                self.server._stopping.clear()
                self.lock_attempted.clear()
                self.log.seek(0)
                self.log.truncate()
                self.threads.clear()
                self.notifications.clear()
                self.lock.acquire()
                try:
                    self.start()
                    self.assertTrue(self.lock_attempted.wait(2))
                    if change == 'generation':
                        self.server._state_generation += 1
                    else:
                        self.server._stopping.set()
                    self.join()
                    self.assertNotIn('runtime_field_registry(background) ready',self.log.getvalue())
                    self.assertEqual(self.notifications,[])
                    self.assertNotIn(str(self.root),source_imports._finder.roots)
                    self.assertIsNone(getattr(self.server,'_registry_prewarm_request',None))
                finally:
                    if self.lock.locked():
                        self.lock.release()

    def test_failed_or_unavailable_setup_does_not_publish_ready(self):
        for error in (None,RuntimeError('setup failed')):
            with self.subTest(error=error), mock.patch.object(inspector,'_ensure_runtime_field_registry',
                    side_effect=error,return_value=None):
                self.log.seek(0)
                self.log.truncate()
                self.threads.clear()
                self.notifications.clear()
                self.start()
                self.join()
                self.assertEqual(self.notifications,[])
                self.assertNotIn('runtime_field_registry(background) ready',self.log.getvalue())
                self.assertIsNone(getattr(self.server,'_registry_prewarm_request',None))

    def test_ready_publication_rejects_changed_runtime_identity_or_bootstrap_status(self):
        for attribute,value in (('settings_module','other'),('python_executable','other'),
                ('django_version','other'),('bootstrap_status','setup_failed')):
            def ensured(settings, **kwargs):
                inspector._set_runtime_field_registry(settings,{})
                self.server.runtime_inspection = dataclasses.replace(self.runtime,**{attribute:value})
            with self.subTest(attribute=attribute), mock.patch.object(inspector,'_ensure_runtime_field_registry',side_effect=ensured):
                self.log.seek(0)
                self.log.truncate()
                self.threads.clear()
                self.notifications.clear()
                try:
                    self.start()
                    self.join()
                    self.assertEqual(self.notifications,[])
                    self.assertNotIn('runtime_field_registry(background) ready',self.log.getvalue())
                finally:
                    self.server.runtime_inspection = self.runtime

    def test_many_new_generations_keep_only_latest_queued_owner_during_active_build(self):
        def build(settings, **kwargs):
            self.lock_attempted.set()
            self.release.wait(2)
            inspector._set_runtime_field_registry(settings,{})
        with mock.patch.object(inspector,'_ensure_runtime_field_registry',side_effect=build):
            self.start(roots=(self.root/'old',))
            self.assertTrue(self.lock_attempted.wait(2))
            for revision in range(1,13):
                self.server._state_generation += 1
                self.server.health_snapshot = {'revision':revision}
                self.start(roots=(self.root/'latest',))
            self.assertEqual(len(self.threads),1)
            self.release.set()
            self.join()
        self.assertEqual(self.notifications,[('healthChanged',{'health':{'revision':12}},True)])
        self.assertNotIn(str(self.root/'old'),source_imports._finder.roots)
        self.assertNotIn(str(self.root/'latest'),source_imports._finder.roots)

    def test_failed_worker_start_does_not_poison_a_later_request(self):
        with mock.patch.object(app.threading,'Thread') as constructor:
            constructor.return_value.start.side_effect = RuntimeError('cannot start')
            with self.assertRaisesRegex(RuntimeError,'cannot start'):
                self.start()
        self.assertIsNone(getattr(self.server,'_registry_prewarm_request',None))
        self.assertIsNone(getattr(self.server,'_registry_prewarm_thread',None))
        self.start()
        self.join()
        self.assertEqual(len(self.notifications),1)

    def test_request_arriving_during_failed_worker_start_is_not_lost(self):
        entered, release, second_done = threading.Event(),threading.Event(),threading.Event()
        attempts, errors = [],[]
        def constructor(*args, **kwargs):
            attempts.append(True)
            if len(attempts) == 1:
                worker = mock.Mock()
                def failed_start():
                    entered.set()
                    release.wait(2)
                    raise RuntimeError('cannot start')
                worker.start.side_effect = failed_start
                return worker
            worker = self.real_thread(*args,**kwargs)
            self.threads.append(worker)
            return worker
        def first():
            try:
                self.start()
            except RuntimeError as error:
                errors.append(str(error))
        def second():
            self.server.health_snapshot = {'revision':2}
            self.start()
            second_done.set()
        with mock.patch.object(app.threading,'Thread',side_effect=constructor):
            first_actor = self.real_thread(target=first)
            second_actor = self.real_thread(target=second)
            try:
                first_actor.start()
                self.assertTrue(entered.wait(2))
                second_actor.start()
                second_done.wait(0.05)
            finally:
                release.set()
                first_actor.join(2)
                if second_actor.ident is not None:
                    second_actor.join(2)
            self.assertFalse(first_actor.is_alive())
            self.assertFalse(second_actor.is_alive())
            self.join()
        self.assertEqual(errors,['cannot start'])
        self.assertEqual(self.notifications,[('healthChanged',{'health':{'revision':2}},True)])

    def test_foreground_registry_timeout_still_returns_fallback_without_building(self):
        self.lock.acquire()
        with mock.patch.object(inspector,'_ensure_runtime_field_registry_locked') as build:
            inspector._ensure_runtime_field_registry('fixture_settings')
        build.assert_not_called()
        self.assertIn('[runtime:registry-lock-timeout]',self.log.getvalue())
        self.assertFalse(inspector.runtime_field_registry_is_ready('fixture_settings'))
        self.lock.release()

    def test_explicit_skip_and_subprocess_modes_keep_background_cancellation_and_marker(self):
        for mode in ('skip','subprocess'):
            with self.subTest(mode=mode), mock.patch.dict('os.environ',{'DJLS_RUNTIME_REGISTRY_MODE':mode}), \
                    mock.patch.object(inspector,'_spawn_registry_build_subprocess') as spawn:
                inspector._clear_runtime_field_registry()
                self.start()
                self.join()
                self.assertTrue(inspector.runtime_field_registry_is_ready('fixture_settings'))
                self.assertEqual(spawn.call_count,int(mode == 'subprocess'))
        self.assertEqual(len(self.notifications),2)
