"""Reproduces the captain `db.Company` regression and pins option C's design.

Captain's `zuzu/db/models/company/company.py`:

    from django.db import models

    class Company(  # type: ignore[django-manager-missing]
        TimestampedModel,
        SoftDeletableModel,
    ):
        ...

is registered by Django under `INSTALLED_APPS` via an `AppConfig` whose
`label = 'db'` (not the module's first path segment `zuzu`). So:

    ModelGraph node label: `db.Company`           ← Django runtime truth
    ModelCandidate label:  `zuzu.Company`         ← indexer heuristic
                                                    (`module.split('.', 1)[0]`)

The divergence is intentional under option C: the indexer keeps its
module-segment heuristic, and the ModelGraph linker bridges static→runtime
by joining ModelCandidate ↔ runtime model on (module, object_name). Downstream
consumers should key off the graph label, not the candidate label.

This file pins both halves of that design:
  * `CaptainCompanyAppLabelTest`     — indexer keeps emitting `zuzu.Company`.
  * `CaptainModelGraphLinkerTest`    — `build_model_graph` produces a single
                                      node keyed at `db.Company` whose
                                      `model_candidate.label == 'zuzu.Company'`.

Run with:
    PYTHONPATH=python python3 -m unittest python.tests.test_indexer_app_label -v
"""
from __future__ import annotations

import ast
import unittest
from pathlib import Path

from django_orm_intellisense.runtime.inspector import (
    RuntimeFieldSummary,
    RuntimeInspection,
    RuntimeModelSummary,
)
from django_orm_intellisense.semantic.graph import build_model_graph
from django_orm_intellisense.static_index.indexer import (
    ModelCandidate,
    StaticIndex,
    _model_candidate_from_class,
)


CAPTAIN_COMPANY_SOURCE = """
from django.db import models

class Company(  # type: ignore[django-manager-missing]
    TimestampedModel,
    SoftDeletableModel,
):
    pass
"""

class CaptainCompanyAppLabelTest(unittest.TestCase):
    def _candidate_from_source(
        self,
        source: str,
        *,
        module_name: str,
        file_path: str,
    ) -> object:
        tree = ast.parse(source)
        class_nodes = [n for n in tree.body if isinstance(n, ast.ClassDef)]
        self.assertEqual(
            len(class_nodes), 1,
            f'fixture should parse exactly one class — got {len(class_nodes)}',
        )
        return _model_candidate_from_class(
            python_file=Path(file_path),
            module_name=module_name,
            node=class_nodes[0],
        )

    def test_captain_indexer_label_uses_module_segment_heuristic(self) -> None:
        # Captain pattern: module path starts with `zuzu.db.` but the Django
        # `AppConfig.label` is `db`. Without a `class Meta: app_label = 'db'`
        # the indexer falls back to `module_name.split('.', 1)[0]` and emits
        # `zuzu.Company`. This divergence from the runtime label `db.Company`
        # is intentional under option C (graph layer bridges the gap) — we
        # pin the heuristic here so future indexer changes that try to
        # consult runtime app-label info trip this test and force an
        # architectural decision rather than silently shifting the join
        # semantics.
        candidate = self._candidate_from_source(
            CAPTAIN_COMPANY_SOURCE,
            module_name='zuzu.db.models.company.company',
            file_path='/captain/zuzu/db/models/company/company.py',
        )
        self.assertEqual(candidate.label, 'zuzu.Company')
        self.assertEqual(candidate.app_label, 'zuzu')
        self.assertEqual(candidate.module, 'zuzu.db.models.company.company')
        self.assertEqual(candidate.object_name, 'Company')

    def test_multi_line_class_def_with_inline_comment_parses(self) -> None:
        # Sanity check: ensure the AST parses captain's class header shape
        # (`class Company(  # comment` on one line, bases on subsequent lines)
        # — the indexer's pattern matching mustn't be confused by it. This
        # test passes today because Python's AST handles it transparently;
        # it stays as a regression guard against future indexer changes
        # that might require single-line class headers.
        candidate = self._candidate_from_source(
            CAPTAIN_COMPANY_SOURCE,
            module_name='zuzu.db.models.company.company',
            file_path='/captain/zuzu/db/models/company/company.py',
        )
        self.assertEqual(candidate.object_name, 'Company')
        self.assertEqual(
            candidate.base_class_refs,
            ('TimestampedModel', 'SoftDeletableModel'),
            'AST should extract both base classes despite the inline '
            'comment between `(` and the bases.',
        )

    def test_explicit_meta_app_label_overrides_module_heuristic(self) -> None:
        # When Meta.app_label is explicitly set, the indexer should honor
        # it — this is the existing happy path that already works for
        # captain's `db.RegistrationFormText*` models (candidate=yes).
        source = """
from django.db import models

class WidgetWithMeta(models.Model):
    class Meta:
        app_label = 'inventory'
"""
        candidate = self._candidate_from_source(
            source,
            module_name='zuzu.warehouse.widget',
            file_path='/captain/zuzu/warehouse/widget.py',
        )
        self.assertEqual(
            candidate.label, 'inventory.WidgetWithMeta',
            'explicit Meta.app_label must win over module-segment heuristic',
        )


