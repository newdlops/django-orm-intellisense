import contextlib
import os
import dataclasses
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from django_orm_intellisense.features import orm_members
from django_orm_intellisense.features.orm_members import _workspace_files, runtime_workspace_paths_are_current
from django_orm_intellisense.static_index.indexer import build_static_index, reindex_single_file
from django_orm_intellisense.runtime.inspector import create_pending_runtime_inspection
from django_orm_intellisense.semantic.graph import build_model_graph
from django_orm_intellisense.server.app import DaemonServer
from django_orm_intellisense.cache import store
from django_orm_intellisense.discovery.workspace import snapshot_python_sources
from django_orm_intellisense.server import app as server_app, worker_state
from tests.test_static_fallback_surface_gap import _ready_runtime_with, _runtime_model


class BackgroundPathRepairTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='djls-background-path-repair-')
        self.addCleanup(temporary.cleanup)
        self.base = Path(temporary.name).resolve()
        self.case_number = 0

    def run_case(self, *, cached=False, stage='prepared', churn=False, supersede=None, existing_pool=False,
            owned_records=False, source_change=False):
        self.case_number += 1
        folder = self.base / str(self.case_number)
        root = folder / 'project'
        root.mkdir(parents=True)
        first, second = folder / 'first.txt', folder / 'second.txt'
        first.write_text('from django.db import models\nclass Post(models.Model):\n'
            '    key = models.UUIDField(primary_key=True)\n    value = models.CharField()\n')
        os.link(first, second)
        source = root / 'models.py'
        source.symlink_to(first)
        namespace = {}
        exec(compile('def visible(self):\n    return self\ndef label(self):\n    return "label"\n',
            str(source), 'exec'), namespace)
        model = type('Post', (), {'visible':namespace['visible'], 'label':property(namespace['label'])})
        runtime = dataclasses.replace(_ready_runtime_with(_runtime_model('models.Post', 'models',
            [('key','UUIDField'), ('pk','UUIDField'), ('value','CharField')])),settings_module=None)
        index = build_static_index(root)
        graph = build_model_graph(index, runtime)
        snapshot = snapshot_python_sources(root)
        source_membership = server_app.source_membership_fingerprint(snapshot)
        runtime_source_key = server_app._runtime_source_fingerprint(
            source_snapshot=snapshot, static_index=index, settings_module=runtime.settings_module,
            membership_fingerprint=source_membership)
        stdout = sys.stdout
        try:
            server = DaemonServer(root)
        finally:
            sys.stdout = stdout
        server.static_index, server.runtime_inspection, server.model_graph = index, runtime, graph
        server.source_snapshot = snapshot
        prepare = server_app.prebuild_runtime_workspace_paths
        capture = server_app.capture_runtime_member_surface
        fallback = server._build_static_fallback
        prepared, captured, workers = [], [], []
        stale_snapshot = (orm_members.RuntimeMemberSnapshot(orm_members._runtime_member_identity(runtime),
            {},{},frozenset()) if stage == 'prepared' else None)
        pool = mock.Mock(name='old_owner_pool') if existing_pool else None
        if pool is not None:
            server._bg_pool = pool
            server._bg_pool_state_key = (id(index), id(runtime), id(graph))

        def switch():
            replacement = root / '.alias-switch.tmp'
            replacement.symlink_to(second if source.resolve() == first else first)
            replacement.replace(source)

        def preparation(owner, inspection):
            prepare(owner, inspection)
            prepared.append(owner)
            if stage == 'prepared' and (len(prepared) == 1 or churn):
                switch()
            if supersede and len(prepared) == 2:
                if supersede == 'generation':
                    server._state_generation += 1
                elif supersede == 'serial':
                    server._reindex_serial += 1
                elif supersede == 'stop':
                    server._stopping.set()
                else:
                    attribute = {'static':'static_index','runtime':'runtime_inspection','graph':'model_graph'}[supersede]
                    setattr(server, attribute, object())

        def capturing(owner, inspection, model_graph):
            result = capture(owner, inspection, model_graph)
            captured.append((owner, result))
            if stage == 'capture' and len(captured) == 1:
                switch()
            return result

        fallback_calls = []
        def derive_fallback(**kwargs):
            result = fallback(**kwargs)
            fallback_calls.append(1)
            if stage == 'fallback' and len(fallback_calls) == 1:
                switch()
            if source_change and len(fallback_calls) == 2:
                stamp = first.stat()
                first.write_text(first.read_text().replace('CharField','DateField'))
                os.utime(first,ns=(stamp.st_atime_ns,stamp.st_mtime_ns))
            return result

        class Pool:
            def __init__(self, **kwargs):
                self.state = worker_state.load_surface_worker_state(kwargs['initargs'][0])
            def __enter__(self):
                return self
            def __exit__(self, *args):
                return False
            def submit(self, function, members_path):
                def result():
                    workers.append(self.state[0])
                    return orm_members.prebuild_member_surface_cache(*self.state,
                        runtime_members=worker_state.load_runtime_member_state(members_path))
                return SimpleNamespace(result=result)

        with contextlib.ExitStack() as stack:
            stack.enter_context(mock.patch.dict(os.environ, {'DJANGO_ORM_INTELLISENSE_CACHE_DIR':str(folder/'cache')}))
            stack.enter_context(mock.patch.object(orm_members, '_runtime_model_class', return_value=model))
            members = capture(index,runtime,graph)
            if owned_records:
                key = ('models.Post','instance',None)
                members[key] = (*members[key],dataclasses.replace(members[key][0],name='fresh_only',
                    return_kind='instance',return_model_label='models.Post',signature='() -> Post'))
                stale_snapshot = orm_members.RuntimeMemberSnapshot(orm_members._runtime_member_identity(runtime),
                    members,{'models.Post':('objects','saved')},frozenset({'models.Post'}))
                index._runtime_source_epoch = server_app.RuntimeSourceEpoch.from_snapshot(snapshot)
                index._runtime_member_snapshot = stale_snapshot
            expected = orm_members.prebuild_member_surface_cache(index,runtime,graph,runtime_members=members)
            if pool is not None:
                pool.submit.return_value.result.return_value = expected
            index._runtime_member_snapshot = stale_snapshot
            load = stack.enter_context(mock.patch.object(server_app, 'load_cached_surface_index', return_value=expected if cached else None))
            save = stack.enter_context(mock.patch.object(server_app, 'save_surface_index', wraps=store.save_surface_index))
            publish = stack.enter_context(mock.patch.object(server, '_publish_current_surface_snapshot'))
            stack.enter_context(mock.patch.object(server_app, 'prebuild_runtime_workspace_paths', side_effect=preparation))
            stack.enter_context(mock.patch.object(server_app, 'capture_runtime_member_surface', side_effect=capturing))
            stack.enter_context(mock.patch.object(server, '_build_static_fallback', side_effect=derive_fallback))
            stack.enter_context(mock.patch.object(server_app, 'ProcessPoolExecutor', Pool))
            server._start_surface_index_prebuild(generation=server._state_generation,workspace_root=root,
                source_snapshot=snapshot,static_index=index,runtime=runtime,model_graph=graph,reason='test',
                runtime_source_fingerprint=runtime_source_key, source_membership=source_membership)
            thread = server._surface_prebuild_future
            if thread is not None:
                thread.join(5)
                self.assertFalse(thread.is_alive())
            self.assertIsNone(server._surface_prebuild_future)
            if source_change:
                self.assertNotEqual(snapshot_python_sources(root).fingerprint,snapshot.fingerprint)
            else:
                self.assertEqual(snapshot_python_sources(root).fingerprint,snapshot.fingerprint)
            self.assertEqual(index._workspace_source_paths_by_module['models'],str(first))
            self.assertIs(index._runtime_member_snapshot,stale_snapshot)
            if not churn and not supersede and not source_change:
                self.assertIsNot(server.static_index,index)
                self.assertEqual(server.static_index._workspace_source_paths_by_module['models'],str(second))
                if stale_snapshot is None:
                    self.assertIsNone(server.static_index._runtime_member_snapshot)
                else:
                    self.assertIsNotNone(server.static_index._runtime_member_snapshot)
                    self.assertEqual(server.static_index._runtime_member_snapshot.manager_names,stale_snapshot.manager_names)
                self.assertEqual(server._last_surface_index,expected)
                self.assertEqual(server._last_surface_index['models.Post']['instance']['pk'][3],'UUIDField')
                publish.assert_called_once()
                for member in (('visible','label','fresh_only') if owned_records else ('visible','label')):
                    item = orm_members.resolve_orm_member(static_index=server.static_index,runtime=runtime,
                        model_graph=graph,model_label='models.Post',receiver_kind='instance',name=member)
                    self.assertTrue(item['resolved'])
                    self.assertEqual(item['item']['filePath'],str(second))
                # Repair can publish useful ephemeral metadata, but its
                # canonical membership differs from the captured cache owner.
                # It must not save that new state under the old source key.
                save.assert_not_called()
            else:
                publish.assert_not_called()
                save.assert_not_called()
                self.assertIsNone(server._last_surface_index)
                self.assertIsNone(server._surface_load_attempted_generation)
            load.assert_called_once()
        return SimpleNamespace(server=server,index=index,prepared=prepared,captured=captured,workers=workers,pool=pool)

    def test_cached_and_cold_preparation_alias_changes_adopt_a_fresh_owner_without_mutating_the_old_one(self):
        for cached in (True,False):
            with self.subTest(cached=cached):
                result = self.run_case(cached=cached)
                self.assertEqual(len(result.prepared),2)
                self.assertEqual(len(result.captured),0 if cached else 1)

    def test_alias_switch_during_capture_retries_before_saving_or_publishing(self):
        result = self.run_case(stage='capture')
        self.assertEqual(len(result.captured),2)
        self.assertEqual(len(result.workers),2)

    def test_alias_switch_during_fallback_derivation_retries_before_saving_or_publishing(self):
        result = self.run_case(stage='fallback')
        self.assertEqual(len(result.captured),2)
        self.assertEqual(len(result.workers),2)

    def test_persistent_alias_churn_stops_after_three_attempts_without_adoption(self):
        for cached in (True,False):
            with self.subTest(cached=cached):
                result = self.run_case(cached=cached,churn=True)
                self.assertEqual(len(result.prepared),3)
                self.assertIs(result.server.static_index,result.index)

    def test_superseded_repair_cannot_replace_a_new_generation_serial_owner_or_stop(self):
        for changed in ('generation','serial','static','runtime','graph','stop'):
            with self.subTest(changed=changed):
                result = self.run_case(cached=True,supersede=changed)
                self.assertEqual(len(result.prepared),2)

    def test_repaired_owner_uses_a_fresh_worker_and_retires_the_old_persistent_pool(self):
        result = self.run_case(existing_pool=True)
        result.pool.submit.assert_not_called()
        result.pool.shutdown.assert_called_once_with(wait=False)
        self.assertIsNone(result.server._bg_pool)

    def test_alias_repair_preserves_latest_owned_runtime_records_absent_from_the_parent_registry(self):
        result = self.run_case(owned_records=True)
        snapshot = result.server.static_index._runtime_member_snapshot
        self.assertEqual(snapshot.manager_names['models.Post'],('objects','saved'))
        item = next(item for item in snapshot.items[('models.Post','instance',None)] if item.name == 'fresh_only')
        self.assertEqual(item.signature,'() -> Post')
        self.assertEqual(item.return_kind,'instance')

    def test_source_change_after_rebasing_owned_records_is_rejected_before_persistence(self):
        result = self.run_case(stage='fallback',owned_records=True,source_change=True)
        self.assertEqual(len(result.prepared),3)
        self.assertEqual(len(result.captured),2)
        self.assertIs(result.server.static_index,result.index)


class WorkspacePathResolutionTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='djls-workspace-paths-')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()

    def index(self, paths):
        return SimpleNamespace(modules={name: SimpleNamespace(file_path=str(path)) for name, path in paths.items()},
            _workspace_source_paths=None, _workspace_source_paths_by_module=None,
            _workspace_source_path_counts=None)

    def write(self, path):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text('value = 1\n')
        return path

    @unittest.skipUnless(os.name == 'posix', 'POSIX string realpath optimization')
    def test_existing_cold_membership_avoids_pathlib_object_resolution(self):
        paths = {f'module{number}': self.write(self.root / 'sources' / f'module{number}.py')
                 for number in range(100)}
        expected = frozenset(str(path.resolve()) for path in paths.values())
        expected_by_module = {name: str(path.resolve()) for name, path in paths.items()}
        index = self.index(paths)
        with mock.patch.object(Path, 'resolve', side_effect=AssertionError('cold membership rebuilt pathlib objects')):
            actual = _workspace_files(index)
        self.assertEqual(actual, expected)
        self.assertEqual(index._workspace_source_paths_by_module, expected_by_module)
        self.assertEqual(index._workspace_source_path_counts, {path: 1 for path in expected})
        with mock.patch('os.path.realpath', side_effect=AssertionError('warm membership recomputed')):
            self.assertIs(_workspace_files(index), actual)

    def test_file_and_directory_aliases_parent_segments_and_missing_sources_match_pathlib(self):
        first = self.write(self.root / 'physical' / 'first.py')
        second = self.write(self.root / 'physical' / 'second.py')
        other = self.write(self.root / 'other' / 'first.py')
        alias = self.root / 'alias.py'
        alias.symlink_to(first)
        directory_alias = self.root / 'linked'
        directory_alias.symlink_to(first.parent, target_is_directory=True)
        paths = {'physical': first, 'file_alias': alias, 'directory_alias': directory_alias / 'first.py',
                 'parent_after_alias': str(directory_alias / '..') + '/other/first.py',
                 'missing': self.root / 'absent' / 'missing.py',
                 'dangling': self.root / 'dangling.py', 'other': other}
        paths['dangling'].symlink_to(self.root / 'absent' / 'target.py')
        old = self.index(paths)
        old_files = _workspace_files(old)
        self.assertEqual(old._workspace_source_paths_by_module,
            {name: str(Path(path).resolve()) for name, path in paths.items()})
        self.assertEqual(old._workspace_source_path_counts[str(first)], 3)
        alias.unlink()
        alias.symlink_to(second)
        directory_alias.unlink()
        directory_alias.symlink_to(other.parent, target_is_directory=True)
        fresh = self.index(paths)
        self.assertEqual(_workspace_files(fresh), frozenset(str(Path(path).resolve()) for path in paths.values()))
        self.assertEqual(fresh._workspace_source_paths_by_module['file_alias'], str(second))
        self.assertEqual(fresh._workspace_source_paths_by_module['directory_alias'], str(other))
        self.assertIs(_workspace_files(old), old_files)
        self.assertEqual(old._workspace_source_paths_by_module['file_alias'], str(first))

    def test_relative_paths_keep_current_directory_and_alias_semantics(self):
        physical = self.write(self.root / 'directory' / 'target.py')
        alias = self.root / 'directory' / 'link.py'
        alias.symlink_to(physical)
        relative = os.path.relpath(alias)
        index = self.index({'relative': relative})
        self.assertEqual(_workspace_files(index), frozenset({str(Path(relative).resolve())}))

    def test_publication_guard_resolves_regular_parent_once_without_leaf_checks(self):
        paths = {f'module{number}': self.write(self.root / 'sources' / f'module{number}.py')
                 for number in range(100)}
        index = self.index(paths)
        self.assertTrue(runtime_workspace_paths_are_current(index))
        _workspace_files(index)
        with mock.patch.object(orm_members, '_canonical_workspace_source_path',
                wraps=orm_members._canonical_workspace_source_path) as resolve:
            self.assertTrue(runtime_workspace_paths_are_current(index))
        self.assertEqual(resolve.call_args_list, [mock.call(str(self.root / 'sources'))])
        index.modules['new'] = SimpleNamespace(file_path=str(self.root / 'new.py'))
        self.assertFalse(runtime_workspace_paths_are_current(index))

    def test_publication_guard_detects_same_inode_file_and_new_parent_aliases(self):
        first = self.write(self.root / 'physical' / 'first.py')
        second = self.root / 'second.py'
        os.link(first, second)
        other = self.root / 'other'
        other.mkdir()
        os.link(first, other / 'first.py')
        alias = self.root / 'alias.py'
        alias.symlink_to(first)
        file_index = self.index({'alias': alias})
        original_files = _workspace_files(file_index)
        self.assertTrue(runtime_workspace_paths_are_current(file_index))
        alias.unlink()
        alias.symlink_to(second)
        self.assertFalse(runtime_workspace_paths_are_current(file_index))
        current = self.index({'alias': alias})
        _workspace_files(current)
        self.assertTrue(runtime_workspace_paths_are_current(current))
        self.assertIs(_workspace_files(file_index), original_files)
        parent_index = self.index({'source': first})
        _workspace_files(parent_index)
        first.parent.rename(self.root / 'retired')
        first.parent.symlink_to(other, target_is_directory=True)
        self.assertFalse(runtime_workspace_paths_are_current(parent_index))
        current = self.index({'source': first})
        _workspace_files(current)
        self.assertTrue(runtime_workspace_paths_are_current(current))

    def test_symlink_loop_keeps_pathlib_runtime_error_and_leaves_cache_empty(self):
        first, second = self.root / 'first.py', self.root / 'second.py'
        first.symlink_to(second)
        second.symlink_to(first)
        index = self.index({'loop': first})
        with self.assertRaises(RuntimeError):
            _workspace_files(index)
        self.assertIsNone(index._workspace_source_paths)
        self.assertIsNone(index._workspace_source_paths_by_module)
        self.assertIsNone(index._workspace_source_path_counts)

    def test_stat_failure_uses_existing_pathlib_non_strict_contract(self):
        source = self.write(self.root / 'source.py')
        expected = str(source.resolve())
        original_resolve = Path.resolve
        resolved = []
        def fallback(path, *args, **kwargs):
            resolved.append(str(path))
            return original_resolve(path, *args, **kwargs)
        with mock.patch('os.stat', side_effect=PermissionError('benchmark stat denial')):
            with mock.patch.object(Path, 'resolve', fallback):
                self.assertEqual(_workspace_files(self.index({'source': source})), frozenset({expected}))
        self.assertEqual(resolved[-1], str(source))

    def test_background_full_surface_warms_foreground_index_on_cache_hit_and_miss(self):
        source = self.root / 'models.py'
        source.write_text('from django.db import models\nclass Post(models.Model):\n    value = models.CharField()\n')
        for cached in [True, False]:
            with self.subTest(cached=cached):
                source.write_text('from django.db import models\nclass Post(models.Model):\n    value = models.CharField()\n')
                index = build_static_index(self.root)
                runtime = dataclasses.replace(create_pending_runtime_inspection(None), bootstrap_status='ready')
                graph = build_model_graph(index, runtime)
                snapshot = snapshot_python_sources(self.root)
                membership = server_app.source_membership_fingerprint(snapshot)
                source_key = server_app._runtime_source_fingerprint(source_snapshot=snapshot,
                    static_index=index, settings_module=runtime.settings_module, membership_fingerprint=membership)
                stdout = sys.stdout
                try:
                    server = DaemonServer(self.root)
                finally:
                    sys.stdout = stdout
                server.static_index, server.runtime_inspection, server.model_graph = index, runtime, graph
                published = threading.Event()
                observations = []
                def publish(generation):
                    observations.append((threading.get_ident(), index._workspace_source_paths,
                        dict(index._workspace_source_paths_by_module or {})))
                    published.set()
                surface = {'models.Post': {'instance': {'value': ['scalar', None, 'field', 'CharField']}}}
                expected = str(source.resolve())
                with mock.patch('django_orm_intellisense.server.app.load_cached_surface_index', return_value=surface if cached else None) as load:
                    with mock.patch('django_orm_intellisense.server.app.save_surface_index'):
                        with mock.patch('django_orm_intellisense.server.app.ProcessPoolExecutor') as pool:
                            pool.return_value.__enter__.return_value.submit.return_value.result.return_value = surface
                            with mock.patch.object(server, '_publish_current_surface_snapshot', publish):
                                server._start_surface_index_prebuild(generation=server._state_generation,
                                    workspace_root=self.root, source_snapshot=snapshot,
                                    static_index=index, runtime=runtime, model_graph=graph, reason='test',
                                    runtime_source_fingerprint=source_key, source_membership=membership)
                                thread = server._surface_prebuild_future
                                self.assertTrue(published.wait(2), 'Full surface publication did not finish')
                                if thread is not None:
                                    thread.join(2)
                                    self.assertFalse(thread.is_alive())
                load.assert_called_once()
                self.assertEqual(load.call_args.kwargs['source_fingerprint'], snapshot.fingerprint)
                if cached:
                    pool.assert_not_called()
                else:
                    pool.assert_called_once()
                self.assertEqual(len(observations), 1)
                self.assertNotEqual(observations[0][0], threading.get_ident())
                self.assertEqual(observations[0][1], frozenset({expected}))
                self.assertEqual(observations[0][2], {'models': expected})
                self.assertIsNotNone(index._import_dependency_cache.dependents,
                    'Published ready surface left foreground import adjacency cold')
                self.assertIsNotNone(index._constructor_dependency_cache,
                    'Published ready surface left foreground constructor adjacency cold')
                warmed_imports = index._import_dependency_cache.dependents
                warmed_constructors = index._constructor_dependency_cache
                source.write_text(source.read_text().replace('CharField', 'TextField'))
                changed, _, _ = reindex_single_file(self.root, source, index)
                with mock.patch('os.path.realpath', side_effect=AssertionError('First save rebuilt whole membership')):
                    self.assertIs(_workspace_files(changed), index._workspace_source_paths)
                self.assertEqual(server._last_surface_index, surface)
                self.assertIs(changed._import_dependency_cache.dependents, warmed_imports)
                self.assertIs(changed._constructor_dependency_cache, warmed_constructors)

    def test_pending_or_opted_out_surface_does_not_warm_membership(self):
        from django_orm_intellisense.features.orm_members import prebuild_runtime_workspace_paths
        source = self.root / 'models.py'
        source.write_text('from django.db import models\nclass Post(models.Model):\n    value = models.CharField()\n')
        index = build_static_index(self.root)
        pending = create_pending_runtime_inspection(None)
        with mock.patch('os.path.realpath', side_effect=AssertionError('Pending runtime resolved all paths')):
            prebuild_runtime_workspace_paths(index, pending)
        self.assertIsNone(index._workspace_source_paths)
        self.assertIsNone(index._import_dependency_cache.dependents)
        self.assertIsNone(index._constructor_dependency_cache)
        runtime = dataclasses.replace(pending, bootstrap_status='ready')
        stdout = sys.stdout
        try:
            server = DaemonServer(self.root)
        finally:
            sys.stdout = stdout
        with mock.patch.dict(os.environ, {'DJLS_SURFACE_PREBUILD_ON_MISS': '0'}):
            with mock.patch('django_orm_intellisense.server.app.load_cached_surface_index', return_value=None):
                with mock.patch('django_orm_intellisense.server.app.prebuild_runtime_workspace_paths',
                                side_effect=AssertionError('Opted-out surface warmed paths')):
                    server._start_surface_index_prebuild(generation=server._state_generation,
                        workspace_root=self.root, source_snapshot=SimpleNamespace(fingerprint='source'),
                        static_index=index, runtime=runtime, model_graph=build_model_graph(index, runtime), reason='test')
                    thread = server._surface_prebuild_future
                    if thread is not None:
                        thread.join(2)
                        self.assertFalse(thread.is_alive())
        self.assertIsNone(index._workspace_source_paths)
        self.assertEqual(server._surface_load_attempted_generation, server._state_generation)
        self.assertIsNone(index._import_dependency_cache.dependents)
        self.assertIsNone(index._constructor_dependency_cache)

    def test_delayed_old_owner_warm_does_not_populate_new_index_or_publish(self):
        from django_orm_intellisense.features.orm_members import prebuild_runtime_workspace_paths
        for superseded in [False, True]:
            with self.subTest(superseded=superseded):
                source = self.root / 'models.py'
                source.write_text('from django.db import models\nclass Post(models.Model):\n    value = models.CharField()\n')
                old = build_static_index(self.root)
                snapshot = snapshot_python_sources(self.root)
                membership = server_app.source_membership_fingerprint(snapshot)
                runtime = dataclasses.replace(create_pending_runtime_inspection(None), bootstrap_status='ready')
                source_key = server_app._runtime_source_fingerprint(source_snapshot=snapshot,
                    static_index=old, settings_module=runtime.settings_module, membership_fingerprint=membership)
                if superseded:
                    source.write_text(source.read_text().replace('CharField', 'TextField'))
                new = build_static_index(self.root)
                old_graph, new_graph = build_model_graph(old, runtime), build_model_graph(new, runtime)
                stdout = sys.stdout
                try:
                    server = DaemonServer(self.root)
                finally:
                    sys.stdout = stdout
                server.static_index, server.runtime_inspection, server.model_graph = old, runtime, old_graph
                entered, release = threading.Event(), threading.Event()
                def delayed(index, captured_runtime):
                    self.assertIs(index, old)
                    entered.set()
                    self.assertTrue(release.wait(2), 'Old owner warm was not released')
                    prebuild_runtime_workspace_paths(index, captured_runtime)
                surface = {'models.Post': {'instance': {'value': ['scalar', None, 'field', 'CharField']}}}
                with mock.patch('django_orm_intellisense.server.app.load_cached_surface_index', return_value=surface) as load:
                    with mock.patch('django_orm_intellisense.server.app.prebuild_runtime_workspace_paths', delayed):
                        with mock.patch.object(server, '_publish_current_surface_snapshot') as publish:
                            server._start_surface_index_prebuild(generation=server._state_generation,
                                workspace_root=self.root, source_snapshot=snapshot,
                                static_index=old, runtime=runtime, model_graph=old_graph, reason='test',
                                runtime_source_fingerprint=source_key, source_membership=membership)
                            thread = server._surface_prebuild_future
                            try:
                                self.assertTrue(entered.wait(2), 'Old owner warm did not start')
                                if superseded:
                                    with server._state_lock:
                                        server._state_generation += 1
                                        server.static_index, server.model_graph = new, new_graph
                            finally:
                                release.set()
                                if thread is not None:
                                    thread.join(2)
                                    self.assertFalse(thread.is_alive())
                            if not superseded:
                                load.assert_called_once()
                            if load.called:
                                self.assertEqual(load.call_args.kwargs['source_fingerprint'], snapshot.fingerprint)
                                self.assertIs(load.call_args.kwargs['static_index'], old)
                                self.assertIs(load.call_args.kwargs['model_graph'], old_graph)
                            if superseded:
                                publish.assert_not_called()
                            else:
                                publish.assert_called_once()
                self.assertIsNotNone(old._workspace_source_paths)
                self.assertIsNotNone(old._import_dependency_cache.dependents)
                self.assertIsNotNone(old._constructor_dependency_cache)
                self.assertIsNone(new._workspace_source_paths)
                self.assertIsNone(new._import_dependency_cache.dependents)
                self.assertIsNone(new._constructor_dependency_cache)
                if superseded:
                    self.assertIs(server.static_index, new)
                    self.assertIsNone(server._last_surface_index)
                else:
                    self.assertIs(server.static_index, old)
                    self.assertEqual(server._last_surface_index, surface)
                    self.assertTrue(server._surface_source_complete)


if __name__ == '__main__':
    unittest.main()
