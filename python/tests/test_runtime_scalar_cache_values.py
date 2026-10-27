import copy
import dataclasses
import weakref
import unittest
from concurrent.futures import ThreadPoolExecutor
from unittest import mock

from django_orm_intellisense.runtime import inspector
from django_orm_intellisense.runtime.inspector import (
    RuntimeFieldSummary, RuntimeInspection, RuntimeModelSummary,
    create_pending_runtime_inspection,
)


class RuntimeScalarCacheValuesTests(unittest.TestCase):
    def payload(self):
        field = RuntimeFieldSummary('title', 'CharField', False, None, None)
        models = [RuntimeModelSummary(f'blog.Model{i}', 'blog.models', ['title'], [], [],
            [field], [], ['objects']) for i in range(2)]
        return dataclasses.replace(create_pending_runtime_inspection('project.settings'),
            django_importable=True, bootstrap_status='ready', model_count=2,
            field_count=2, manager_count=2, model_catalog=tuple(models),
            model_preview=list(models)).to_cache_dict()

    def test_equal_scalars_share_values_but_models_and_lists_have_distinct_owners(self):
        value = RuntimeInspection.from_cache_dict(self.payload())
        first, second = value.model_catalog
        self.assertIs(first.fields[0], second.fields[0])
        self.assertIs(first.fields[0], value.model_preview[0].fields[0])
        self.assertIsNot(first, second)
        self.assertIsNot(first.fields, second.fields)
        self.assertIsNot(first.fields, value.model_preview[0].fields)
        with self.assertRaises(dataclasses.FrozenInstanceError):
            first.fields[0].name = 'changed'
        first.fields.clear()
        first.field_names.clear()
        self.assertEqual(second.fields[0].name, 'title')
        self.assertEqual(value.model_preview[0].field_names, ['title'])

    def test_separate_reads_and_input_mutation_do_not_share_mutable_or_pool_owners(self):
        raw = self.payload()
        first = RuntimeInspection.from_cache_dict(raw)
        second = RuntimeInspection.from_cache_dict(raw)
        self.assertIsNot(first.model_catalog[0].fields[0], second.model_catalog[0].fields[0])
        raw['modelCatalog'][0]['fields'][0]['name'] = 'caller'
        raw['modelCatalog'][0]['fieldNames'].clear()
        self.assertEqual(first.model_catalog[0].fields[0].name, 'title')
        self.assertEqual(second.model_catalog[0].field_names, ['title'])

    def test_noncanonical_and_relation_records_keep_factory_coercion_without_sharing(self):
        changes = [dict(isRelation=0), dict(name=123), dict(fieldKind=None),
            dict(relatedModelLabel=''), dict(direction=''), dict(future={'nested': [1]}),
            dict(isRelation=True, relatedModelLabel='blog.Other', direction='forward'),
            dict(name='x' * 257), dict(fieldKind='X' * 257)]
        for change in changes:
            with self.subTest(change=change):
                raw = self.payload()
                for model in raw['modelCatalog']:
                    model['fields'][0].update(change)
                expected = [inspector._sanitize_runtime_model_summary(RuntimeModelSummary.from_dict(model)).to_dict()
                    for model in copy.deepcopy(raw['modelCatalog'])]
                result = RuntimeInspection.from_cache_dict(raw)
                self.assertEqual([m.to_dict() for m in result.model_catalog], expected)
                self.assertIsNot(result.model_catalog[0].fields[0], result.model_catalog[1].fields[0])

    def test_partial_and_malformed_records_keep_existing_error_order(self):
        for key in ['name', 'fieldKind', 'isRelation', 'relatedModelLabel', 'direction']:
            with self.subTest(key=key):
                raw = self.payload()
                raw['modelCatalog'][0]['fields'][0].pop(key)
                try:
                    expected = RuntimeModelSummary.from_dict(copy.deepcopy(raw['modelCatalog'][0]))
                except Exception as error:
                    with self.assertRaises(type(error)) as actual:
                        RuntimeInspection.from_cache_dict(raw)
                    self.assertEqual(actual.exception.args, error.args)
                else:
                    actual = RuntimeInspection.from_cache_dict(raw).model_catalog[0]
                    self.assertEqual(actual.to_dict(), expected.to_dict())
        raw = self.payload()
        raw['modelCatalog'][0]['fields'] = [dict(name='hidden+', fieldKind='CharField',
            isRelation=False, relatedModelLabel=None, direction=None), {'name': 'broken'}]
        with self.assertRaises(KeyError) as actual:
            RuntimeInspection.from_cache_dict(raw)
        self.assertEqual(actual.exception.args, ('fieldKind',))

    def test_owner_bearing_string_subclasses_do_not_enter_shared_values(self):
        class Owner:
            pass
        class Text(str):
            pass
        owner = Owner()
        reference = weakref.ref(owner)
        text = Text('title')
        text.owner = owner
        raw = self.payload()
        for model in raw['modelCatalog']:
            model['fields'][0]['name'] = text
        result = RuntimeInspection.from_cache_dict(raw)
        self.assertIs(type(result.model_catalog[0].fields[0].name), str)
        self.assertIsNot(result.model_catalog[0].fields[0], result.model_catalog[1].fields[0])
        del model, raw, text, owner
        self.assertIsNone(reference())

    def test_pool_bound_and_release_preserve_all_values(self):
        raw = self.payload()
        raw['modelPreview'] = []
        model = raw['modelCatalog'][0]
        model['fields'] = [dict(name=f'field{i}', fieldKind='CharField', isRelation=False,
            relatedModelLabel=None, direction=None) for i in range(4200)]
        pools, sizes = [], []
        original = inspector._runtime_scalar_field_from_cache
        def observed(payload, pool):
            value = original(payload, pool)
            if not pools:
                pools.append(pool)
            sizes.append(len(pool))
            return value
        with mock.patch.object(inspector, '_runtime_scalar_field_from_cache', observed):
            result = RuntimeInspection.from_cache_dict(raw)
        self.assertEqual(max(sizes), 4096)
        self.assertEqual(pools, [{}])
        self.assertEqual(len(result.model_catalog[0].fields), 4200)
        self.assertEqual(result.model_catalog[0].fields[-1].name, 'field4199')

    def test_pool_clears_on_error(self):
        raw = self.payload()
        raw['modelCatalog'][0]['fields'].append({'name': 'broken'})
        pools = []
        original = inspector._runtime_scalar_field_from_cache
        def observed(payload, pool):
            pools.append(pool)
            return original(payload, pool)
        with mock.patch.object(inspector, '_runtime_scalar_field_from_cache', observed), self.assertRaises(KeyError):
            RuntimeInspection.from_cache_dict(raw)
        self.assertTrue(pools)
        self.assertTrue(all(pool == {} for pool in pools))

    def test_parallel_readers_keep_separate_read_local_values(self):
        raw = self.payload()
        with ThreadPoolExecutor(max_workers=2) as pool:
            first, second = list(pool.map(RuntimeInspection.from_cache_dict, [raw, raw]))
        self.assertIs(first.model_catalog[0].fields[0], first.model_catalog[1].fields[0])
        self.assertIsNot(first.model_catalog[0].fields[0], second.model_catalog[0].fields[0])


if __name__ == '__main__':
    unittest.main()
