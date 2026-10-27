"""Candidate vs current cache selection, error precedence and ownership."""
import copy
import io
import json
import tempfile
from concurrent.futures import ThreadPoolExecutor
from functools import partial
from pathlib import Path
from unittest import mock

from benchmarks.static_stream_restore_candidate import (
    OwnedKeyStaticStreamReader, candidate_module, previous_reader,
)
from django_orm_intellisense.cache import store
from django_orm_intellisense.discovery.workspace import snapshot_python_sources
from django_orm_intellisense.static_index import indexer


candidate = candidate_module()
store._STATIC_MODULE_STREAM_MIN_BYTES = 0
baseline_reader = previous_reader
production_reader = store._read_cache_payload
valid_cases, syntax_cases = 0, 0
with tempfile.TemporaryDirectory(prefix='djls-static-stream-contracts-') as temporary:
    parent = Path(temporary).resolve()
    root, cache = parent / 'project', parent / 'cache'
    (root / 'blog' / 'collision').mkdir(parents=True)
    (root / 'blog' / '__init__.py').write_text('from .models import Post\n')
    (root / 'blog' / 'models.py').write_text('from django.db import models\n'
        'class Base(models.Model):\n    value=models.CharField()\n'
        '    class Meta:\n        abstract=True\n'
        'class Post(Base):\n    owner=models.ForeignKey("self",on_delete=models.CASCADE)\n')
    (root / 'blog' / 'collision.py').write_text('shadowed=1\n')
    (root / 'blog' / 'collision' / '__init__.py').write_text('winner=2\n')
    (root / 'broken.py').write_text('class Broken(\n')
    (root / 'helpers.py').write_text('helper_value=3\n')
    snapshot = snapshot_python_sources(root)
    initial = indexer.build_static_index(root, snapshot.files)
    cache.mkdir()
    path = cache / store.STATIC_INDEX_FULL_CACHE_NAME
    base = {'metadata': {'schemaVersion': store.CACHE_SCHEMA_VERSION,
            'workspaceRoot': str(root), 'rootTreeFingerprint': snapshot.fingerprint},
        'payload': initial.to_cache_dict()}
    cases = [base, [], None, {'metadata': None}, {'metadata': base['metadata']},
             {**base, 'payload': None}]
    for name, replacement in [('schemaVersion', 0), ('workspaceRoot', '/other'),
                              ('rootTreeFingerprint', 'different')]:
        value = copy.deepcopy(base)
        value['metadata'][name] = replacement
        value['payload']['modules']['blog.models']['moduleName'] = None
        value['payload']['modules']['blog.models'].pop('filePath')
        cases.append(value)
    for name, replacement in [('modules', None), ('modules', []), ('modules', [1]),
            ('modules', {'ignored': None}), ('unparseableFiles', []), ('unparseableFiles', [1]),
            ('shadowedFiles', None), ('shadowedFiles', [1]), ('pythonFileCount', '6'),
            ('pythonFileCount', None), ('pythonFileCount', 'bad'), ('packageInitCount', '2'),
            ('modelCandidates', [None, 1]), ('modelCandidates', [{'objectName': 'bad'}])]:
        value = copy.deepcopy(base)
        value['payload'][name] = replacement
        cases.append(value)
    for name, replacement in [('symbolDefinitions', [1]), ('fieldAliases', [1]),
            ('classBaseRefs', [1]), ('importBindings', [None, 1, {'module': 'bad'}]),
            ('modelCandidates', [None, 1, {'objectName': 'bad'}]),
            ('pendingFields', [None, 1, {'name': 'bad'}]), ('explicitAll', 'ignored'),
            ('definedSymbols', None), ('constructorImports', None)]:
        value = copy.deepcopy(base)
        value['payload']['modules']['blog.models'][name] = replacement
        cases.append(value)
    for name in ['moduleName', 'filePath', 'isPackageInit']:
        value = copy.deepcopy(base)
        value['payload']['modules']['blog.models'].pop(name)
        cases.append(value)
    for value in [False, 7, 'ignored', [], {'filePath': 'bad'}]:
        changed = copy.deepcopy(base)
        changed['payload']['modules']['blog.models'] = value
        cases.append(changed)
    changed = copy.deepcopy(base)
    changed['payload']['pythonFileCount'] = 'first-error'
    changed['payload']['modules']['blog.models']['classBaseRefs'] = [1]
    cases.append(changed)

    raw_base = json.dumps(base, ensure_ascii=False)
    raw_module = json.dumps(base['payload']['modules']['blog.models'], ensure_ascii=False)
    raw_metadata = json.dumps(base['metadata'])
    raw_payload = json.dumps(base['payload'], ensure_ascii=False)
    raws = [json.dumps(value, ensure_ascii=False) for value in cases]
    raws.extend([
        '{"metadata":{},"metadata":' + raw_metadata + ',"payload":' + raw_payload + '}',
        '{"payload":{"modules":{"bad":{}}},"payload":' + raw_payload + ',"metadata":' + raw_metadata + '}',
        '{"metadata":' + raw_metadata + ',"payload":' + raw_payload[:-1] + ',"modules":{}}}',
        raw_base.replace('"blog.models": ' + raw_module,
                         '"blog.models": {},"blog.models": ' + raw_module),
        raw_base.replace('"blog.models": ' + raw_module,
                         '"blog.models": ' + raw_module + ',"blog.models": {}'),
    ])

    def outcome(raw, owner, reader):
        path.write_bytes(raw if isinstance(raw, bytes) else raw.encode('utf-8'))
        with mock.patch.object(store, '_workspace_cache_dir', return_value=cache), \
                mock.patch.object(store, 'StaticIndex', owner), \
                mock.patch.object(store, '_read_cache_payload', reader):
            try:
                loaded = store._try_load_full_static_index(root, snapshot)
                value = None if loaded is None else {
                    'wire': loaded.to_cache_dict(),
                    'fields': [field.to_dict() for field in loaded.fields]}
                return {'result': value, 'cacheExists': path.exists()}
            except Exception as error:
                return {'errorType': type(error).__name__, 'error': str(error),
                        'cacheExists': path.exists()}

    for raw in raws:
        expected = outcome(raw, indexer.StaticIndex, baseline_reader)
        for chunk in [1, 7, 64, 262144]:
            with mock.patch.object(store, 'decode_static_modules_stream',
                    partial(store.decode_static_modules_stream, chunk_size=chunk)):
                actual = outcome(raw, indexer.StaticIndex, production_reader)
            assert actual == expected, (raw[:100], chunk, expected, actual)
            valid_cases += 1
    for raw in ['', '{', '{"payload":{"modules":', '{"payload":NaN suffix}',
                '{"payload":{"modules":{"x":{}}},}', raw_base + ' trailing',
                raw_base.replace('"CharField"', '"\\q"'),
                b'{"payload":{"modules":{"x":{"filePath":"\xff"}}}}']:
        expected = outcome(raw, indexer.StaticIndex, baseline_reader)
        for chunk in [1, 7, 64, 262144]:
            with mock.patch.object(store, 'decode_static_modules_stream',
                    partial(store.decode_static_modules_stream, chunk_size=chunk)):
                actual = outcome(raw, indexer.StaticIndex, production_reader)
            assert actual == expected, (raw[:100], chunk)
            syntax_cases += 1

    future = {'metadata': {'future': {'payload': {'modules': {'future':
        base['payload']['modules']['blog.models']}}}}, 'payload': {
        'future': {'modules': base['payload']['modules'], 'literal': '한글🙂' * 20000}}}
    future_raw = json.dumps(future, ensure_ascii=False)
    for chunk in [65536, 262144]:
        with mock.patch.object(store, 'decode_static_modules_stream',
                partial(store.decode_static_modules_stream, chunk_size=chunk)):
            assert store._decode_static_cache_payload(io.StringIO(future_raw)) == future

    def read():
        return store._decode_static_cache_payload(io.StringIO(raw_base))

    with ThreadPoolExecutor(max_workers=2) as pool:
        left, right = list(pool.map(lambda _: read(), range(2)))
    first, second = left['payload']['modules']['blog.models'], right['payload']['modules']['blog.models']
    assert first.file_path is first.pending_fields[0].file_path
    assert first.file_path is not second.file_path
    first.defined_symbols.add('caller_only')
    assert 'caller_only' not in second.defined_symbols
    assert left['payload']['modules'] is not right['payload']['modules']
    for raw in [raw_base, '{"payload":{"modules":']:
        reader = OwnedKeyStaticStreamReader(io.StringIO(raw), candidate.ModuleIndex, 7)
        try:
            reader.read()
        except json.JSONDecodeError:
            pass
        assert reader.decoder is None and reader.original_hook is None and reader.stream is None
        assert reader.buffer == '' and not reader.keys and not reader.strings and reader.module_type is None

print(json.dumps({'candidateOnly': False, 'productionApplied': True,
    'validCacheOutcomeComparisons': valid_cases,
    'malformedJsonUtf8OutcomeComparisons': syntax_cases, 'futureUnknownDataUnchanged': True,
    'duplicateKeysMetadataAndErrorPrecedence': True, 'parallelReadLocalStringMutableOwners': True,
    'successAndFailureDecoderCleanup': True, 'passed': True,
    'scope': 'Whole full-cache selection, source counts/unparseable/shadowed coverage, '
             'metadata/error precedence and deletion parity across read boundaries; '
             'unknown data, parallel ownership and cleanup. No aggregate startup/platform claim.'}))
