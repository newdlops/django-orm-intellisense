"""Full member cache fidelity, corruption rejection and source ownership."""
import copy
import dataclasses
import io
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from django_orm_intellisense.cache import store, runtime_member_records as records
from django_orm_intellisense.features import orm_members
from django_orm_intellisense.runtime.inspector import (
    create_pending_runtime_inspection, RuntimeModelSummary, RuntimeFieldSummary,
)
from django_orm_intellisense.semantic.graph import build_model_graph
from django_orm_intellisense.static_index.indexer import build_static_index


class RuntimeMemberCatalogCacheTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='djls173-catalog-cache-')
        self.addCleanup(temporary.cleanup)
        self.base = Path(temporary.name).resolve()
        self.root = self.base / 'project'
        package = self.root / 'blog'
        package.mkdir(parents=True)
        (package / '__init__.py').write_text('')
        self.source = package / 'models.py'
        self.source.write_text('from django.db import models\nclass Post(models.Model):\n'
            '    title = models.CharField(max_length=20)\n')
        self.static = build_static_index(self.root)
        self.runtime = dataclasses.replace(create_pending_runtime_inspection('blog.settings'),
            bootstrap_status='ready', django_version='test')
        self.graph = build_model_graph(self.static, self.runtime)
        self.surface = orm_members.build_surface_index(self.static, self.runtime, self.graph)
        self.item = orm_members.OrmMemberItem(name='attached', member_kind='method', model_label='blog.Post',
            receiver_kind='instance', detail='메서드 😀', source='runtime', return_kind='instance',
            return_model_label='blog.Post', file_path=str(self.source), line=4, column=1,
            signature='attached(self, value: str = "한글") -> Post')
        manager = dataclasses.replace(self.item, name='special_method', receiver_kind='manager',
            return_kind='queryset', manager_name='special')
        model = RuntimeModelSummary('blog.Post', 'blog.models', ['title'], [], [],
            [RuntimeFieldSummary('title', 'CharField', False, None, None)], [], ['objects', 'special'])
        self.snapshot = orm_members.RuntimeMemberSnapshot(orm_members._runtime_member_identity(self.runtime),
            {('blog.Post', 'instance', None): (self.item,),
             ('blog.Post', 'related_manager', 'special'): (manager,)},
            {'blog.Post': ('objects', 'special')}, frozenset({'blog.Post'}), models={('blog.models', 'Post'): model})
        self.scope = mock.patch.dict(os.environ, {'DJANGO_ORM_INTELLISENSE_CACHE_DIR': str(self.base / 'cache')})
        self.scope.start()
        self.addCleanup(self.scope.stop)
        self.save()
        self.path = store._workspace_cache_dir(self.root) / store.SURFACE_INDEX_CACHE_NAME
        self.original = json.loads(self.path.read_text())

    def save(self, members=True):
        store.save_surface_index(self.root, 'source', 'runtime', self.surface,
            surface_fingerprints=orm_members.fingerprint_surface_index(self.surface),
            **({'runtime_members': self.snapshot} if members else {}))

    def load(self, **kwargs):
        return store.load_cached_surface_index(self.root, 'source', 'runtime',
            static_index=self.static, model_graph=self.graph, with_runtime_members=True,
            runtime_inspection=kwargs.get('runtime', self.runtime))

    def write(self, value, *, resign=False):
        if resign:
            value['metadata']['runtimeMembersFingerprint'] = records.fingerprint_digests({
                label: records.row_digest(row) for label, row in value['runtimeMembers'].items()})
        self.path.write_text(json.dumps(value))

    def test_full_records_signature_named_manager_and_model_metadata_round_trip(self):
        surface, fingerprints, snapshot = self.load()
        self.assertEqual(surface, self.surface)
        self.assertEqual(fingerprints, orm_members.fingerprint_surface_index(self.surface))
        self.assertEqual(snapshot, self.snapshot)
        self.assertEqual(snapshot.items[('blog.Post', 'instance', None)][0].to_dict(), self.item.to_dict())
        related = snapshot.items[('blog.Post', 'related_manager', 'special')][0]
        self.assertEqual(related.receiver_kind, 'manager', 'Original related-manager record was rewritten')
        self.assertEqual(related.manager_name, 'special')
        self.assertEqual(snapshot.models[('blog.models', 'Post')].to_dict(), self.snapshot.models[('blog.models', 'Post')].to_dict())

    def test_each_restore_owns_its_mutable_collections(self):
        first, second = self.load()[2], self.load()[2]
        self.assertIsNot(first, second)
        self.assertIsNot(first.items, second.items)
        self.assertIsNot(first.manager_names, second.manager_names)
        self.assertIsNot(first.models, second.models)
        self.assertIsNot(first.models[('blog.models', 'Post')].fields, second.models[('blog.models', 'Post')].fields)
        first.items.clear()
        first.manager_names.clear()
        first.models[('blog.models', 'Post')].fields.clear()
        self.assertEqual(second, self.snapshot)

    def test_capture_order_and_duplicate_method_names_are_preserved(self):
        key = ('blog.Post', 'related_manager', 'special')
        first = self.snapshot.items[key][0]
        duplicate = dataclasses.replace(first, detail='QuerySet implementation', return_kind='scalar')
        self.snapshot = dataclasses.replace(self.snapshot, items={**self.snapshot.items, key: (first, duplicate)})
        self.save()
        loaded = self.load()
        self.assertIsNotNone(loaded, 'Manager and QuerySet can legitimately expose the same method name')
        self.assertEqual(loaded[2].items[key], (first, duplicate))

    def test_original_cache_api_and_legacy_no_catalog_remain_readable(self):
        self.assertEqual(store.load_cached_surface_index(self.root, 'source', 'runtime'), self.surface)
        self.save(members=False)
        loaded = self.load()
        self.assertEqual(loaded[:2], (self.surface, orm_members.fingerprint_surface_index(self.surface)))
        self.assertIsNone(loaded[2], 'Legacy tuples were synthesized into complete member records')

    def test_identity_version_and_bootstrap_must_match_the_current_runtime(self):
        for key, value in (('runtimeMembersVersion', 2), ('runtimeMembersVersion', True),
                ('runtimeMembersIdentity', ['/foreign/python', 'blog.settings', 'test']),
                ('runtimeMembersIdentity', [self.runtime.python_executable, 'other.settings', 'test']),
                ('runtimeMembersIdentity', [self.runtime.python_executable, 'blog.settings', 'different'])):
            with self.subTest(key=key, value=value):
                payload = copy.deepcopy(self.original)
                payload['metadata'][key] = value
                self.write(payload)
                self.assertIsNone(self.load())
        self.write(self.original)
        self.assertIsNone(self.load(runtime=dataclasses.replace(self.runtime, bootstrap_status='warming_up')))

    def test_workspace_source_and_runtime_cache_bindings_are_preserved(self):
        for key, value in (('workspaceRoot', str(self.base / 'other')), ('sourceFingerprint', 'other-source'),
                ('runtimeFingerprint', 'other-runtime'), ('schemaVersion', 999)):
            with self.subTest(key=key):
                payload = copy.deepcopy(self.original)
                payload['metadata'][key] = value
                self.write(payload)
                self.assertIsNone(self.load())

    def test_full_catalog_restore_requires_its_static_graph_and_runtime_owner(self):
        for missing in ('static_index', 'model_graph', 'runtime_inspection'):
            with self.subTest(missing=missing):
                owners = {'static_index': self.static, 'model_graph': self.graph, 'runtime_inspection': self.runtime}
                owners[missing] = None
                self.assertIsNone(store.load_cached_surface_index(self.root, 'source', 'runtime',
                    with_runtime_members=True, **owners))

    def test_removed_or_changed_descriptors_cannot_claim_a_complete_catalog(self):
        def removed_model(value): value['runtimeMembers'].clear()
        def removed_receiver(value): value['runtimeMembers']['blog.Post']['receivers'].pop()
        def removed_item(value): value['runtimeMembers']['blog.Post']['receivers'][0][2].clear()
        def changed_signature(value): value['runtimeMembers']['blog.Post']['receivers'][0][2][0][-1] = 'different()'
        def changed_source(value): value['runtimeMembers']['blog.Post']['receivers'][0][2][0][9] = '/foreign/source.py'
        for mutate in (removed_model, removed_receiver, removed_item, changed_signature, changed_source):
            with self.subTest(case=mutate.__name__):
                payload = copy.deepcopy(self.original)
                mutate(payload)
                self.write(payload)
                self.assertIsNone(self.load())

    def test_malformed_types_are_rejected_even_with_a_matching_catalog_fingerprint(self):
        for field, value in ((0, 3), (10, True), (11, -1), (13, 1), (14, {'label': 'wrong signature type'})):
            with self.subTest(field=field, value=value):
                payload = copy.deepcopy(self.original)
                payload['runtimeMembers']['blog.Post']['receivers'][0][2][0][field] = value
                self.write(payload, resign=True)
                self.assertIsNone(self.load())

    def test_incomplete_invalidated_foreign_labels_and_foreign_paths_are_not_adopted(self):
        def incomplete(row): row['complete'] = False
        def invalidated(row): row['invalidated'] = True
        def foreign_path(row): row['receivers'][0][2][0][9] = str(self.base / 'outside.py')
        def foreign_owner(row): row['receivers'][0][2][0][2] = 'other.Post'
        for mutate in (incomplete, invalidated, foreign_path, foreign_owner):
            with self.subTest(case=mutate.__name__):
                payload = copy.deepcopy(self.original)
                mutate(payload['runtimeMembers']['blog.Post'])
                self.write(payload, resign=True)
                self.assertIsNone(self.load())

    def test_streamed_fallback_and_reordered_metadata_preserve_identical_records(self):
        for payload in (self.original, {'runtimeMembers': self.original['runtimeMembers'],
                'payload': self.original['payload'], 'metadata': self.original['metadata']}):
            raw = json.dumps(payload)
            for source in (raw, io.StringIO(raw)):
                decoded = store._decode_surface_cache_payload(source)
                metadata = decoded['metadata']
                snapshot = records.restore_snapshot(decoded['runtimeMembers'], metadata['runtimeMembersIdentity'],
                    expected_identity=self.snapshot.runtime_identity, expected_fingerprint=metadata['runtimeMembersFingerprint'])
                self.assertEqual(snapshot, self.snapshot)
            self.path.write_text(raw)
            self.assertEqual(self.load()[2], self.snapshot)

    def test_duplicate_top_level_values_use_the_final_value_and_future_metadata_stays_raw(self):
        original = self.original
        header = '{"metadata":' + json.dumps(original['metadata']) + ',"payload":' + json.dumps(original['payload'])
        good = json.dumps(original['runtimeMembers'])
        for tail, accepted in ((',"runtimeMembers":{"broken":false},"runtimeMembers":' + good + '}', True),
                (',"runtimeMembers":' + good + ',"runtimeMembers":{"broken":false}}', False)):
            with self.subTest(accepted=accepted):
                self.path.write_text(header + tail)
                loaded = self.load()
                self.assertEqual(loaded is not None, accepted)
                if loaded is not None: self.assertEqual(loaded[2], self.snapshot)
        future = dict(original['metadata'], runtimeMembersVersion=2)
        raw = header + ',"runtimeMembers":' + good + ',"metadata":' + json.dumps(future) + '}'
        decoded = store._decode_surface_cache_payload(io.StringIO(raw))
        self.assertEqual(decoded['runtimeMembers'], original['runtimeMembers'])
        self.path.write_text(raw)
        self.assertIsNone(self.load())


if __name__ == '__main__':
    unittest.main()
