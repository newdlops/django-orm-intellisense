"""High-volume immutable records keep value/cache/process contracts in slots."""
import copy
import dataclasses
import pickle
import tempfile
import unittest
from pathlib import Path

from django_orm_intellisense.cache import store
from django_orm_intellisense.discovery.workspace import snapshot_python_sources
from django_orm_intellisense.runtime.inspector import (
    RuntimeFieldSummary, RuntimeRelationSummary, create_pending_runtime_inspection)
from django_orm_intellisense.semantic.graph import build_model_graph
from django_orm_intellisense.static_index.indexer import build_static_index, reindex_single_file


class CompactRecordTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='djls-compact-records-')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        app = self.root / 'blog'
        app.mkdir()
        (app / '__init__.py').write_text('')
        self.source = app / 'models.py'
        self.source.write_text('from django.db import models\n'
            'class Author(models.Model):\n    name=models.CharField(max_length=40)\n'
            'class Post(models.Model):\n    title=models.CharField(max_length=100)\n'
            '    author=models.ForeignKey("blog.Author", on_delete=models.CASCADE, related_name="posts")\n')
        self.snapshot = snapshot_python_sources(self.root)
        self.index = build_static_index(self.root, self.snapshot.files)
        self.runtime = create_pending_runtime_inspection(None)
        self.graph = build_model_graph(self.index, self.runtime)

    def records(self):
        module = self.index.modules['blog.models']
        return [self.snapshot.entries[0], *module.symbol_definitions.values(),
            *module.model_candidates, *module.pending_fields, *module.import_bindings,
            *self.index.fields, *self.graph.nodes_by_label.values(),
            *(edge for edges in self.graph.edges_by_source_label.values() for edge in edges),
            RuntimeFieldSummary('title', 'CharField', False, None, None),
            RuntimeRelationSummary('author', 'blog.Author', 'forward', 'ForeignKey')]

    def test_compact_records_pickle_copy_and_field_enumeration_preserve_values(self):
        values = self.records()
        self.assertEqual(len({type(value).__name__ for value in values}), 10)
        for value in values:
            with self.subTest(record=type(value).__name__):
                self.assertFalse(hasattr(value, '__dict__'))
                for restored in [copy.copy(value), copy.deepcopy(value),
                                 pickle.loads(pickle.dumps(value, protocol=pickle.HIGHEST_PROTOCOL))]:
                    self.assertEqual(restored, value)
                    self.assertEqual(dataclasses.asdict(restored), dataclasses.asdict(value))
                field = dataclasses.fields(value)[0].name
                with self.assertRaises(dataclasses.FrozenInstanceError):
                    setattr(value, field, getattr(value, field))
                replacement = dataclasses.replace(value, **{field: getattr(value, field)})
                self.assertEqual(replacement, value)
                self.assertIsNot(replacement, value)

    def test_pickle_protocols_previous_list_state_and_shared_record_identity(self):
        for value in self.records():
            with self.subTest(record=type(value).__name__):
                fields = dataclasses.fields(value)
                state = tuple(getattr(value, field.name) for field in fields)
                self.assertEqual(value.__getstate__(), state)
                for protocol in range(pickle.HIGHEST_PROTOCOL + 1):
                    restored = pickle.loads(pickle.dumps([value, value], protocol=protocol))
                    self.assertEqual(restored[0], value)
                    self.assertIs(restored[0], restored[1])
                # Frozen slot dataclasses previously serialized a list. The
                # direct tuple unpack accepts that old in-process state too.
                old_state = type(value).__new__(type(value))
                old_state.__setstate__(list(state))
                self.assertEqual(old_state, value)
                self.assertEqual(dataclasses.asdict(old_state), dataclasses.asdict(value))

    def test_node_pickle_restores_aliased_mutable_state_without_calling_init(self):
        from django_orm_intellisense.runtime.inspector import RuntimeModelSummary
        node = self.graph.nodes_by_label['blog.Post']
        summary = RuntimeModelSummary('blog.Post', 'blog.models', [], [], [], [], [], [])
        node = dataclasses.replace(node, runtime_model=summary)
        # This guards pickle graph reconstruction semantics rather than a
        # supported Django name value. State loading must handle aliases and
        # recursive object graphs as the previous NEWOBJ/state path did.
        summary.field_names.append(node)
        restored = pickle.loads(pickle.dumps(node, protocol=pickle.HIGHEST_PROTOCOL))
        self.assertIs(restored.runtime_model.field_names[0], restored)
        self.assertEqual(restored.label, node.label)

    def test_complete_index_snapshot_and_graph_cache_pickle_roundtrips(self):
        restored_index = type(self.index).from_cache_dict(self.index.to_cache_dict())
        self.assertEqual(restored_index.to_cache_dict(), self.index.to_cache_dict())
        self.assertEqual(restored_index.fields, self.index.fields)
        snapshot = type(self.snapshot).from_cache_dict(self.snapshot.to_cache_dict())
        self.assertEqual(snapshot.to_cache_dict(), self.snapshot.to_cache_dict())
        wire = store._model_graph_to_cache_dict(self.graph)
        graph = store._model_graph_from_cache_dict(wire)
        self.assertEqual(store._model_graph_to_cache_dict(graph), wire)
        for value in [self.snapshot, self.index, self.graph]:
            restored = pickle.loads(pickle.dumps(value, protocol=pickle.HIGHEST_PROTOCOL))
            if value is self.index:
                self.assertEqual(restored.to_cache_dict(), self.index.to_cache_dict())
                self.assertEqual(restored.fields, self.index.fields)
            else:
                self.assertEqual(restored, value)

    def test_field_edit_replacement_preserves_previous_records_and_fresh_index(self):
        previous = self.index.find_field('blog.Post', 'title')
        old_wire = self.index.to_cache_dict()
        self.source.write_text(self.source.read_text().replace(
            'title=models.CharField(max_length=100)', 'title=models.DateField()'))
        changed, old_labels, new_labels = reindex_single_file(self.root, self.source, self.index)
        self.assertEqual(old_labels, new_labels)
        self.assertEqual(changed.find_field('blog.Post', 'title').field_kind, 'DateField')
        self.assertEqual(previous.field_kind, 'CharField')
        self.assertEqual(self.index.to_cache_dict(), old_wire)
        fresh = build_static_index(self.root)
        self.assertEqual(changed.to_cache_dict(), fresh.to_cache_dict())
        self.assertEqual(changed.fields, fresh.fields)


if __name__ == '__main__':
    unittest.main()