class CaptainModelGraphLinkerTest(unittest.TestCase):
    """Option C verification: even with the wrong candidate.label, the ModelGraph
    linker must produce a node keyed at the *runtime* label (Django's truth)
    and the linked node.model_candidate must point at the AST candidate that
    shares the (module, object_name) pair.

    This is the architectural premise of the captain fix — the linker bridges
    the static→runtime label divergence so downstream surfaces can key off a
    single canonical label.
    """

    CAPTAIN_MODULE = 'zuzu.db.models.company.company'
    CAPTAIN_FILE_PATH = '/captain/zuzu/db/models/company/company.py'
    STATIC_LABEL = 'zuzu.Company'   # AST heuristic produces this (wrong)
    RUNTIME_LABEL = 'db.Company'    # Django AppConfig.label='db' produces this

    def _build_captain_inputs(self) -> tuple[StaticIndex, RuntimeInspection]:
        candidate = ModelCandidate(
            app_label='zuzu',
            object_name='Company',
            label=self.STATIC_LABEL,
            module=self.CAPTAIN_MODULE,
            file_path=self.CAPTAIN_FILE_PATH,
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
            label=self.RUNTIME_LABEL,
            module=self.CAPTAIN_MODULE,
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

    def test_graph_node_keyed_at_runtime_label_not_static_label(self) -> None:
        # Step 1 verification: linker joins on (module, object_name) and
        # selects the runtime label as the canonical graph key.
        static_index, runtime = self._build_captain_inputs()
        graph = build_model_graph(static_index, runtime)

        self.assertIn(
            self.RUNTIME_LABEL, graph.nodes_by_label,
            f'graph must expose the model under Django runtime label '
            f'{self.RUNTIME_LABEL!r} (got keys: {sorted(graph.nodes_by_label)})',
        )
        self.assertNotIn(
            self.STATIC_LABEL, graph.nodes_by_label,
            f'graph must NOT expose the model under the AST heuristic label '
            f'{self.STATIC_LABEL!r} — that would surface the same model twice '
            f'and is exactly the divergence we are eliminating.',
        )

    def test_graph_node_links_back_to_static_candidate_via_module_and_name(
        self,
    ) -> None:
        # Step 2 verification: the runtime-keyed node carries the AST
        # candidate (with its wrong label) so downstream consumers can still
        # read field/line/column information from the static source.
        static_index, runtime = self._build_captain_inputs()
        graph = build_model_graph(static_index, runtime)

        node = graph.nodes_by_label[self.RUNTIME_LABEL]
        self.assertIsNotNone(
            node.model_candidate,
            'graph node must reference the AST ModelCandidate even when the '
            'candidate.label disagrees with the graph label — the linker '
            'looks the candidate up by (module, object_name).',
        )
        self.assertEqual(node.model_candidate.label, self.STATIC_LABEL)
        self.assertEqual(node.model_candidate.module, self.CAPTAIN_MODULE)
        self.assertEqual(node.module, self.CAPTAIN_MODULE)
        self.assertEqual(node.object_name, 'Company')
        # Runtime model is also attached so callers can prefer runtime truth.
        self.assertIsNotNone(node.runtime_model)
        self.assertEqual(node.runtime_model.label, self.RUNTIME_LABEL)


if __name__ == '__main__':
    unittest.main()
