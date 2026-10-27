import dataclasses
import unittest
from unittest import mock

from django_orm_intellisense.features import relation_targets
from django_orm_intellisense.runtime.inspector import RuntimeModelSummary
from django_orm_intellisense.semantic.graph import ModelGraph, ModelGraphNode
from django_orm_intellisense.static_index.indexer import FieldCandidate


def node(label, *, module='blog.models', runtime=False):
    name = label.rsplit('.', 1)[-1]
    summary = RuntimeModelSummary(label, module, [f'field_{number}' for number in range(12)],
        ['author'], ['children'], [], [], ['objects']) if runtime else None
    return ModelGraphNode(label, label.split('.')[0], name, module, f'{module}.{name}',
        f'/{module.replace(".", "/")}.py', 3, 4, tuple(f'field_{number}' for number in range(12)),
        ('author',), ('children',), ('objects', 'custom'), None, summary)


def graph(nodes):
    return ModelGraph({value.label: {f'field_{number}': FieldCandidate(value.label, f'field_{number}',
        value.file_path, 3, number, 'CharField', False, None, None) for number in range(12)} for value in nodes},
        {value.label: value for value in nodes}, {}, {}, {})


def previous_list(owner, prefix):
    values = [relation_targets._target_dict(owner, value) for value in owner.nodes_by_label.values()]
    normalized = (prefix or '').strip().lower()
    if normalized:
        values = [value for value in values if relation_targets._matches_prefix(value, normalized)]
    values.sort(key=lambda value: (0 if value['source'] == 'runtime' else 1, str(value['label']).lower()))
    return values


class RelationTargetPrefixTests(unittest.TestCase):
    def test_prefix_constructs_only_matching_target_metadata(self):
        owner = graph([node('blog.Post'), node('other.Other', module='external.models', runtime=True)])
        original = relation_targets._target_dict
        calls = []

        def target(model_graph, value):
            calls.append(value.label)
            if value.label != 'blog.Post':
                raise AssertionError('Unmatched relation target metadata constructed')
            return original(model_graph, value)

        with mock.patch.object(relation_targets, '_target_dict', target):
            result = relation_targets.list_relation_targets(model_graph=owner, prefix=' POST ')
        self.assertEqual(calls, ['blog.Post'])
        self.assertEqual(result, [original(owner, owner.nodes_by_label['blog.Post'])])

    def test_label_name_module_import_unicode_empty_and_runtime_order_match_previous_values(self):
        values = [node('blog.Post'), node('other.Post', runtime=True), node('blog.한글', module='blog.special'),
            node('aaa.Aaa'), node('zoo.Zzz', module='blog.models', runtime=True)]
        owner = graph(values)
        for prefix in [None, '', ' ', 'BLOG.', 'post', 'blog.special', 'blog.models.Post', '한글', 'missing']:
            with self.subTest(prefix=prefix):
                self.assertEqual(relation_targets.list_relation_targets(model_graph=owner, prefix=prefix),
                    previous_list(owner, prefix))
        # Returned metadata belongs to each result, never mutable graph rows.
        first = relation_targets.list_relation_targets(model_graph=owner, prefix='other.Post')
        first[0]['fieldNames'].append('caller mutation')
        self.assertNotIn('caller mutation', values[1].runtime_model.field_names)
        self.assertEqual(len(first[0]['fieldNames']), 9)
        self.assertEqual(len(relation_targets.list_relation_targets(model_graph=owner, prefix='other.Post')[0]['fieldNames']), 8)

    def test_prefix_uses_current_graph_after_model_replacement_or_retirement(self):
        original = node('blog.Post')
        owner = graph([original, node('blog.Other')])
        before = relation_targets.list_relation_targets(model_graph=owner, prefix='Post')
        changed = dataclasses.replace(original, module='updated.models', import_path='updated.models.Post', line=99)
        current = graph([changed])
        self.assertEqual(relation_targets.list_relation_targets(model_graph=current, prefix='updated.models.Post')[0]['line'], 99)
        self.assertEqual(relation_targets.list_relation_targets(model_graph=current, prefix='Other'), [])
        self.assertEqual(before, relation_targets.list_relation_targets(model_graph=owner, prefix='Post'))


if __name__ == '__main__':
    unittest.main()
