"""Canonical source aliases must not revive an older runtime/cache owner."""
import contextlib
import hashlib
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from django_orm_intellisense.cache import save_model_graph, save_runtime_inspection, save_static_index
from django_orm_intellisense.discovery.workspace import snapshot_python_sources, source_membership_fingerprint
from django_orm_intellisense.server import app
from django_orm_intellisense.static_index.indexer import build_static_index
from tests.test_static_fallback_surface_gap import _make_server, _ready_runtime, _write_blog_models


class SourceMembershipCacheTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='djls-membership-cache-')
        self.addCleanup(temporary.cleanup)
        self.base = Path(temporary.name).resolve()
        self.root = self.base / 'project'
        self.root.mkdir()
        _write_blog_models(self.root)
        self.source = self.root / 'blog/models.py'
        (self.base / 'external').mkdir()
        self.old = self.base / 'external/old_models.py'
        self.new = self.base / 'external/new_models.py'
        self.source.replace(self.old)
        os.link(self.old, self.new)
        self.source.symlink_to(self.old)
        self.server = _make_server(self.root)
        self.stack = contextlib.ExitStack()
        self.addCleanup(self.stack.close)
        self.stack.enter_context(mock.patch.dict(os.environ, {
            'DJANGO_ORM_INTELLISENSE_CACHE_DIR': str(self.base / 'cache')}))
        for name in ('_start_runtime_warmup', '_start_runtime_field_registry_prewarm',
                     '_schedule_surface_index_idle_load', '_schedule_runtime_member_refresh'):
            self.stack.enter_context(mock.patch.object(self.server, name))

    def retarget(self):
        replacement = self.root / 'blog/replacement-link'
        replacement.symlink_to(self.new)
        replacement.replace(self.source)

    def snapshot(self):
        return snapshot_python_sources(self.root, max_workers=1)

    def runtime_key(self, snapshot, settings='project.settings'):
        return app._runtime_source_fingerprint(source_snapshot=snapshot,
            static_index=build_static_index(self.root, snapshot.files), settings_module=settings)

    def prime(self):
        snapshot = self.snapshot()
        index = build_static_index(self.root, snapshot.files)
        runtime = _ready_runtime()
        key = self.runtime_key(snapshot)
        save_static_index(self.root, snapshot, index)
        save_runtime_inspection(self.root, key, 'project.settings', runtime)
        save_model_graph(self.root, snapshot.fingerprint,
            app._runtime_cache_fingerprint(runtime, source_fingerprint=key), app.build_model_graph(index, runtime))
        return snapshot

    def initialize(self, defer=True):
        return self.server._initialize({'workspaceRoot': str(self.root),
            'settingsModule': 'project.settings', 'deferRuntime': defer})

    def test_membership_matches_independent_resolve_oracle_with_external_and_overlapping_roots(self):
        snapshot = snapshot_python_sources(self.root, [self.base / 'external', self.root / 'blog'])
        digest = hashlib.sha256(b'django-orm-source-membership-v1\0')
        digest.update(f'R\0{Path(snapshot.root).resolve(strict=True)}\0'.encode())
        for entry, path in sorted(zip(snapshot.entries, snapshot.files), key=lambda item: item[0].relative_path):
            digest.update(f'F\0{entry.relative_path}\0{path.resolve(strict=True)}\0'.encode())
        self.assertEqual(source_membership_fingerprint(snapshot), digest.hexdigest())

    def test_hardlink_retarget_changes_runtime_and_derived_cache_keys_with_identical_v2_snapshot(self):
        before = self.snapshot()
        membership = source_membership_fingerprint(before)
        key = self.runtime_key(before)
        self.retarget()
        after = self.snapshot()
        self.assertEqual(before, after)
        self.assertEqual(before._file_identities, after._file_identities)
        self.assertNotEqual(membership, source_membership_fingerprint(after))
        new_key = self.runtime_key(after)
        self.assertNotEqual(key, new_key)
        runtime = _ready_runtime()
        self.assertNotEqual(app._runtime_cache_fingerprint(runtime, source_fingerprint=key),
            app._runtime_cache_fingerprint(runtime, source_fingerprint=new_key))

    def test_settings_modules_with_same_package_keep_distinct_derived_cache_context(self):
        snapshot = self.snapshot()
        self.assertNotEqual(self.runtime_key(snapshot, 'project.development'),
                            self.runtime_key(snapshot, 'project.production'))

    def test_helper_edit_outside_model_and_settings_packages_changes_runtime_source_key(self):
        (self.root / 'guard_settings.py').write_text('SECRET_KEY="guard"\n')
        helper = self.root / 'helper.py'
        helper.write_text('field_name="old_code"\n')
        before = self.snapshot()
        key = self.runtime_key(before, 'guard_settings')
        stamp = helper.stat()
        helper.write_text('field_name="new_code"\n')
        os.utime(helper, ns=(stamp.st_atime_ns, stamp.st_mtime_ns))
        after = self.snapshot()
        self.assertNotEqual(before.fingerprint, after.fingerprint)
        self.assertEqual(source_membership_fingerprint(before), source_membership_fingerprint(after))
        self.assertNotEqual(key, self.runtime_key(after, 'guard_settings'))

    def test_missing_target_rejects_the_complete_membership_witness(self):
        snapshot = self.snapshot()
        replacement = self.root / 'blog/replacement-link'
        replacement.symlink_to(self.base / 'missing.py')
        replacement.replace(self.source)
        with self.assertRaises(OSError):
            source_membership_fingerprint(snapshot)

    def test_cached_runtime_is_retried_when_alias_changes_after_membership_capture(self):
        before = self.prime()
        calls = []

        def capture(snapshot):
            value = source_membership_fingerprint(snapshot)
            calls.append(value)
            if len(calls) == 1:
                self.retarget()
            return value

        with mock.patch.object(app, 'source_membership_fingerprint', side_effect=capture), \
                mock.patch.object(app, 'load_cached_runtime_inspection', wraps=app.load_cached_runtime_inspection) as load, \
                mock.patch.object(app, 'inspect_runtime', side_effect=AssertionError('Retry should defer runtime')):
            result = self.initialize()
        self.assertEqual(before, self.snapshot())
        self.assertEqual(load.call_count, 2)
        self.assertNotEqual(load.call_args_list[0].args[1], load.call_args_list[1].args[1])
        self.assertEqual(result['health']['runtime']['bootstrapStatus'], 'warming_up')
        self.assertEqual(self.server._source_membership_fingerprint, source_membership_fingerprint(self.snapshot()))

    def test_fresh_runtime_alias_change_cannot_be_adopted_or_persisted_under_the_older_key(self):
        def inspect(settings):
            self.retarget()
            return _ready_runtime()

        with mock.patch.object(app, 'inspect_runtime', side_effect=inspect), \
                mock.patch.object(app, 'save_runtime_inspection') as save, \
                mock.patch.object(self.server, '_apply_state', wraps=self.server._apply_state) as adopt:
            with self.assertRaisesRegex(RuntimeError, 'sources changed during runtime initialization'):
                self.initialize(defer=False)
        save.assert_not_called()
        adopt.assert_not_called()

    def test_delayed_warmup_never_relabels_changed_canonical_sources_at_save_time(self):
        self.initialize()
        old_membership = self.server._source_membership_fingerprint

        def inspect(settings):
            self.retarget()
            return _ready_runtime()

        with mock.patch.object(app, 'inspect_runtime', side_effect=inspect), \
                mock.patch.object(app, 'save_runtime_inspection') as save_runtime, \
                mock.patch.object(app, 'save_model_graph') as save_graph, \
                mock.patch.object(self.server, '_publish_warmed_runtime_state'):
            self.server._warm_runtime_state(generation=self.server._state_generation,
                initialized_at=self.server.initialized_at, workspace_root=self.root,
                workspace_profile=self.server.workspace_profile, static_index=self.server.static_index,
                runtime_source_fingerprint=self.server._runtime_source_cache_fingerprint,
                settings_module='project.settings', source_snapshot=self.server.source_snapshot,
                source_membership=old_membership)
        self.assertNotEqual(old_membership, source_membership_fingerprint(self.snapshot()))
        save_runtime.assert_not_called()
        save_graph.assert_not_called()

    def test_unwatched_stat_change_during_import_cannot_be_saved_under_the_initialize_source(self):
        self.initialize()
        old_membership = self.server._source_membership_fingerprint
        old_snapshot = self.server.source_snapshot

        def inspect(settings):
            with self.source.open('a') as out:
                out.write('\n# unwatched edit during runtime inspection\n')
            return _ready_runtime()

        with mock.patch.object(app, 'inspect_runtime', side_effect=inspect), \
                mock.patch.object(app, 'save_runtime_inspection') as save_runtime, \
                mock.patch.object(app, 'save_model_graph') as save_graph, \
                mock.patch.object(self.server, '_publish_warmed_runtime_state'):
            self.server._warm_runtime_state(generation=self.server._state_generation,
                initialized_at=self.server.initialized_at, workspace_root=self.root,
                workspace_profile=self.server.workspace_profile, static_index=self.server.static_index,
                runtime_source_fingerprint=self.server._runtime_source_cache_fingerprint,
                settings_module='project.settings', source_snapshot=old_snapshot,
                source_membership=old_membership)
        self.assertNotEqual(old_snapshot.fingerprint, self.snapshot().fingerprint)
        self.assertEqual(old_membership, source_membership_fingerprint(self.snapshot()))
        save_runtime.assert_not_called()
        save_graph.assert_not_called()

    def test_warmup_pre_import_mismatch_is_not_relabelled_when_alias_returns_before_save(self):
        self.initialize()
        old_membership = self.server._source_membership_fingerprint
        self.retarget()

        def inspect(settings):
            replacement = self.root / 'blog/replacement-link'
            replacement.symlink_to(self.old)
            replacement.replace(self.source)
            return _ready_runtime()

        with mock.patch.object(app, 'inspect_runtime', side_effect=inspect), \
                mock.patch.object(app, 'save_runtime_inspection') as save_runtime, \
                mock.patch.object(app, 'save_model_graph') as save_graph, \
                mock.patch.object(self.server, '_publish_warmed_runtime_state'):
            self.server._warm_runtime_state(generation=self.server._state_generation,
                initialized_at=self.server.initialized_at, workspace_root=self.root,
                workspace_profile=self.server.workspace_profile, static_index=self.server.static_index,
                runtime_source_fingerprint=self.server._runtime_source_cache_fingerprint,
                settings_module='project.settings', source_snapshot=self.server.source_snapshot,
                source_membership=old_membership)
        self.assertEqual(old_membership, source_membership_fingerprint(self.snapshot()))
        save_runtime.assert_not_called()
        save_graph.assert_not_called()


if __name__ == '__main__':
    unittest.main()
