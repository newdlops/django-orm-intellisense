"""P2 — terminal-type inference for lookup chains.

Verifies resolve_lookup_path emits a `terminalType` descriptor carrying the
inferred Python type of `A__B__C` chains, including transform chains like
`pubdate__year` (DateTimeField -> IntegerField). Uses settings_module=None so
the resolver exercises the STATIC fallback path (no live Django runtime),
which is exactly the degraded-registry window the static tables exist for.

Run:
    PYTHONPATH=python .e2e-django5/bin/python3 -m unittest tests.test_lookup_terminal_type -v
"""
from __future__ import annotations

import unittest
from unittest.mock import patch

from django_orm_intellisense.features import lookup_paths as lookup_paths_module
from django_orm_intellisense.features.field_types import (
    operand_python_type,
    python_type_for_kind,
    transform_output_kind,
)
from django_orm_intellisense.features.lookup_paths import resolve_lookup_path
from django_orm_intellisense.runtime.inspector import (
    RuntimeFieldSummary,
    RuntimeInspection,
    RuntimeModelSummary,
    RuntimeRelationSummary,
)
from django_orm_intellisense.semantic.graph import build_model_graph
from django_orm_intellisense.static_index.indexer import ModelCandidate, StaticIndex


def _build_graph():
    entry = ModelCandidate(
        app_label='blog', object_name='Entry', label='blog.Entry',
        module='blog.models', file_path='/x/blog/models.py',
        line=1, column=0, is_abstract=False, base_class_refs=(), source='static',
    )
    author = ModelCandidate(
        app_label='blog', object_name='Author', label='blog.Author',
        module='blog.models', file_path='/x/blog/models.py',
        line=20, column=0, is_abstract=False, base_class_refs=(), source='static',
    )
    static_index = StaticIndex(
        python_file_count=1, package_init_count=0, reexport_module_count=0,
        star_import_count=0, explicit_all_count=0, modules={},
        model_candidates=[entry, author],
    )
    entry_model = RuntimeModelSummary(
        label='blog.Entry', module='blog.models',
        field_names=['title', 'pubdate', 'author'],
        relation_names=['author'], reverse_relation_names=[],
        fields=[
            RuntimeFieldSummary(name='title', field_kind='CharField', is_relation=False, related_model_label=None, direction=None),
            RuntimeFieldSummary(name='pubdate', field_kind='DateTimeField', is_relation=False, related_model_label=None, direction=None),
            RuntimeFieldSummary(name='author', field_kind='ForeignKey', is_relation=True, related_model_label='blog.Author', direction='forward'),
        ],
        relations=[
            RuntimeRelationSummary(name='author', related_model_label='blog.Author', direction='forward', field_kind='ForeignKey'),
        ],
        manager_names=['objects'],
    )
    author_model = RuntimeModelSummary(
        label='blog.Author', module='blog.models',
        field_names=['name', 'age'], relation_names=[], reverse_relation_names=[],
        fields=[
            RuntimeFieldSummary(name='name', field_kind='CharField', is_relation=False, related_model_label=None, direction=None),
            RuntimeFieldSummary(name='age', field_kind='IntegerField', is_relation=False, related_model_label=None, direction=None),
        ],
        relations=[], manager_names=['objects'],
    )
    # settings_module=None -> _runtime_lookup_field returns None -> static path.
    runtime = RuntimeInspection(
        python_executable='/usr/bin/python3', django_importable=True,
        django_version='5.0', bootstrap_status='ready', settings_module=None,
        bootstrap_error=None, app_count=1, model_count=2, field_count=5,
        relation_count=1, reverse_relation_count=0, manager_count=2,
        model_catalog=[entry_model, author_model],
        model_preview=[entry_model, author_model],
    )
    return build_model_graph(static_index, runtime), runtime


class LookupTerminalTypeTest(unittest.TestCase):
    def setUp(self) -> None:
        self.graph, self.runtime = _build_graph()

    def _resolve(self, path: str, method: str = 'filter') -> dict:
        return resolve_lookup_path(
            model_graph=self.graph, runtime=self.runtime,
            base_model_label='blog.Entry', path=path, method=method,
        )

    def test_plain_scalar_terminal_type(self) -> None:
        r = self._resolve('title')
        self.assertTrue(r['resolved'])
        tt = r['terminalType']
        self.assertEqual(tt['outputFieldKind'], 'CharField')
        self.assertEqual(tt['pythonType'], 'str')
        self.assertFalse(tt['isTransformed'])

    def test_relation_traversal_terminal_type(self) -> None:
        # A__B__C where C is a real scalar field — the headline case.
        r = self._resolve('author__age')
        self.assertTrue(r['resolved'])
        tt = r['terminalType']
        self.assertEqual(tt['outputFieldKind'], 'IntegerField')
        self.assertEqual(tt['pythonType'], 'int')
        self.assertFalse(tt['isTransformed'])

    def test_transform_year(self) -> None:
        r = self._resolve('pubdate__year')
        self.assertTrue(r['resolved'])
        tt = r['terminalType']
        self.assertEqual(tt['outputFieldKind'], 'IntegerField')
        self.assertEqual(tt['pythonType'], 'int')
        self.assertTrue(tt['isTransformed'])
        # Target keeps the PRE-transform kind for go-to-definition.
        self.assertEqual(r['target']['fieldKind'], 'DateTimeField')

    def test_transform_then_operator(self) -> None:
        r = self._resolve('pubdate__year__gte')
        self.assertTrue(r['resolved'])
        tt = r['terminalType']
        self.assertEqual(tt['pythonType'], 'int')
        self.assertTrue(tt['isTransformed'])
        self.assertEqual(tt['lookupOperator'], 'gte')
        self.assertEqual(tt['operandPythonType'], 'int')

    def test_chained_transforms(self) -> None:
        r = self._resolve('pubdate__date__year')
        self.assertTrue(r['resolved'])
        self.assertEqual(r['terminalType']['outputFieldKind'], 'IntegerField')
        self.assertTrue(r['terminalType']['isTransformed'])

    def test_text_lookup_operand(self) -> None:
        r = self._resolve('title__icontains')
        self.assertTrue(r['resolved'])
        tt = r['terminalType']
        self.assertEqual(tt['pythonType'], 'str')
        self.assertEqual(tt['lookupOperator'], 'icontains')
        self.assertEqual(tt['operandPythonType'], 'str')

    def test_relation_terminal_has_no_terminal_type(self) -> None:
        r = self._resolve('author')
        self.assertTrue(r['resolved'])
        self.assertIsNone(r['terminalType'])

    def test_target_carries_python_type(self) -> None:
        r = self._resolve('author__age')
        self.assertEqual(r['target']['pythonType'], 'int')
        self.assertEqual(r['target']['outputFieldKind'], 'IntegerField')


