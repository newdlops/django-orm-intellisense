import dataclasses
import pickle
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from django_orm_intellisense.features import orm_members
from django_orm_intellisense.runtime.inspector import (
    RuntimeFieldSummary, RuntimeModelSummary, create_pending_runtime_inspection,
)
from django_orm_intellisense.semantic import graph as semantic
from django_orm_intellisense.server import runtime_members
from django_orm_intellisense.static_index.indexer import build_static_index


class RuntimeModelRefreshTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='djls-new-runtime-model-')
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        package = self.root / 'sourceapp'
        package.mkdir()
        (package / '__init__.py').write_text('')
        (package / 'models.py').write_text('from django.db import models\n'
            'class Post(models.Model):\n    value = models.CharField()\n'
            'class Added(models.Model):\n    number = models.IntegerField()\n')
        self.static = build_static_index(self.root)
        self.post = self.summary('custom.Post', [('id', 'BigAutoField'), ('value', 'CharField')])
        self.added = self.summary('custom.Added', [('id', 'BigAutoField'), ('number', 'IntegerField')])
        self.runtime = dataclasses.replace(create_pending_runtime_inspection(None), bootstrap_status='ready',
            model_count=1, model_catalog=(self.post,), model_preview=[self.post])
        self.graph = semantic.build_model_graph(self.static, self.runtime)

    def summary(self, label, fields):
        return RuntimeModelSummary(label, 'sourceapp.models', [name for name, _ in fields], [], [],
            [RuntimeFieldSummary(name, kind, False, None, None) for name, kind in fields], [], ['objects'])

    def snapshot(self, models):
        return orm_members.RuntimeMemberSnapshot(orm_members._runtime_member_identity(self.runtime), {}, {},
            frozenset({'sourceapp.Post', 'sourceapp.Added'}), models=models)

    def test_new_runtime_summary_reconciles_to_whole_fresh_graph_without_replacing_core_catalog(self):
        previous = self.snapshot({})
        models = {('sourceapp.models', 'Added'): self.added}
        snapshot = self.snapshot(models)
        self.static._runtime_member_snapshot = snapshot
        updated, affected = runtime_members.refresh_runtime_model_graph(self.static, self.runtime,
            self.graph, previous, snapshot)
        cold = semantic.build_model_graph(self.static,
            dataclasses.replace(self.runtime, model_catalog=(self.post, self.added)))
        self.assertEqual(updated, cold)
        self.assertEqual(affected, {'sourceapp.Added'})
        self.assertIn('custom.Added', updated.nodes_by_label)
        self.assertNotIn('sourceapp.Added', updated.nodes_by_label)
        self.assertIn('sourceapp.Added', self.graph.nodes_by_label)
        self.assertEqual(self.runtime.model_catalog, (self.post,))
        self.assertEqual(self.runtime.model_count, 1)
        self.assertIs(updated.nodes_by_label['custom.Post'], self.graph.nodes_by_label['custom.Post'])
        delta = runtime_members.model_graph_delta(self.graph, updated)
        restored = runtime_members.apply_runtime_graph_delta(self.graph, delta)
        self.assertEqual(restored, updated)
        self.assertIs(restored.nodes_by_label['custom.Post'], self.graph.nodes_by_label['custom.Post'])
        for protocol in range(pickle.HIGHEST_PROTOCOL + 1):
            value = pickle.loads(pickle.dumps((snapshot, delta), protocol=protocol))
            self.assertEqual(value[0], snapshot)
            self.assertEqual(runtime_members.apply_runtime_graph_delta(self.graph, value[1]), updated)

    def test_label_map_cache_tracks_metadata_owner_and_reuses_catalogue_only_replacements(self):
        models = {('sourceapp.models', 'Added'): self.added}
        self.static._runtime_member_snapshot = self.snapshot(models)
        maps = semantic._runtime_graph_maps(self.static, self.runtime)
        catalogue_only = dataclasses.replace(self.runtime, lookup_catalog={'future': True})
        with mock.patch.object(semantic, '_build_runtime_graph_maps', side_effect=AssertionError('cache miss')):
            self.assertIs(semantic._runtime_graph_maps(self.static, catalogue_only), maps)
            self.static._runtime_member_snapshot = dataclasses.replace(self.snapshot(models), invalidated_labels=frozenset({'sourceapp.Added'}))
            self.assertIs(semantic._runtime_graph_maps(self.static, self.runtime), maps)
        self.static._runtime_member_snapshot = self.snapshot({('sourceapp.models', 'Added'):
            dataclasses.replace(self.added, label='renamed.Added')})
        current = semantic._runtime_graph_maps(self.static, self.runtime)
        self.assertEqual(current[1]['sourceapp.Added'], 'renamed.Added')
        self.assertNotIn('custom.Added', current[0])
        self.assertEqual(maps[1]['sourceapp.Added'], 'custom.Added')

    def test_wrong_environment_metadata_is_ignored_and_invalidation_preserves_snapshot_ownership(self):
        models = {('sourceapp.models', 'Added'): self.added}
        snapshot = self.snapshot(models)
        self.static._runtime_member_snapshot = dataclasses.replace(snapshot, runtime_identity=('wrong',))
        self.assertNotIn('sourceapp.Added', semantic._runtime_graph_maps(self.static, self.runtime)[1])
        self.static._runtime_member_snapshot = snapshot
        new = build_static_index(self.root)
        orm_members.invalidate_runtime_members(self.static, new, self.runtime, {'sourceapp.Added'})
        self.assertIs(new._runtime_member_snapshot.models, models)
        self.assertEqual(snapshot.invalidated_labels, frozenset())
        self.assertIs(self.static._runtime_member_snapshot, snapshot)
        object.__delattr__(snapshot, 'models')
        orm_members.invalidate_runtime_members(self.static, new, self.runtime, {'sourceapp.Added'})
        self.assertEqual(new._runtime_member_snapshot.models, {})

    def test_no_graph_change_retains_original_owner_and_new_owner_install_retires_previous_cache(self):
        self.assertIsNone(runtime_members.model_graph_delta(self.graph, self.graph))
        self.assertIs(runtime_members.apply_runtime_graph_delta(self.graph, None), self.graph)
        current_graph = dataclasses.replace(self.graph)
        current_runtime = dataclasses.replace(self.runtime, lookup_catalog={'current': True})
        cache = orm_members._MemberSurfaceCache()
        cache._set_owner(self.static, self.runtime, self.graph, clear=True)
        previous_token = cache._owner_token
        with mock.patch.object(orm_members, '_surface_cache', cache):
            orm_members.install_runtime_members(self.static, current_runtime, current_graph, self.snapshot({}),
                previous_runtime=self.runtime, previous_model_graph=self.graph)
        self.assertTrue(cache._matches_owner(self.static, current_runtime, current_graph))
        self.assertFalse(cache._matches_owner(self.static, self.runtime, self.graph))
        self.assertIsNot(cache._owner_token, previous_token)

    def test_graph_app_label_and_relation_target_use_runtime_label(self):
        from django_orm_intellisense.features.relation_targets import list_relation_targets
        node = self.graph.node_for_model('custom.Post')
        self.assertEqual(node.app_label, 'custom')
        target = next(item for item in list_relation_targets(model_graph=self.graph) if item['label'] == 'custom.Post')
        self.assertEqual(target['appLabel'], 'custom')
        stale = dataclasses.replace(node)
        object.__setattr__(stale, 'app_label', 'sourceapp')
        for protocol in range(pickle.HIGHEST_PROTOCOL + 1):
            self.assertEqual(pickle.loads(pickle.dumps(stale, protocol=protocol)), node)

    def test_incremental_graph_does_not_register_an_abstract_model_as_a_relation_target(self):
        source = self.root / 'sourceapp/models.py'
        source.write_text(source.read_text() + '\nclass Base(models.Model):\n'
            '    class Meta:\n        abstract = True\n')
        current = build_static_index(self.root)
        graph = semantic.rebuild_model_graph_for_labels(self.graph, old_static_index=self.static,
            static_index=current, runtime=self.runtime, affected_labels={'sourceapp.Base'})
        self.assertEqual(graph, semantic.build_model_graph(current, self.runtime))
        self.assertNotIn('sourceapp.Base', graph.nodes_by_label)

    def test_actual_empty_custom_nested_and_explicit_apps_survive_model_edit_delete_recreate(self):
        result = subprocess.run([sys.executable, '-m', 'benchmarks.check_runtime_model_refresh',
            '--output-dir', str(self.root / 'lifecycle-output')], capture_output=True, text=True, timeout=35)
        self.assertEqual(result.returncode, 0, result.stderr[-4000:])
        value = json.loads(result.stdout)
        self.assertEqual(value['daemonExitCode'], 0)
        self.assertEqual([row['models'] for row in value['rows']], [1, 4, 4, 1, 4])
        self.assertTrue(all(row['wholeSurfaceAndHealthEqual'] and row['reachableCatalogueEqual'] for row in value['rows']))
