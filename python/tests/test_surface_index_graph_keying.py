"""Pins option C step 3: ``build_surface_index`` must key the outer dict by
the graph (runtime/Django) label, not by ``candidate.label``.

Captain's `zuzu.db.models.company.company.Company` is the canonical case:
    candidate.label = 'zuzu.Company'  (module-segment heuristic)
    graph.label     = 'db.Company'    (Django AppConfig.label='db')

The TS extension host receives `db.Company` from Pylance and looks the
surface entry up with that label. As long as the surface dict is keyed by
`candidate.label`, the lookup misses 100% of the time for every model in
captain's `db` app — which is what the production `[surface:gap]` log
showed (94 workspace models, including `db.Company`, in `graph-only`).

This test reproduces the captain split-label scenario via hand-built
``StaticIndex`` / ``RuntimeInspection`` (no Django boot required) and
asserts the surface dict carries the **graph** label as its key.

Run with:
    PYTHONPATH=python python3 -m unittest python.tests.test_surface_index_graph_keying -v
"""
from __future__ import annotations

import unittest

from django_orm_intellisense.features.orm_members import build_surface_index
from django_orm_intellisense.runtime.inspector import (
    RuntimeFieldSummary,
    RuntimeInspection,
    RuntimeModelSummary,
)
from django_orm_intellisense.semantic.graph import build_model_graph
from django_orm_intellisense.static_index.indexer import ModelCandidate, StaticIndex


CAPTAIN_MODULE = 'zuzu.db.models.company.company'
CAPTAIN_FILE_PATH = '/captain/zuzu/db/models/company/company.py'
STATIC_LABEL = 'zuzu.Company'   # AST heuristic
RUNTIME_LABEL = 'db.Company'    # Django AppConfig.label='db'


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


class CaptainSurfaceIndexKeyingTest(unittest.TestCase):
    def test_surface_index_is_keyed_by_graph_label_for_split_app_label_models(
        self,
    ) -> None:
        static_index, runtime = _build_captain_inputs()
        model_graph = build_model_graph(static_index, runtime)

        surface = build_surface_index(static_index, runtime, model_graph)

        self.assertIn(
            RUNTIME_LABEL, surface,
            f'TS extension host queries by the Django/Pylance label '
            f'({RUNTIME_LABEL!r}); the surface dict MUST be keyed by it. '
            f'Got keys: {sorted(surface)}',
        )
        self.assertNotIn(
            STATIC_LABEL, surface,
            f'Surface dict must NOT carry the AST heuristic label '
            f'({STATIC_LABEL!r}). Surfacing both labels duplicates the '
            f'model and is exactly the bug option C eliminates.',
        )

    def test_surface_entry_contains_a_model_class_objects_manager(self) -> None:
        # Smoke check: the entry under the graph label should be a usable
        # surface entry (not an empty dict), with at minimum the
        # auto-injected `objects` manager that build_surface_index
        # guarantees for every concrete model.
        static_index, runtime = _build_captain_inputs()
        model_graph = build_model_graph(static_index, runtime)

        surface = build_surface_index(static_index, runtime, model_graph)
        entry = surface[RUNTIME_LABEL]
        model_class_entry = entry.get('model_class', {})
        self.assertIn(
            'objects', model_class_entry,
            'every concrete model must register `objects` on the '
            'model_class receiver — used by `<Model>.objects.filter(...)`.',
        )

    def test_surface_built_without_graph_falls_back_to_candidate_label(
        self,
    ) -> None:
        # Graph-less call path (e.g. very early boot before runtime introspection
        # finishes) must still produce a usable surface keyed by candidate.label.
        # Otherwise we'd regress workspaces whose AppConfig.label matches the
        # module segment (the common case).
        static_index, runtime = _build_captain_inputs()
        surface = build_surface_index(static_index, runtime, model_graph=None)
        self.assertIn(STATIC_LABEL, surface)


if __name__ == '__main__':
    unittest.main()
