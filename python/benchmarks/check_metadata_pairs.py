"""Candidate pairs reader matches stdlib syntax, ownership and cleanup."""
import io
import json
import random
from concurrent.futures import ThreadPoolExecutor

from benchmarks.metadata_pairs_candidate import PairsMetadataReader
from django_orm_intellisense.cache.store import _CACHE_STRING_FIELDS, _decode_cache_payload


def candidate(raw, chunk=262144):
    return PairsMetadataReader(io.StringIO(raw), _CACHE_STRING_FIELDS, chunk_size=chunk).read()


random_source = random.Random(20261010)
values = [None, True, False, 0, -1, 1.25, '한글 🐍\n"\\', [None, {'unknown': 3}], {'__proto__': []}]
raws = ['{}', '[]', 'null', '123', '{"payload":{"modules":{"one":1,"one":2}}}',
    '{"payload":{"entries":[{"filePath":"a","name":"before","name":"after"},{"filePath":"a","name":"after"}]}}',
    '{"payload":{"metadata":{"n":NaN,"x":Infinity,"y":-Infinity}}}']
for _ in range(80):
    payload = {'metadata': {'schemaVersion': 34}, 'payload': {'entries': [
        {'filePath': '/project/long_path/한글/models.py', 'fieldKind': 'CharField',
            'modelLabel': 'app.LongModel', 'name': 'value', 'args': random_source.choice(values),
            'nested': {'literal': random_source.choice(values)}} for _ in range(4)]}}
    raws.append(json.dumps(payload, ensure_ascii=False))
raws.append(json.dumps({'payload': {'future': {'filePath': None, 'fieldKind': 3,
    'literal': '한글🐍'*20000}}}, ensure_ascii=False))
valid = 0
for raw in raws:
    expected = json.dumps(_decode_cache_payload(raw), sort_keys=True)
    for chunk in [1, 2, 7, 64, 262144]:
        assert json.dumps(candidate(raw, chunk), sort_keys=True) == expected
        valid += 1
invalid = 0
for raw in ['{"payload":', '{"payload":{"one":1e}}', '{"payload":{"one":"\\q"}}',
        '{} trailing', '{"payload":{"a":1,}}', '{"payload":{"a":[1,]}}', '{"a":NaN suffix}',
        '{"a":tru}', '{"a":"unterminated}', '{"a":01}', '{"a":+1}']:
    for chunk in [1, 2, 7, 64, 262144]:
        try: candidate(raw, chunk)
        except json.JSONDecodeError: pass
        else: raise AssertionError(f'Invalid syntax accepted: {raw!r}')
        invalid += 1
wire = json.dumps({'payload': {'modules': {name: {'filePath': '/project/a_long_models_filename.py',
    'fieldKind': 'CharField', 'modelLabel': 'app.LongNamedModel', 'args': []} for name in ['one', 'two']}}})
with ThreadPoolExecutor(max_workers=2) as pool:
    first, second = list(pool.map(candidate, [wire, wire]))
left, right = first['payload']['modules'].values()
other = second['payload']['modules']['one']
assert left['filePath'] is right['filePath'] and left['filePath'] is not other['filePath']
key_left = next(name for name in left if name == 'modelLabel')
key_right = next(name for name in right if name == 'modelLabel')
key_other = next(name for name in other if name == 'modelLabel')
assert key_left is key_right and key_left is not key_other
left['args'].append('caller mutation')
assert not right['args'] and not other['args']
for raw in [wire, '{"payload":']:
    reader = PairsMetadataReader(io.StringIO(raw), _CACHE_STRING_FIELDS, chunk_size=7)
    try: reader.read()
    except json.JSONDecodeError: pass
    assert reader.decoder is None and reader.original_hook is None and reader.stream is None
    assert reader.buffer == '' and not reader.keys and not reader.string_pool
print(json.dumps({'candidateOnly': True, 'validComparisons': valid, 'invalidComparisons': invalid,
    'parallelReadLocalKeyValueAndMutableOwnership': True, 'successAndErrorDecoderOwnerCleanup': True,
    'passed': True, 'scope': 'Candidate JSON syntax/duplicatekeys/numericUnicode/futurevalues andboundedchunk comparisons againstcurrentstdlibhook, read-local pool/mutableowner andcleanup checks. No production startup/lifecycle/platform claim.'}))
