"""Candidate complete-field predicate agrees with the prior dictionary oracle."""
import copy
import dataclasses
import json

from benchmarks.graph_field_compare_candidate import field_matches
from django_orm_intellisense.cache import store
from django_orm_intellisense.static_index.indexer import FieldCandidate


field = FieldCandidate('blog.Post', 'title', '/한글/project/models.py', 3, 4, 'CharField', False,
    None, None, declared_model_label='blog.Post', related_name=None, related_query_name=None,
    source='static', constructor_fingerprint='fingerprint',
    imported_constants=(('limits.MAX', '20'),), declaration_module='blog.models')
cases = 0
for field in [field, dataclasses.replace(field, imported_constants=(), declaration_module=None),
              dataclasses.replace(field, is_relation=True, related_model_label='blog.Author',
                  relation_direction='forward', related_name='posts', related_query_name='post')]:
    expected = store._field_candidate_to_cache_dict(field)
    values = [None, '', 'different', 0, 1, False, True, 3.0, [], {}, ['limits.MAX', '20']]
    payloads = [copy.deepcopy(expected)]
    for key in expected:
        missing = copy.deepcopy(expected)
        missing.pop(key)
        payloads.append(missing)
        for value in values:
            changed = copy.deepcopy(expected)
            changed[key] = value
            payloads.append(changed)
    extra = copy.deepcopy(expected)
    extra['unknownFuture'] = {'mutable': []}
    payloads.append(extra)
    for payload in payloads:
        assert field_matches(field, payload) == (expected == payload), (field, payload)
        cases += 1
print(json.dumps({'candidateOnly': True, 'predicateCases': cases, 'previousDictOracleEqual': True,
    'allKeysMissingChangedFuture': True, 'importedConstantListsAndOptionalNulls': True,
    'sameNumericEqualityAsPrevious': True}))
