from __future__ import annotations

import json
import contextlib
import threading
import time
import hashlib
import os
import subprocess
import sys
import io
import tempfile
import unittest
from unittest import mock
from pathlib import Path

from django_orm_intellisense.discovery.workspace import PythonSourceSnapshot, resolve_venv_info, snapshot_python_sources
from django_orm_intellisense.static_index.indexer import build_static_index
from django_orm_intellisense.cache import save_static_index, load_cached_static_index


def _stop_owned_discovery_test_server(server):
    server._stopping.set()
    deadline = time.monotonic() + 2.5
    with server._state_lock:
        server._state_generation += 1
        retry = server._surface_publish_retry_timer
        server._surface_publish_retry_timer = None
        server._surface_publish_retry_generation = None
        fresh_retry = server._fresh_runtime_retry
        threads = [server._surface_prebuild_future,
                   server._runtime_member_refresh_thread,
                   server._runtime_member_refresh_timer, retry,
                   None if fresh_retry is None else fresh_retry[1]]
    with server._surface_load_lock:
        threads.append(server._surface_load_idle_timer)
    server._cancel_surface_index_idle_load()
    server._cancel_runtime_member_refresh()
    if retry is not None:
        retry.cancel()
    for thread in dict.fromkeys(threads):
        if thread is not None and thread is not threading.current_thread():
            thread.join(timeout=max(0.0, deadline - time.monotonic()))
            if thread.is_alive():
                raise AssertionError('Owned discovery-test background work did not stop')