class RegistryColdWindowTerminalTypeTest(unittest.TestCase):
    """P1.4 — terminal-type inference must survive the registry-build
    lock-timeout / cold window (log.txt:144 `registry-lock-timeout 1.0s`),
    where the runtime field registry is unavailable and get_runtime_field
    returns None. P2's static FIELD_TRANSFORMS fallback covers built-ins so a
    bail no longer loses built-in transform typing — this test locks that in."""

    def setUp(self) -> None:
        self.graph, _ = _build_graph()
        # Realistic cold window: Django bootstrapped (status 'ready') with a
        # real settings module, but the field registry build has not produced
        # entries yet, so get_runtime_field returns None for every field.
        self.runtime = RuntimeInspection(
            python_executable='/usr/bin/python3', django_importable=True,
            django_version='5.0', bootstrap_status='ready',
            settings_module='proj.settings', bootstrap_error=None,
            app_count=1, model_count=2, field_count=5,
            relation_count=1, reverse_relation_count=0, manager_count=2,
            model_catalog=[], model_preview=[],
        )

    def _resolve(self, path: str) -> dict:
        # Force the registry-unavailable path regardless of any global state.
        with patch.object(lookup_paths_module, 'get_runtime_field', return_value=None):
            return resolve_lookup_path(
                model_graph=self.graph, runtime=self.runtime,
                base_model_label='blog.Entry', path=path, method='filter',
            )

    def test_builtin_transform_typed_without_runtime(self) -> None:
        r = self._resolve('pubdate__year')
        self.assertTrue(r['resolved'])
        tt = r['terminalType']
        self.assertEqual(tt['outputFieldKind'], 'IntegerField')
        self.assertEqual(tt['pythonType'], 'int')
        self.assertTrue(tt['isTransformed'])

    def test_relation_scalar_typed_without_runtime(self) -> None:
        r = self._resolve('author__age')
        self.assertTrue(r['resolved'])
        self.assertEqual(r['terminalType']['pythonType'], 'int')


class FieldTypeHelpersTest(unittest.TestCase):
    def test_python_type_for_kind(self) -> None:
        self.assertEqual(python_type_for_kind('IntegerField'), 'int')
        self.assertEqual(python_type_for_kind('DateTimeField'), 'datetime.datetime')
        self.assertEqual(python_type_for_kind('DecimalField'), 'decimal.Decimal')
        self.assertEqual(python_type_for_kind('MoneyField'), 'Any')  # custom -> Any
        self.assertEqual(python_type_for_kind(None), 'Any')
        # Audit corrections (vs Django 5.2):
        self.assertEqual(python_type_for_kind('JSONField'), 'Any')  # any JSON value
        self.assertEqual(python_type_for_kind('GeneratedField'), 'Any')

    def test_transform_output_kind_applicability(self) -> None:
        self.assertEqual(transform_output_kind('year', 'DateTimeField'), 'IntegerField')
        self.assertEqual(transform_output_kind('date', 'DateTimeField'), 'DateField')
        self.assertIsNone(transform_output_kind('year', 'CharField'))  # not applicable
        self.assertIsNone(transform_output_kind('bogus', 'DateField'))  # unknown
        # String transforms are NOT Django built-ins — must not resolve.
        for name in ('lower', 'upper', 'length', 'trim', 'ltrim', 'rtrim'):
            self.assertIsNone(
                transform_output_kind(name, 'CharField'),
                f'{name} is not a built-in transform',
            )

    def test_operand_python_type(self) -> None:
        self.assertEqual(operand_python_type('isnull', 'int'), 'bool')
        self.assertEqual(operand_python_type('in', 'str'), 'list[str]')
        self.assertEqual(operand_python_type('range', 'datetime.date'), 'tuple[datetime.date, datetime.date]')
        self.assertEqual(operand_python_type('icontains', 'str'), 'str')
        self.assertEqual(operand_python_type('gte', 'int'), 'int')
        # Audit corrections (vs Django 5.2):
        # iexact is registered on non-text fields too -> operand is field type.
        self.assertEqual(operand_python_type('iexact', 'int'), 'int')
        self.assertEqual(operand_python_type('iexact', 'str'), 'str')
        # JSONField key lookups -> key name(s).
        self.assertEqual(operand_python_type('has_key', 'Any'), 'str')
        self.assertEqual(operand_python_type('has_keys', 'Any'), 'list[str]')
        self.assertEqual(operand_python_type('has_any_keys', 'Any'), 'list[str]')


if __name__ == '__main__':
    unittest.main()
