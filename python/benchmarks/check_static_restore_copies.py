"""Candidate readonly wire hydration, malformed records and dict subclasses."""
import copy
import json
import tempfile
from pathlib import Path

from benchmarks.static_restore_copy_candidate import candidate_module
from django_orm_intellisense.static_index import indexer


candidate = candidate_module()
with tempfile.TemporaryDirectory(prefix='djls-restore-copy-contracts-') as temporary:
    root = Path(temporary).resolve()
    (root / 'models.py').write_text('from django.db import models\n'
        'class Base(models.Model):\n    value=models.CharField()\n'
        '    class Meta:\n        abstract=True\n'
        'class Post(Base):\n    owner=models.ForeignKey("self",on_delete=models.CASCADE)\n')
    initial = indexer.build_static_index(root)
    wire = initial.to_cache_dict()
    cases = [copy.deepcopy(wire)]
    for missing in ['unparseableFiles', 'shadowedFiles']:
        value = copy.deepcopy(wire)
        value.pop(missing)
        cases.append(value)
    for key, value in [('pythonFileCount', '1'), ('packageInitCount', '0')]:
        changed = copy.deepcopy(wire)
        changed[key] = value
        cases.append(changed)
    for location in [None, 'invalid', [], {'line': 1}]:
        changed = copy.deepcopy(wire)
        changed['modules']['models']['symbolDefinitions']['future'] = location
        cases.append(changed)
    for key in ['symbolDefinitions', 'fieldAliases', 'modules', 'unparseableFiles', 'shadowedFiles']:
        changed = copy.deepcopy(wire)
        target = changed['modules']['models'] if key in ['symbolDefinitions', 'fieldAliases'] else changed
        target[key] = ['invalid']
        cases.append(changed)
    class OddDict(dict):
        def get(self, *args): raise AssertionError('Dictionary subclass override escaped defensive copy')
        def __getitem__(self, key): raise AssertionError('Dictionary subclass override escaped defensive copy')
    changed = copy.deepcopy(wire)
    module = changed['modules']['models']
    module['symbolDefinitions'] = {key: OddDict(value) for key, value in module['symbolDefinitions'].items()}
    module['importBindings'] = [OddDict(value) for value in module['importBindings']]
    module['modelCandidates'] = [OddDict(value) for value in module['modelCandidates']]
    module['pendingFields'] = [OddDict(value) for value in module['pendingFields']]
    changed['modules']['models'] = OddDict(module)
    changed['modelCandidates'] = [OddDict(value) for value in changed['modelCandidates']]
    cases.append(changed)

    def outcome(owner, payload):
        try:
            loaded = owner.StaticIndex.from_cache_dict(payload)
            return {'wire': loaded.to_cache_dict(), 'fields': [field.to_dict() for field in loaded.fields]}
        except Exception as error:
            return {'errorType': type(error).__name__, 'error': str(error)}

    for number, payload in enumerate(cases):
        before = json.dumps(payload, sort_keys=True)
        expected = outcome(indexer, payload)
        actual = outcome(candidate, payload)
        assert expected == actual, number
        assert json.dumps(payload, sort_keys=True) == before
    normal = copy.deepcopy(wire)
    restored = candidate.StaticIndex.from_cache_dict(normal)
    normal['modelCandidates'][0]['baseClassRefs'].append('CallerOnlyBase')
    normal['modules']['models']['pendingFields'][0]['constructorImports'].append('CallerOnlyImport')
    assert restored.to_cache_dict() == wire
    assert [field.to_dict() for field in restored.fields] == [field.to_dict() for field in initial.fields]
print(json.dumps({'candidateOnly': True, 'cases': len(cases), 'completeWireDerivedFieldAndErrorParity': True,
    'inputNotMutatedAndCallerMutationIndependent': True, 'dictSubclassCopyBehaviorPreserved': True, 'passed': True,
    'scope': 'Completeinput/derivedfield/default/coercion/malformedrecord anddictsubclass behaviororacle,currentinputnotmutated andcaller-ownednestedarraysindependent. Candidateonly; notactualstartup/partialcache/allplatform claim.'}))
