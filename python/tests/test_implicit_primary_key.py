from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from django_orm_intellisense.features.lookup_paths import resolve_lookup_path
from django_orm_intellisense.runtime.inspector import (
    RuntimeFieldSummary,
    RuntimeInspection,
    RuntimeModelSummary,
    create_pending_runtime_inspection,
)
from django_orm_intellisense.semantic.graph import build_model_graph
from django_orm_intellisense.static_index.indexer import (
    ModelCandidate, StaticIndex, build_static_index, reindex_single_file,
)


def _static_index() -> StaticIndex:
    candidate = ModelCandidate(
        app_label='blog',
        object_name='Post',
        label='blog.Post',
        module='blog.models',
        file_path='/workspace/blog/models.py',
        line=10,
        column=0,
        is_abstract=False,
        base_class_refs=(),
        source='static',
    )
    return StaticIndex(
        python_file_count=1,
        package_init_count=0,
        reexport_module_count=0,
        star_import_count=0,
        explicit_all_count=0,
        modules={},
        model_candidates=[candidate],
    )


class ImplicitPrimaryKeyTest(unittest.TestCase):
    def source_graph(self, root: Path, source: str):
        (root / 'models.py').write_text(source)
        index = build_static_index(root)
        return index, build_model_graph(index, create_pending_runtime_inspection(None))

    def test_deferred_source_primary_key_matches_declared_type_without_inventing_id(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / 'models.py').write_text('from django.db import models\n'
                'class Post(models.Model):\n'
                '    key = models.UUIDField(primary_key=True)\n'
                '    class Meta:\n        app_label="blog"\n')
            index = build_static_index(root)
            runtime = create_pending_runtime_inspection(None)
            graph = build_model_graph(index, runtime)
            self.assertIsNone(graph.find_field('blog.Post', 'id'))
            self.assertEqual(graph.find_field('blog.Post', 'pk').field_kind, 'UUIDField')
            for path, resolved in [('key__exact', True), ('pk__exact', True), ('id__exact', False)]:
                result = resolve_lookup_path(model_graph=graph, runtime=runtime,
                    base_model_label='blog.Post', path=path, method='filter')
                self.assertEqual(result['resolved'], resolved, result)

    def test_deferred_literal_options_aliases_and_false_values(self) -> None:
        cases = [
            ('module_constant', 'PRIMARY=True\n', 'key = models.UUIDField(primary_key=PRIMARY)', 'key', 'UUIDField', False),
            ('class_constant', '', 'PRIMARY=True\n    key = models.UUIDField(primary_key=PRIMARY)', 'key', 'UUIDField', False),
            ('imported_constant', 'from flags import PRIMARY\n', 'key = models.UUIDField(primary_key=PRIMARY)', 'key', 'UUIDField', False),
            ('unpacked_options', 'OPTIONS={"primary_key": True}\n', 'key = models.UUIDField(**OPTIONS)', 'key', 'UUIDField', False),
            ('imported_options', 'from flags import OPTIONS\n', 'key = models.UUIDField(**OPTIONS)', 'key', 'UUIDField', False),
            ('default_callable_options', 'OPTIONS={"primary_key": True, "default": missing}\n', 'key = models.UUIDField(**OPTIONS)', 'key', 'UUIDField', False),
            ('annotated_explicit_id', '', 'id: object = models.SlugField(primary_key=True)', 'id', 'SlugField', True),
            ('false_option', '', 'key = models.UUIDField(primary_key=False)', 'id', 'BigAutoField', True),
            ('nested_option', '', 'key = models.UUIDField(default=unknown(primary_key=True))', 'id', 'BigAutoField', True),
        ]
        for name, prefix, declaration, primary_name, kind, has_id in cases:
            with self.subTest(name=name), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                (root / 'flags.py').write_text('PRIMARY=True\nOPTIONS={"primary_key": True}\n')
                _, graph = self.source_graph(root, 'from django.db import models\n' + prefix
                    + 'class Post(models.Model):\n    ' + declaration
                    + '\n    class Meta:\n        app_label="blog"\n')
                self.assertEqual(graph.find_field('blog.Post', 'pk').field_kind, kind)
                self.assertEqual(graph.find_field('blog.Post', primary_name).field_kind, kind)
                self.assertEqual(graph.find_field('blog.Post', 'id') is not None, has_id)

    def test_deferred_abstract_primary_key_inheritance_and_shadowing(self) -> None:
        for override in [False, True]:
            with self.subTest(override=override), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                (root / 'base.py').write_text('from django.db import models\n'
                    'class Base(models.Model):\n    key = models.UUIDField(primary_key=True)\n'
                    '    class Meta:\n        abstract=True\n        app_label="blog"\n')
                _, graph = self.source_graph(root, 'from django.db import models\nfrom base import Base\n'
                    'class Post(Base):\n'
                    + ('    key = models.UUIDField(primary_key=False)\n' if override else '')
                    + '    class Meta:\n        app_label="blog"\n')
                self.assertEqual(graph.find_field('blog.Post', 'pk').field_kind,
                    'BigAutoField' if override else 'UUIDField')
                self.assertEqual(graph.find_field('blog.Post', 'id') is not None, override)

    def test_deferred_source_key_change_does_not_reuse_old_option_or_ast(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            original = ('from django.db import models\nclass Post(models.Model):\n'
                '    key = models.UUIDField(primary_key=True )\n'
                '    class Meta:\n        app_label="blog"\n')
            index, old_graph = self.source_graph(root, original)
            path = root / 'models.py'
            stamp = path.stat()
            changed = original.replace('True ', 'False')
            self.assertEqual(len(changed), len(original))
            path.write_text(changed)
            os.utime(path, ns=(stamp.st_atime_ns, stamp.st_mtime_ns))
            changed_index, _, _ = reindex_single_file(root=root, file_path=path,
                existing_static_index=index)
            graph = build_model_graph(changed_index, create_pending_runtime_inspection(None))
            self.assertEqual(old_graph.find_field('blog.Post', 'pk').field_kind, 'UUIDField')
            self.assertEqual(graph.find_field('blog.Post', 'pk').field_kind, 'BigAutoField')
            self.assertIsNotNone(graph.find_field('blog.Post', 'id'))

    def test_deferred_key_options_survive_static_cache_and_old_graphs_are_rejected(self) -> None:
        from django_orm_intellisense.cache import store
        from django_orm_intellisense.discovery.workspace import snapshot_python_sources
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            index, graph = self.source_graph(root, 'from django.db import models\n'
                'class Post(models.Model):\n    key = models.UUIDField(primary_key=True)\n'
                '    class Meta:\n        app_label="blog"\n')
            snapshot = snapshot_python_sources(root)
            cache = root / 'owned-cache'
            with mock.patch.object(store, '_workspace_cache_dir', return_value=cache):
                store.save_static_index(root, snapshot, index)
                restored, kind = store.load_cached_static_index(root, snapshot)
                self.assertEqual(kind, 'full')
                restored_graph = build_model_graph(restored, create_pending_runtime_inspection(None))
                self.assertEqual(restored_graph.find_field('blog.Post', 'pk').field_kind, 'UUIDField')
                self.assertIsNone(restored_graph.find_field('blog.Post', 'id'))
                store.save_model_graph(root, snapshot.fingerprint, 'pending', graph)
                self.assertIsNotNone(store.load_cached_model_graph(root, snapshot.fingerprint,
                    'pending', static_index=restored))
                path = cache / store.MODEL_GRAPH_CACHE_NAME
                value = json.loads(path.read_text())
                value['metadata'].pop('modelGraphVersion')
                path.write_text(json.dumps(value))
                self.assertIsNone(store.load_cached_model_graph(root, snapshot.fingerprint,
                    'pending', static_index=restored))
                self.assertEqual(store.load_cached_static_index(root, snapshot)[1], 'full')

    def test_deferred_primary_key_does_not_import_django_or_execute_source(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / 'models.py').write_text('raise AssertionError("source must not execute")\n'
                'from django.db import models\nclass Post(models.Model):\n'
                '    key = models.UUIDField(primary_key=True)\n'
                '    class Meta:\n        app_label="blog"\n')
            code = ('import sys; from pathlib import Path; '
                'from django_orm_intellisense.static_index.indexer import build_static_index; '
                'from django_orm_intellisense.semantic.graph import build_model_graph; '
                'from django_orm_intellisense.runtime.inspector import create_pending_runtime_inspection; '
                'g=build_model_graph(build_static_index(Path(sys.argv[1])),create_pending_runtime_inspection(None)); '
                'assert g.find_field("blog.Post","pk").field_kind=="UUIDField"; '
                'assert g.find_field("blog.Post","id") is None; '
                'assert not any(n=="django" or n.startswith("django.") for n in sys.modules)')
            completed = subprocess.run([sys.executable, '-c', code, str(root)],
                capture_output=True, text=True)
            self.assertEqual(completed.returncode, 0, completed.stderr)

    def test_pending_runtime_resolves_implicit_id_and_pk_lookups(self) -> None:
        runtime = create_pending_runtime_inspection('project.settings')
        graph = build_model_graph(_static_index(), runtime)

        for path in ('id', 'id__in', 'pk', 'pk__exact'):
            with self.subTest(path=path):
                result = resolve_lookup_path(
                    model_graph=graph,
                    runtime=runtime,
                    base_model_label='blog.Post',
                    path=path,
                    method='filter',
                )
                self.assertTrue(result['resolved'], result)

        id_field = graph.find_field('blog.Post', 'id')
        pk_field = graph.find_field('blog.Post', 'pk')
        self.assertIsNotNone(id_field)
        self.assertIsNotNone(pk_field)
        assert id_field is not None
        assert pk_field is not None
        self.assertEqual(id_field.field_kind, 'BigAutoField')
        self.assertEqual(id_field.source, 'synthetic')
        self.assertEqual(pk_field.source, 'synthetic')
        self.assertEqual(id_field.file_path, '/workspace/blog/models.py')

    def test_ready_runtime_does_not_invent_id_for_custom_primary_key(self) -> None:
        runtime_model = RuntimeModelSummary(
            label='blog.Post',
            module='blog.models',
            field_names=['slug'],
            relation_names=[],
            reverse_relation_names=[],
            fields=[
                RuntimeFieldSummary(
                    name='slug',
                    field_kind='SlugField',
                    is_relation=False,
                    related_model_label=None,
                    direction=None,
                )
            ],
            relations=[],
            manager_names=['objects'],
        )
        runtime = RuntimeInspection(
            python_executable='/usr/bin/python3',
            django_importable=True,
            django_version='5.2',
            bootstrap_status='ready',
            settings_module=None,
            bootstrap_error=None,
            app_count=1,
            model_count=1,
            field_count=1,
            relation_count=0,
            reverse_relation_count=0,
            manager_count=1,
            model_catalog=[runtime_model],
            model_preview=[runtime_model],
        )

        graph = build_model_graph(_static_index(), runtime)

        self.assertIsNone(graph.find_field('blog.Post', 'id'))
        self.assertIsNotNone(graph.find_field('blog.Post', 'slug'))


if __name__ == '__main__':
    unittest.main()
