from __future__ import annotations

import unittest

from django_orm_intellisense.features.lookup_paths import resolve_lookup_path
from django_orm_intellisense.runtime.inspector import (
    RuntimeFieldSummary,
    RuntimeInspection,
    RuntimeModelSummary,
    create_pending_runtime_inspection,
)
from django_orm_intellisense.semantic.graph import build_model_graph
from django_orm_intellisense.static_index.indexer import ModelCandidate, StaticIndex


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
