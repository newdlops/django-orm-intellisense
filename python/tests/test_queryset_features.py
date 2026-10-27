from __future__ import annotations

import dataclasses
import unittest

from django_orm_intellisense.features.django_builtins import django_builtin_available
from django_orm_intellisense.features.orm_members import _direct_resolve_member_item, _queryset_surface
from tests.test_lookup_terminal_type import _build_graph
from django_orm_intellisense.static_index.indexer import StaticIndex


class QuerysetFeatureTest(unittest.TestCase):
    def test_version_gate_and_property_metadata(self):
        _, runtime = _build_graph()
        static = StaticIndex(0, 0, 0, 0, 0, {}, [])
        for version, available in [('5.2.18', False), ('6.0.9', False), ('6.1.2', True), ('6.1rc1', True), ('2028', True), ('2028.3', True)]:
            state = dataclasses.replace(runtime, django_version=version)
            with self.subTest(version=version):
                self.assertEqual(django_builtin_available('totally_ordered', version), available)
                result = _direct_resolve_member_item(static_index=static, runtime=state,
                    model_label='blog.Entry', receiver_kind='queryset', name='totally_ordered', manager_name=None)
                self.assertEqual(result is not None, available)
                if result:
                    self.assertEqual(result.member_kind, 'property')
                    self.assertEqual(result.signature, ': bool')
                items = _queryset_surface(static_index=static, runtime=state, model_label='blog.Entry', manager_name=None)
                self.assertEqual(any(item.name == 'totally_ordered' for item in items), available)
                self.assertEqual(any(item.name == 'fetch_mode' for item in items), available)
                manager_property = _direct_resolve_member_item(static_index=static, runtime=state,
                    model_label='blog.Entry', receiver_kind='manager', name='totally_ordered', manager_name=None)
                self.assertIsNone(manager_property)


if __name__ == '__main__':
    unittest.main()
