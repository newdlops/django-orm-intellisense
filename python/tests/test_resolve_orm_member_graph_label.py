"""Option C step 4: ``resolve_orm_member`` / ``resolve_orm_member_chain``
must accept the **graph (runtime) label** that TS sends back to the daemon
and return labels in the same space. The split-label case (captain pattern
where candidate.label='zuzu.Company' but graph.label='db.Company') must
resolve transparently through the (module, object_name) bridge.

Without this, a TS request like ``resolve_orm_member(modelLabel='db.Company',
receiverKind='model_class', name='objects')`` would dead-end because the
internal resolver path keys off ``candidate.label`` and would call
``find_model_candidate('db.Company')`` → None.

Run with:
    PYTHONPATH=python python3 -m unittest python.tests.test_resolve_orm_member_graph_label -v
"""
from __future__ import annotations

import unittest

from django_orm_intellisense.features.orm_members import (
    prebuild_member_surface_cache,
    resolve_orm_member,
    resolve_orm_member_chain,
)
from django_orm_intellisense.runtime.inspector import (
    RuntimeFieldSummary,
    RuntimeInspection,
    RuntimeModelSummary,
)
from django_orm_intellisense.semantic.graph import build_model_graph
from django_orm_intellisense.static_index.indexer import ModelCandidate, StaticIndex


CAPTAIN_MODULE = 'zuzu.db.models.company.company'
CAPTAIN_FILE_PATH = '/captain/zuzu/db/models/company/company.py'
STATIC_LABEL = 'zuzu.Company'
RUNTIME_LABEL = 'db.Company'


def _build_captain_inputs() -> tuple[StaticIndex, RuntimeInspection]:
    candidate = ModelCandidate(
        app_label='zuzu',
        object_name='Company',
        label=STATIC_LABEL,
        module=CAPTAIN_MODULE,
        file_path=CAPTAIN_FILE_PATH,
        line=1,
        column=0,
        is_abstract=False,
        base_class_refs=('TimestampedModel', 'SoftDeletableModel'),
        source='static',
    )
    static_index = StaticIndex(
        python_file_count=1,
        package_init_count=0,
        reexport_module_count=0,
        star_import_count=0,
        explicit_all_count=0,
        modules={},
        model_candidates=[candidate],
    )
    runtime_model = RuntimeModelSummary(
        label=RUNTIME_LABEL,
        module=CAPTAIN_MODULE,
        field_names=['id'],
        relation_names=[],
        reverse_relation_names=[],
        fields=[
            RuntimeFieldSummary(
                name='id',
                field_kind='AutoField',
                is_relation=False,
                related_model_label=None,
                direction=None,
            ),
        ],
        relations=[],
        manager_names=['objects'],
    )
    runtime = RuntimeInspection(
        python_executable='/usr/bin/python3',
        django_importable=True,
        django_version='5.0',
        bootstrap_status='ready',
        settings_module='zuzu.settings',
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
    return static_index, runtime


class CaptainResolveOrmMemberWithGraphLabelTest(unittest.TestCase):
    def setUp(self) -> None:
        self.static_index, self.runtime = _build_captain_inputs()
        self.model_graph = build_model_graph(self.static_index, self.runtime)
        # Prebuild populates the surface cache so resolve_orm_member's
        # cache-lookup path is exercised, matching production boot order.
        prebuild_member_surface_cache(
            self.static_index, self.runtime, self.model_graph,
        )

    def test_resolve_objects_on_model_class_with_graph_label(self) -> None:
        # `Company.objects` — TS holds `db.Company`, asks the daemon to
        # resolve `objects`. Must return a manager item whose modelLabel /
        # returnModelLabel are graph-labeled so TS can chain further.
        result = resolve_orm_member(
            static_index=self.static_index,
            runtime=self.runtime,
            model_graph=self.model_graph,
            model_label=RUNTIME_LABEL,
            receiver_kind='model_class',
            name='objects',
        )
        self.assertTrue(
            result.get('resolved'),
            f'resolve_orm_member must succeed when called with the graph '
            f'label {RUNTIME_LABEL!r}; got {result!r}',
        )
        item = result['item']
        self.assertEqual(item['name'], 'objects')
        self.assertEqual(item['returnKind'], 'manager')
        self.assertEqual(
            item['modelLabel'], RUNTIME_LABEL,
            'returned modelLabel must be in the graph-label space — TS '
            'uses it to key further surfaceIndex lookups.',
        )
        self.assertEqual(item['returnModelLabel'], RUNTIME_LABEL)

    def test_resolve_id_field_on_instance_with_graph_label(self) -> None:
        # Field resolution via the graph: db.Company has the `id` field on
        # the runtime side. Direct-resolve path should pick it up after the
        # graph-→-static label normalization at the entry point.
        result = resolve_orm_member(
            static_index=self.static_index,
            runtime=self.runtime,
            model_graph=self.model_graph,
            model_label=RUNTIME_LABEL,
            receiver_kind='instance',
            name='id',
        )
        self.assertTrue(result.get('resolved'), f'got {result!r}')
        self.assertEqual(result['item']['name'], 'id')
        self.assertEqual(result['item']['modelLabel'], RUNTIME_LABEL)

    def test_resolve_chain_company_objects_filter_returns_graph_label(self) -> None:
        # `Company.objects.filter(...)` — two-hop chain. Final modelLabel
        # must be in the graph-label space so the diagnostic engine validates
        # the lookup keyword arguments against the right model's fields.
        result = resolve_orm_member_chain(
            static_index=self.static_index,
            runtime=self.runtime,
            model_graph=self.model_graph,
            model_label=RUNTIME_LABEL,
            receiver_kind='model_class',
            chain=['objects', 'filter'],
        )
        self.assertTrue(result.get('resolved'), f'got {result!r}')
        self.assertEqual(
            result['modelLabel'], RUNTIME_LABEL,
            'chain result label must round-trip in graph-label space.',
        )
        self.assertEqual(result['receiverKind'], 'queryset')


if __name__ == '__main__':
    unittest.main()