class DiscoveryPerformanceTests(unittest.TestCase):
    def test_snapshot_directory_edges_are_built_once_and_path_order_is_preserved(self):
        from django_orm_intellisense.discovery import workspace
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            for directory in ['a', 'a/nested', 'b', 'b/한글']:
                folder = root / directory
                folder.mkdir(parents=True, exist_ok=True)
                for number in range(20):
                    (folder / f'value_{number}.py').write_text('value = 1\n')
            (root / 'a.py').write_text('value = 2\n')
            expected = sorted(root.rglob('*.py'))
            with mock.patch.object(workspace, '_parent_directory', wraps=workspace._parent_directory) as parent:
                snapshot = snapshot_python_sources(root, max_workers=1)
            self.assertEqual(list(snapshot.files), expected)
            self.assertEqual(parent.call_count, len(snapshot.directory_fingerprints) - 1)
            self.assertEqual(snapshot_python_sources(root), snapshot)

    def test_snapshot_cache_rejects_old_fingerprints_and_roundtrips_current_identity(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            (root / 'models.py').write_text('value = 1\n')
            snapshot = snapshot_python_sources(root, max_workers=1)
            payload = snapshot.to_cache_dict()
            self.assertEqual(PythonSourceSnapshot.from_cache_dict(payload), snapshot)
            payload.pop('fingerprintVersion')
            with self.assertRaisesRegex(ValueError, 'obsolete file fingerprint'):
                PythonSourceSnapshot.from_cache_dict(payload)

    def test_static_cache_reparses_same_size_field_edit_with_restored_mtime(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            source = root / 'models.py'
            original = 'from django.db import models\nclass Record(models.Model):\n    value = models.CharField()\n'
            source.write_text(original)
            (root / 'unchanged.py').write_text('unchanged = True\n')
            stamp = source.stat()
            before = snapshot_python_sources(root, max_workers=1)
            index = build_static_index(root, before.files)
            with mock.patch.dict(os.environ, {'DJANGO_ORM_INTELLISENSE_CACHE_DIR': str(root / 'cache')}):
                save_static_index(root, before, index)
                source.write_text(original.replace('CharField', 'DateField'))
                os.utime(source, ns=(stamp.st_atime_ns, stamp.st_mtime_ns))
                after = snapshot_python_sources(root, max_workers=1)
                restored, hit = load_cached_static_index(root, after)
            self.assertEqual(hit, 'partial')
            field = next(field for module in restored.modules.values()
                for field in module.pending_fields if field.name == 'value')
            self.assertEqual(field.field_kind, 'DateField')

    def test_snapshot_detects_same_size_edits_with_restored_mtime(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            source = root / 'models.py'
            source.write_text('value = 1\n')
            stamp = source.stat()
            before = snapshot_python_sources(root, max_workers=1)
            source.write_text('value = 2\n')
            os.utime(source, ns=(stamp.st_atime_ns, stamp.st_mtime_ns))
            self.assertEqual(source.stat().st_size, stamp.st_size)
            self.assertEqual(source.stat().st_mtime_ns, stamp.st_mtime_ns)
            self.assertNotEqual(snapshot_python_sources(root, max_workers=1).fingerprint, before.fingerprint)

    def test_snapshot_detects_atomic_replacement_with_preserved_size_and_mtime(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            source = root / 'models.py'
            source.write_text('value = 1\n')
            stamp = source.stat()
            before = snapshot_python_sources(root, max_workers=1)
            replacement = root / 'replacement.tmp'
            replacement.write_text('value = 2\n')
            os.utime(replacement, ns=(stamp.st_atime_ns, stamp.st_mtime_ns))
            replacement.replace(source)
            self.assertEqual(source.stat().st_size, stamp.st_size)
            self.assertEqual(source.stat().st_mtime_ns, stamp.st_mtime_ns)
            self.assertNotEqual(snapshot_python_sources(root, max_workers=1).fingerprint, before.fingerprint)

    def test_deleted_source_listing_preserves_file_fast_path_and_folder_coverage(self):
        from django_orm_intellisense.server import app as server_app
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            package = root / 'pkg'
            (package / 'collision').mkdir(parents=True)
            contents = {'__init__.py': '', 'models.py': 'from django.db import models\nclass Record(models.Model):\n    value = models.IntegerField()\n',
                'broken.py': 'class Broken(\n', 'collision.py': 'value = 1\n', 'collision/__init__.py': 'value = 2\n'}
            files = []
            for name, content in contents.items():
                file = package / name
                file.write_text(content)
                files.append(file)
            sibling = root / 'pkg-sibling'
            sibling.mkdir()
            (sibling / 'helper.py').write_text('value = 3\n')
            stdout = sys.stdout
            try:
                server = server_app.DaemonServer(root)
            finally:
                sys.stdout = stdout
            server.static_index = build_static_index(root, snapshot_python_sources(root).files)
            self.assertEqual(server._deleted_source_files({'filePath': str(package)}), {'filePaths': []})
            model = package / 'models.py'
            model.unlink()
            class PointLookupOnly(dict):
                def values(self):
                    raise AssertionError('File deletion enumerated all source paths')
            with mock.patch.object(server.static_index, 'modules', PointLookupOnly(server.static_index.modules)):
                self.assertEqual(server._deleted_source_files({'filePath': str(model)}), {'filePaths': [str(model)]})
            for file in files:
                if file != model:
                    file.unlink()
            (package / 'collision').rmdir()
            package.rmdir()
            resolve = Path.resolve
            resolved = []
            def record_resolution(path, *args, **kwargs):
                resolved.append(path)
                return resolve(path, *args, **kwargs)
            with mock.patch.object(server_app, 'snapshot_python_sources', side_effect=AssertionError('Deletion recursively scanned the filesystem')), \
                    mock.patch.object(Path, 'resolve', record_resolution):
                reply = server._deleted_source_files({'filePath': str(package)})
            self.assertEqual(reply, {'filePaths': sorted(str(file) for file in files)})
            self.assertNotIn(sibling / 'helper.py', resolved)
            self.assertEqual(server._deleted_source_files({'filePath': str(root.parent / 'unrelated')}), {'error': 'file outside workspace'})

    def test_deleted_external_package_keeps_module_identity_for_reindex(self):
        from django_orm_intellisense.static_index.indexer import reindex_single_file
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary).resolve()
            root = base / 'workspace'
            root.mkdir()
            source = base / 'library'
            package = source / 'shared' / 'nested'
            package.mkdir(parents=True)
            (package.parent / '__init__.py').write_text('')
            (package / '__init__.py').write_text('')
            path = package / 'models.py'
            path.write_text('from django.db import models\nclass Shared(models.Model):\n    value = models.CharField()\n')
            snapshot = snapshot_python_sources(root, [source])
            index = build_static_index(root, snapshot.files)
            self.assertIn('shared.nested.models', index.modules)
            path.unlink()
            (package / '__init__.py').unlink()
            (package.parent / '__init__.py').unlink()
            package.rmdir()
            package.parent.rmdir()
            changed, old_labels, new_labels = reindex_single_file(root, path, index)
            self.assertEqual(old_labels, {'shared.Shared'})
            self.assertEqual(new_labels, set())
            self.assertNotIn('shared.nested.models', changed.modules)
            self.assertFalse(changed.model_candidates)
            self.assertEqual(changed.python_file_count, 2)
            self.assertIn('shared.nested.models', index.modules)

    def test_deleted_external_module_does_not_replace_an_unrelated_same_name(self):
        from django_orm_intellisense.static_index.indexer import reindex_single_file, _module_name_for_reindex
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary).resolve()
            root = base / 'workspace'
            root.mkdir()
            (root / 'models.py').write_text('from django.db import models\nclass Local(models.Model):\n    title = models.CharField()\n')
            source = base / 'library'
            package = source / 'shared'
            package.mkdir(parents=True)
            (package / '__init__.py').write_text('')
            path = package / 'models.py'
            path.write_text('from django.db import models\nclass Shared(models.Model):\n    value = models.CharField()\n')
            alias = base / 'alias'
            alias.symlink_to(source, target_is_directory=True)
            snapshot = snapshot_python_sources(root, [alias])
            index = build_static_index(root, snapshot.files)
            local = index.modules['models']
            path.unlink()
            (package / '__init__.py').unlink()
            package.rmdir()
            class PointLookupOnly(dict):
                def __iter__(self):
                    raise AssertionError('Module name recovery scanned the whole index')
                def items(self):
                    raise AssertionError('Module name recovery scanned the whole index')
                def values(self):
                    raise AssertionError('Module name recovery scanned the whole index')
            index.modules = PointLookupOnly(index.modules)
            self.assertEqual(_module_name_for_reindex(root, path, index), 'shared.models')
            index.modules = dict.copy(index.modules)
            changed, old_labels, new_labels = reindex_single_file(root, path, index)
            self.assertEqual(old_labels, {'shared.Shared'})
            self.assertFalse(new_labels)
            self.assertIs(changed.modules['models'], local)
            self.assertNotIn('shared.models', changed.modules)

    def test_daemon_editable_file_changes_and_deletion_remain_in_scope(self):
        from django_orm_intellisense.server.app import DaemonServer
        with tempfile.TemporaryDirectory() as temporary, contextlib.ExitStack() as cleanup:
            base = Path(temporary).resolve()
            root = base / 'workspace'
            root.mkdir()
            source = base / 'library'
            shared = source / 'shared'
            shared.mkdir(parents=True)
            (shared / '__init__.py').write_text('')
            path = shared / 'models.py'
            path.write_text('from django.db import models\nclass Shared(models.Model):\n    value = models.CharField()\n')
            metadata = root / '.venv/lib/python3.12/site-packages/shared-1.0.dist-info'
            metadata.mkdir(parents=True)
            (root / '.venv/pyvenv.cfg').write_text('version = 3.12.13\n')
            (metadata / 'direct_url.json').write_text(json.dumps({'url': source.as_uri(), 'dir_info': {'editable': True}}))
            stdout = sys.stdout
            try:
                server = DaemonServer(root)
            finally:
                sys.stdout = stdout
            cleanup.callback(_stop_owned_discovery_test_server, server)
            server._real_stdout = io.StringIO()
            with mock.patch.dict('os.environ', {'DJANGO_ORM_INTELLISENSE_CACHE_DIR': str(base / 'cache')}):
                result = server._initialize({'workspaceRoot': str(root), 'deferRuntime': True})
            self.assertEqual(result['modelNames'], ['Shared'])
            path.write_text(path.read_text().replace('CharField', 'IntegerField'))
            changed = server._reindex_file({'filePath': str(path)})
            self.assertNotIn('error', changed)
            self.assertEqual(server.model_graph.find_field('shared.Shared', 'value').field_kind, 'IntegerField')
            unrelated = base / 'unrelated.py'
            unrelated.write_text('value = 1\n')
            self.assertEqual(server._reindex_file({'filePath': str(unrelated)}), {'error': 'file outside workspace'})
            path.unlink()
            removed = server._reindex_file({'filePath': str(path)})
            self.assertNotIn('error', removed)
            self.assertIsNone(server.model_graph.node_for_model('shared.Shared'))
            path.write_text('from django.db import models\nclass Shared(models.Model):\n    value = models.CharField()\n')
            recreated = server._reindex_file({'filePath': str(path)})
            self.assertNotIn('error', recreated)
            self.assertIsNotNone(server.model_graph.node_for_model('shared.Shared'))
            path.unlink()
            (shared / '__init__.py').unlink()
            shared.rmdir()
            package_removed = server._reindex_file({'filePath': str(path)})
            self.assertNotIn('error', package_removed)
            self.assertIsNone(server.model_graph.node_for_model('shared.Shared'))
            self.assertEqual(server._deleted_source_files({'filePath': str(shared)}),
                {'filePaths': [str(shared / '__init__.py')]})
            source.rmdir()
            self.assertEqual(server._deleted_source_files({'filePath': str(source)}),
                {'filePaths': [str(shared / '__init__.py')]})

    def test_repeated_editable_roots_are_scanned_once_without_losing_sources(self):
        from django_orm_intellisense.discovery import workspace
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / 'workspace'
            external = Path(temporary) / 'editable'
            root.mkdir()
            external.mkdir()
            (root / 'local.py').write_text('value = 1\n')
            path = external / 'models.py'
            path.write_text('value = 2\n')
            expected = snapshot_python_sources(root, [external])
            original_scan = workspace.iter_python_files
            visited = []
            def scan(folder):
                visited.append(folder)
                return original_scan(folder)
            with mock.patch.object(workspace, 'iter_python_files', scan):
                actual = snapshot_python_sources(root, [external] * 70 + [root])
            self.assertEqual(actual, expected)
            self.assertEqual(visited.count(external), 1)
            self.assertEqual(visited.count(root), 1)
            path.write_text('value = 3\n')
            changed = snapshot_python_sources(root, [external] * 70)
            self.assertNotEqual(changed.fingerprint, actual.fingerprint)
            self.assertEqual(changed.file_count, 2)

    def test_relative_egg_links_use_the_metadata_directory_and_remain_fresh(self):
        from django_orm_intellisense.discovery import workspace
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            packages = root / 'site-packages'
            first, second = root / 'first source', root / 'second source'
            for folder in (packages, first, second):
                folder.mkdir()
            link = packages / 'relative.egg-link'
            (packages / 'absolute.egg-link').write_text(str(first) + '\n.')
            (packages / 'empty.egg-link').write_text('\n.')
            (packages / 'missing.egg-link').write_text('../missing source\n.')
            for relative_backend in (False, workspace._RELATIVE_METADATA_SUPPORTED):
                with mock.patch.object(workspace, '_RELATIVE_METADATA_SUPPORTED', relative_backend):
                    for target in (first, second):
                        link.write_text(os.path.relpath(target, packages) + '\n.')
                        actual = workspace.find_editable_installs(str(packages))
                        self.assertEqual({entry.name: entry.path for entry in actual},
                                         {'absolute': str(first), 'relative': str(target)})
                    second.rmdir()
                    self.assertEqual([entry.name for entry in workspace.find_editable_installs(str(packages))],
                                     ['absolute'])
                    second.mkdir()

    def test_relative_egg_link_parent_segments_follow_source_symlinks(self):
        from django_orm_intellisense.discovery import workspace
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            packages = root / 'site-packages'
            source = root / 'external/source'
            nested = root / 'external/nested'
            for folder in (packages, source, nested):
                folder.mkdir(parents=True)
            (packages / 'bridge').symlink_to(nested, target_is_directory=True)
            (packages / 'relative.egg-link').write_text('bridge/../source\n.')
            for relative_backend in (False, workspace._RELATIVE_METADATA_SUPPORTED):
                with mock.patch.object(workspace, '_RELATIVE_METADATA_SUPPORTED', relative_backend):
                    self.assertEqual([(entry.name, entry.path) for entry in workspace.find_editable_installs(str(packages))],
                                     [('relative', str(source))])

    @unittest.skipUnless(os.open in os.supports_dir_fd and os.scandir in os.supports_fd,
                         'Descriptor-relative metadata is not supported')
    def test_relative_egg_link_targets_stay_with_the_scanned_venv_after_symlink_switch(self):
        from django_orm_intellisense.discovery import workspace
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            locations = []
            for name in ('first', 'second'):
                location = root / name
                packages = location / 'site-packages'
                source = location / 'source'
                packages.mkdir(parents=True)
                source.mkdir()
                (packages / 'relative.egg-link').write_text('../source\n.')
                locations.append((packages, source))
            alias = root / 'site-packages'
            alias.symlink_to(locations[0][0], target_is_directory=True)
            original_scandir = os.scandir

            def switch_after_scan(directory):
                iterator = original_scandir(directory)
                alias.unlink()
                alias.symlink_to(locations[1][0], target_is_directory=True)
                return iterator

            with mock.patch.object(workspace.os, 'scandir', switch_after_scan):
                actual = workspace.find_editable_installs(str(alias))
                self.assertEqual([(entry.name, entry.path) for entry in actual],
                                 [('relative', str(locations[0][1]))])
            self.assertEqual(workspace.find_editable_installs(str(alias))[0].path, str(locations[1][1]))

    def test_relative_and_portable_editable_reads_match_and_remain_fresh(self):
        from django_orm_intellisense.discovery import workspace
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            packages = root / 'site-packages'
            packages.mkdir()
            first, second = root / 'first source', root / 'second source'
            first.mkdir()
            second.mkdir()
            (packages / 'legacy.egg-link').write_text(str(first) + '\n.')
            folder = packages / 'editable-1.0.dist-info'
            folder.mkdir()
            metadata = folder / 'direct_url.json'
            (packages / 'ordinary-1.0.dist-info').mkdir()
            (packages / 'not_a_directory.dist-info').write_text('ordinary file')
            (packages / 'linked-1.0.dist-info').symlink_to(folder, target_is_directory=True)
            for target in (first, second):
                metadata.write_text(json.dumps({'url': target.as_uri(), 'dir_info': {'editable': True}}))
                (packages / 'legacy.egg-link').write_text(str(target) + '\n.')
                with mock.patch.object(workspace, '_RELATIVE_METADATA_SUPPORTED', False):
                    portable = workspace.find_editable_installs(str(packages))
                actual = workspace.find_editable_installs(str(packages))
                self.assertEqual(actual, portable)
                self.assertEqual({entry.path for entry in actual}, {str(target)})
                self.assertEqual({entry.name for entry in actual}, {'legacy', 'editable', 'linked'})
            metadata.unlink()
            self.assertEqual([entry.name for entry in workspace.find_editable_installs(str(packages))], ['legacy'])

    @unittest.skipUnless(os.open in os.supports_dir_fd and os.scandir in os.supports_fd,
                         'Descriptor-relative metadata is not supported')
    def test_metadata_directory_and_file_descriptors_close_on_unexpected_failure(self):
        from django_orm_intellisense.discovery import workspace
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            packages = root / 'site-packages'
            folder = packages / 'editable-1.0.dist-info'
            folder.mkdir(parents=True)
            (folder / 'direct_url.json').write_text('{}')
            opened = []
            original_open = os.open
            def recorded_open(*args, **kwargs):
                descriptor = original_open(*args, **kwargs)
                opened.append((descriptor, args[0], kwargs.get('dir_fd')))
                return descriptor
            with mock.patch.object(workspace.os, 'open', recorded_open):
                with mock.patch.object(workspace.os, 'read',
                                       side_effect=RuntimeError('unexpected read failure')):
                    with self.assertRaisesRegex(RuntimeError, 'unexpected read failure'):
                        workspace.find_editable_installs(str(packages))
            self.assertEqual(len(opened), 2)
            self.assertEqual(opened[1][1], 'editable-1.0.dist-info/direct_url.json')
            self.assertEqual(opened[1][2], opened[0][0])
            for descriptor, _, _ in opened:
                with self.assertRaises(OSError):
                    os.fstat(descriptor)

    @unittest.skipUnless(os.open in os.supports_dir_fd and os.scandir in os.supports_fd,
                         'Descriptor-relative metadata is not supported')
    def test_editable_scan_and_reads_share_a_directory_when_venv_symlink_switches(self):
        from django_orm_intellisense.discovery import workspace
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            first, second = root / 'first', root / 'second'
            first.mkdir()
            second.mkdir()
            roots = []
            for name, target in (('first-packages', first), ('second-packages', second)):
                packages = root / name
                folder = packages / 'editable-1.0.dist-info'
                folder.mkdir(parents=True)
                (folder / 'direct_url.json').write_text(json.dumps(
                    {'url': target.as_uri(), 'dir_info': {'editable': True}}))
                roots.append(packages)
            alias = root / 'site-packages'
            alias.symlink_to(roots[0], target_is_directory=True)
            original_scandir = os.scandir
            def switch_after_scan(directory):
                iterator = original_scandir(directory)
                alias.unlink()
                alias.symlink_to(roots[1], target_is_directory=True)
                return iterator
            with mock.patch.object(workspace.os, 'scandir', switch_after_scan):
                self.assertEqual(workspace.find_editable_installs(str(alias))[0].path, str(first))
            self.assertEqual(workspace.find_editable_installs(str(alias))[0].path, str(second))

    def test_missing_direct_url_files_do_not_construct_text_readers(self):
        from django_orm_intellisense.discovery.workspace import find_editable_installs
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / 'source'
            source.mkdir()
            packages = root / 'site-packages'
            packages.mkdir()
            for number in range(32):
                (packages / f'ordinary_{number}-1.0.dist-info').mkdir()
            metadata = packages / 'editable-1.0.dist-info'
            metadata.mkdir()
            (metadata / 'direct_url.json').write_text(json.dumps(
                {'url': source.as_uri(), 'dir_info': {'editable': True}}))
            import builtins
            original_open = builtins.open
            streams = []
            def text_reader(file, *args, **kwargs):
                streams.append(file)
                return original_open(file, *args, **kwargs)
            with mock.patch('django_orm_intellisense.discovery.workspace.open', text_reader, create=True):
                actual = find_editable_installs(str(packages))
            self.assertEqual([(entry.name, entry.path) for entry in actual], [('editable', str(source))])
            self.assertEqual(len(streams), 0)

    def test_editable_metadata_create_modify_delete_remains_visible(self):
        from django_orm_intellisense.discovery.workspace import find_editable_installs
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            packages = root / 'site-packages'
            first, second = root / 'first', root / 'second'
            first.mkdir()
            second.mkdir()
            metadata = packages / 'editable-1.0.dist-info'
            metadata.mkdir(parents=True)
            path = metadata / 'direct_url.json'
            self.assertEqual(find_editable_installs(str(packages)), [])
            path.write_text(json.dumps({'url': first.as_uri(), 'dir_info': {'editable': True}}))
            self.assertEqual(find_editable_installs(str(packages))[0].path, str(first))
            path.write_text(json.dumps({'url': second.as_uri(), 'dir_info': {'editable': True}}))
            self.assertEqual(find_editable_installs(str(packages))[0].path, str(second))
            path.write_text(json.dumps({'url': second.as_uri(), 'dir_info': {'editable': False}}))
            self.assertEqual(find_editable_installs(str(packages)), [])
            path.unlink()
            self.assertEqual(find_editable_installs(str(packages)), [])

    def test_direct_url_descriptors_close_after_reads_decode_parse_and_read_errors(self):
        from django_orm_intellisense.discovery.workspace import _read_direct_url_metadata
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / 'direct_url.json'
            original_open = os.open
            descriptors = []
            def open_descriptor(*args, **kwargs):
                descriptor = original_open(*args, **kwargs)
                descriptors.append(descriptor)
                return descriptor
            with mock.patch('django_orm_intellisense.discovery.workspace.os.open', open_descriptor):
                path.write_text('{}')
                self.assertEqual(_read_direct_url_metadata(str(path)), {})
                with self.assertRaises(OSError):
                    os.fstat(descriptors[-1])
                path.write_text('{invalid')
                with self.assertRaises(ValueError):
                    _read_direct_url_metadata(str(path))
                with self.assertRaises(OSError):
                    os.fstat(descriptors[-1])
                path.write_bytes(b'\xff')
                with self.assertRaises(UnicodeError):
                    _read_direct_url_metadata(str(path))
                with self.assertRaises(OSError):
                    os.fstat(descriptors[-1])
                with mock.patch('django_orm_intellisense.discovery.workspace.os.read',
                                side_effect=OSError('read failed')):
                    with self.assertRaisesRegex(OSError, 'read failed'):
                        _read_direct_url_metadata(str(path))
                with self.assertRaises(OSError):
                    os.fstat(descriptors[-1])

    def test_direct_url_reads_preserve_large_utf8_payloads_and_short_reads(self):
        from django_orm_intellisense.discovery import workspace
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / 'direct_url.json'
            expected = {'url': 'file:///한글 source', 'dir_info': {'editable': True},
                        'extra': '한글' * (workspace._METADATA_READ_BYTES // 2)}
            path.write_text(json.dumps(expected, ensure_ascii=False), encoding='utf-8')
            self.assertGreater(path.stat().st_size, workspace._METADATA_READ_BYTES)
            original_read = os.read
            calls = 0
            def short_read(descriptor, size):
                nonlocal calls
                calls += 1
                return original_read(descriptor, min(size, 127))
            with mock.patch.object(workspace.os, 'read', short_read):
                self.assertEqual(workspace._read_direct_url_metadata(str(path)), expected)
            self.assertGreater(calls, 2)
            path.write_bytes(b'\xef\xbb\xbf{}')
            with self.assertRaises(ValueError):
                workspace._read_direct_url_metadata(str(path))
            path.write_bytes('{}\r\n'.encode('utf-16'))
            with self.assertRaises(UnicodeError):
                workspace._read_direct_url_metadata(str(path))
            path.write_bytes(b' ' * (workspace._METADATA_READ_BYTES + 1) + b'\xe3')
            with self.assertRaises(UnicodeError):
                workspace._read_direct_url_metadata(str(path))

    def test_directory_fingerprint_is_stable_between_python_processes(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for name in ('blog', 'accounts', 'shared/nested'):
                folder = root / name
                folder.mkdir(parents=True)
                (folder / 'models.py').write_text('value = 1\n')
            expected = snapshot_python_sources(root).fingerprint
            code = ('import sys; from pathlib import Path; '
                    'from django_orm_intellisense.discovery.workspace import snapshot_python_sources; '
                    'print(snapshot_python_sources(Path(sys.argv[1])).fingerprint)')
            package_root = str(Path(__file__).resolve().parents[1])
            for seed in ('0', '1', '2', '3'):
                result = subprocess.run([sys.executable, '-c', code, str(root)], check=True,
                    capture_output=True, text=True, timeout=10, env={**os.environ,
                        'PYTHONHASHSEED': seed,
                        'PYTHONPATH': os.pathsep.join(filter(None, (package_root, os.environ.get('PYTHONPATH'))))})
                self.assertEqual(result.stdout.strip(), expected, f'hash seed {seed}')

    def test_root_fingerprint_includes_every_top_level_directory(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for number in range(32):
                folder = root / f'app_{number}'
                folder.mkdir()
                (folder / 'models.py').write_text('value = 1\n')
            before = snapshot_python_sources(root, max_workers=1)
            expected = hashlib.sha256()
            for name in sorted(folder.name for folder in root.iterdir()):
                expected.update(b'D\0' + name.encode() + b'\0')
                expected.update(before.directory_fingerprints[name].encode() + b'\0')
            self.assertEqual(before.fingerprint, expected.hexdigest())
            for folder in sorted(root.iterdir()):
                path = folder / 'models.py'
                path.write_text('value = 22\n')
                changed = snapshot_python_sources(root, max_workers=1)
                self.assertNotEqual(changed.fingerprint, before.fingerprint, folder.name)
                path.write_text('value = 1\n')
                before = snapshot_python_sources(root, max_workers=1)

    def test_editable_file_url_decodes_spaces_and_localhost(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            packages = root / 'site-packages'
            packages.mkdir()
            source = root / '한글 source with spaces'
            source.mkdir()
            for name, url in [('spaces', source.as_uri()), ('localhost', source.as_uri().replace('file:///', 'file://localhost/'))]:
                metadata = packages / f'{name}-1.0.dist-info'
                metadata.mkdir()
                (metadata / 'direct_url.json').write_text(json.dumps({'url': url, 'dir_info': {'editable': True}}))
            from django_orm_intellisense.discovery.workspace import find_editable_installs
            installs = find_editable_installs(str(packages))
            self.assertEqual({entry.name for entry in installs}, {'spaces', 'localhost'})
            self.assertTrue(all(entry.path == str(source) for entry in installs))

    def test_venv_discovery_preserves_both_editable_formats_and_ignores_bad_metadata(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            venv = root / '.venv'
            packages = venv / 'lib/python3.12/site-packages'
            packages.mkdir(parents=True)
            (venv / 'pyvenv.cfg').write_text('version = 3.12.13\ninclude-system-site-packages = false\n')
            legacy = root / 'legacy_source'
            modern = root / 'modern_source'
            legacy.mkdir()
            modern.mkdir()
            (packages / 'legacy.egg-link').write_text(str(legacy) + '\n.')
            for name, data in (
                ('modern-1.0', json.dumps({'url': modern.as_uri(), 'dir_info': {'editable': True}})),
                ('ordinary-1.0', json.dumps({'url': modern.as_uri(), 'dir_info': {'editable': False}})),
                ('broken-1.0', '{invalid'),
                ('list-1.0', '[]'),
                ('invalid_dir_info-1.0', json.dumps({'dir_info': []})),
                ('invalid_url-1.0', json.dumps({'dir_info': {'editable': True}, 'url': None})),
                ('remote-1.0', json.dumps({'dir_info': {'editable': True}, 'url': modern.as_uri().replace('file:///', 'file://remote/')})),
            ):
                metadata = packages / f'{name}.dist-info'
                metadata.mkdir()
                (metadata / 'direct_url.json').write_text(data)
            (packages / 'no_metadata-1.0.dist-info').mkdir()
            invalid = packages / 'invalid_encoding-1.0.dist-info'
            invalid.mkdir()
            (invalid / 'direct_url.json').write_bytes(b'\xff')
            (packages / 'invalid.egg-link').write_bytes(b'\xff')
            info = resolve_venv_info(root)
            self.assertEqual(info.site_packages, str(packages))
            self.assertEqual([(entry.name, entry.path, entry.kind) for entry in info.editable_installs],
                             [('legacy', str(legacy), 'egg-link'), ('modern', str(modern), 'direct-url')])

    def test_batched_snapshot_is_stable_and_tracks_added_deleted_and_external_files(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / 'workspace'
            extra = Path(temporary) / 'editable'
            root.mkdir()
            extra.mkdir()
            for number in range(150):
                (root / f'file_{number:03}.py').write_text(f'value = {number}\n')
            external = extra / 'model.py'
            external.write_text('class Model:\n    pass\n')
            excluded = root / '.venv'
            excluded.mkdir()
            (excluded / 'excluded.py').write_text('value = 0\n')
            first = snapshot_python_sources(root, [extra])
            second = snapshot_python_sources(root, [extra])
            self.assertEqual(first, second)
            self.assertEqual(first, snapshot_python_sources(root, [extra], max_workers=1))
            self.assertEqual(first.file_count, 151)
            self.assertIn(str(external), first.entries_by_path)
            self.assertNotIn('.venv/excluded.py', first.entries_by_path)
            (root / 'file_000.py').unlink()
            (root / 'added.py').write_text('new = True\n')
            external.write_text('class Changed:\n    pass\n')
            changed = snapshot_python_sources(root, [extra])
            self.assertEqual(changed.file_count, 151)
            self.assertNotEqual(changed.fingerprint, first.fingerprint)
            self.assertNotIn('file_000.py', changed.entries_by_path)
            self.assertIn('added.py', changed.entries_by_path)
            self.assertNotEqual(changed.entries_by_path[str(external)], first.entries_by_path[str(external)])

    def test_external_editable_models_survive_full_and_partial_cache_restoration(self):
        with tempfile.TemporaryDirectory() as temporary:
            folder = Path(temporary)
            root = folder / 'workspace'
            blog = root / 'blog'
            shared = folder / 'library/src/shared'
            blog.mkdir(parents=True)
            shared.mkdir(parents=True)
            (blog / '__init__.py').write_text('')
            (blog / 'models.py').write_text('from django.db import models\nclass Post(models.Model):\n    title = models.CharField()\n')
            (shared / '__init__.py').write_text('from .models import Shared\n')
            external = shared / 'models.py'
            external.write_text('from django.db import models\nclass Shared(models.Model):\n    score = models.CharField()\n')
            sources = snapshot_python_sources(root, [folder / 'library'])
            index = build_static_index(root, sources.files)
            self.assertTrue(index.resolve_export_origin('shared', 'Shared').resolved)
            self.assertIn('shared.Shared', {candidate.label for candidate in index.model_candidates})
            with mock.patch.dict('os.environ', {'DJANGO_ORM_INTELLISENSE_CACHE_DIR': str(folder / 'cache')}):
                save_static_index(root, sources, index)
                restored, hit = load_cached_static_index(root, sources)
                self.assertEqual(hit, 'full')
                self.assertEqual(restored.fields, index.fields)
                external.write_text(external.read_text().replace('CharField', 'IntegerField'))
                changed_sources = snapshot_python_sources(root, [folder / 'library'])
                changed, hit = load_cached_static_index(root, changed_sources)
            self.assertEqual(hit, 'partial')
            self.assertEqual(changed.find_field('shared.Shared', 'score').field_kind, 'IntegerField')
            self.assertEqual(index.find_field('shared.Shared', 'score').field_kind, 'CharField')

    def test_cached_top_level_model_change_requires_partial_restoration(self):
        with tempfile.TemporaryDirectory() as temporary:
            folder = Path(temporary)
            root = folder / 'workspace'
            blog = root / 'blog'
            blog.mkdir(parents=True)
            (blog / '__init__.py').write_text('')
            path = blog / 'models.py'
            path.write_text('from django.db import models\nclass Post(models.Model):\n    title = models.CharField()\n')
            before = snapshot_python_sources(root)
            index = build_static_index(root, before.files)
            with mock.patch.dict('os.environ', {'DJANGO_ORM_INTELLISENSE_CACHE_DIR': str(folder / 'cache')}):
                save_static_index(root, before, index)
                path.write_text(path.read_text().replace('CharField', 'DateField'))
                after = snapshot_python_sources(root)
                restored, hit = load_cached_static_index(root, after)
            self.assertNotEqual(before.fingerprint, after.fingerprint)
            self.assertEqual(hit, 'partial')
            self.assertEqual(restored.find_field('blog.Post', 'title').field_kind, 'DateField')
            self.assertEqual(index.find_field('blog.Post', 'title').field_kind, 'CharField')


if __name__ == '__main__':
    unittest.main()
