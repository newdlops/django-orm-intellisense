import copy
import io
import json
import tempfile
import threading
import unittest
import weakref
from concurrent.futures import ThreadPoolExecutor
from functools import partial
from pathlib import Path
from unittest import mock

from django_orm_intellisense.cache import static_records as records, store
from django_orm_intellisense.cache.json_stream import StaticModuleStreamReader, decode_static_modules_stream
from django_orm_intellisense.discovery.workspace import snapshot_python_sources
from django_orm_intellisense.static_index.indexer import ModuleIndex, StaticIndex, build_static_index


MODULE_KEYS = ('moduleName', 'filePath', 'isPackageInit', 'definedSymbols', 'symbolDefinitions',
    'importBindings', 'explicitAll', 'modelCandidates', 'pendingFields', 'classBaseRefs',
    'fieldClassNames', 'fieldAliases', 'constructorImports', 'sourceMemberDeclarations')
FIELD_KEYS = ('modelLabel', 'modelModule', 'appLabel', 'name', 'filePath', 'line', 'column',
    'fieldCallRef', 'fieldKind', 'isRelation', 'relatedModelRefKind', 'relatedModelRefValue',
    'relatedName', 'relatedQueryName', 'constructorFingerprint', 'constructorImports', 'hasPrimaryKeyOption')


def canonical_module(row):
    result = dict(zip(MODULE_KEYS, row))
    result['pendingFields'] = [dict(zip(FIELD_KEYS, field)) if isinstance(field, list) else field for field in row[8]]
    if row[13] is None:
        result.pop('sourceMemberDeclarations')
    return result


class StaticCacheRowTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='djls-static-rows-')
        self.addCleanup(temporary.cleanup)
        parent = Path(temporary.name).resolve()
        self.root, self.cache = parent / 'project-한글', parent / 'cache'
        package = self.root / 'blog'; package.mkdir(parents=True)
        (package / '__init__.py').write_text('')
        (package / 'limits.py').write_text('MAX_LENGTH=19\n__all__=["MAX_LENGTH"]\n')
        self.source = package / 'models.py'
        self.source.write_text('from django.db import models\nfrom .limits import MAX_LENGTH\n'
            'class TextField(models.CharField):\n    pass\n'
            'class Base(models.Model):\n    inherited=models.CharField(max_length=MAX_LENGTH)\n'
            '    class Meta:\n        abstract=True\n'
            'class Target(models.Model):\n    value=models.CharField()\n'
            'class Post(Base):\n    key=models.UUIDField(primary_key=True)\n'
            '    value=models.CharField(max_length=MAX_LENGTH)\n'
            '    target=models.ForeignKey(Target,on_delete=models.CASCADE,related_name="글들",related_query_name="글")\n'
            '    def custom_method(self) -> int:\n        return 1\n'
            '    @property\n    def custom_property(self) -> str:\n        return "글"\n')
        (package / 'other.py').write_text('from django.db import models\nclass Other(models.Model):\n    value=models.CharField()\n')
        (package / 'broken.py').write_text('class Broken(\n')
        self.snapshot = snapshot_python_sources(self.root)
        self.index = build_static_index(self.root, self.snapshot.files)
        self.expected = self.index.to_cache_dict()
        patcher = mock.patch.object(store, '_workspace_cache_dir', return_value=self.cache)
        patcher.start(); self.addCleanup(patcher.stop)
        store.save_static_index(self.root, self.snapshot, self.index)
        self.path = self.cache / store.STATIC_INDEX_FULL_CACHE_NAME
        self.partial_path = self.cache / store.STATIC_INDEX_CACHE_NAME
        self.wire = json.loads(self.path.read_text())
        self.partial_wire = json.loads(self.partial_path.read_text())

    def row(self, wire=None):
        return (self.wire if wire is None else wire)['payload']['moduleRows']['blog.models']

    def write(self, wire):
        self.path.write_text(json.dumps(wire, ensure_ascii=False))

    def load(self):
        return store._try_load_full_static_index(self.root, self.snapshot)

    def assert_index(self, result, expected=None):
        self.assertIsNotNone(result)
        self.assertEqual(result.to_cache_dict(), self.expected if expected is None else expected)

    def test_compact_files_preserve_all_module_and_pending_field_values(self):
        self.assertEqual(self.wire['metadata']['staticIndexVersion'], 2)
        self.assertEqual(self.partial_wire['metadata']['staticIndexVersion'], 2)
        for name, row in self.wire['payload']['moduleRows'].items():
            self.assertEqual(len(row), 14)
            self.assertTrue(all(len(field) == 17 for field in row[8]))
            self.assertEqual(canonical_module(row), self.expected['modules'][name])
            relative = Path(row[1]).relative_to(self.root).as_posix()
            self.assertEqual(self.partial_wire['payload']['moduleEntries'][relative]['moduleRow'], row)
        for threshold in [0, 1 << 50]:
            with mock.patch.object(store, '_STATIC_MODULE_STREAM_MIN_BYTES', threshold):
                restored = self.load(); self.assert_index(restored)
                self.assertEqual(restored.fields, self.index.fields)
                self.assertIsNone(restored.find_field('blog.Post', 'id'))
                self.assertEqual(restored.find_field('blog.Post', 'key').field_kind, 'UUIDField')
                declared_key = next(field for field in restored.modules['blog.models'].pending_fields
                    if field.model_label == 'blog.Post' and field.name == 'key')
                self.assertTrue(declared_key.has_primary_key_option)

    def test_raw_dictionary_api_and_caller_mutation_keep_public_ownership(self):
        raw = store._read_cache_payload(self.path)
        self.assertEqual(raw['payload'], self.expected)
        self.assertNotIn('moduleRows', raw['payload'])
        restored = StaticIndex.from_cache_dict(raw['payload'])
        raw['payload']['modules']['blog.models']['definedSymbols'].append('caller_only')
        raw['payload']['modules']['blog.models']['pendingFields'][0]['constructorImports'].append('caller_only')
        self.assert_index(restored)
        self.assertFalse(StaticIndex.from_cache_dict(self.wire['payload']).modules)

    def test_every_module_row_position_matches_dictionary_coercion(self):
        changes = ['canonical.models', 123, 0, ['caller_symbol', 7], {},
            [{'module': 'x', 'symbol': 'a', 'alias': 'b', 'isStar': False}],
            [1, '글'], [], [], {'Post': ['models.Model']}, ['TextField'],
            {'Alias': 'DateField'}, ['constants.MAX'], None]
        for position, value in enumerate(changes):
            row = copy.deepcopy(self.row()); row[position] = value
            expected = ModuleIndex.from_dict(canonical_module(row))
            with self.subTest(position=MODULE_KEYS[position]):
                actual = records.module_from_row(row, None)
                self.assertEqual(actual.to_dict(), expected.to_dict())

    def test_every_pending_row_position_matches_dictionary_coercion(self):
        changes = [['other.Label'], 12, None, ['field'], 123, '9', 8.9, None,
            'DateField', 0, '', ['related'], '', None, [], ['limits.X', 3, None], 1]
        original = self.row()
        field_index = next(i for i, field in enumerate(original[8]) if field[0] == 'blog.Post' and field[3] == 'value')
        for position, value in enumerate(changes):
            row = copy.deepcopy(original); row[8][field_index][position] = value
            expected = ModuleIndex.from_dict(canonical_module(row))
            with self.subTest(position=FIELD_KEYS[position]):
                actual = records.module_from_row(row, None)
                self.assertEqual(actual.to_dict(), expected.to_dict())
                self.assertIs(type(actual.pending_fields[field_index].constructor_imports), tuple)

    def test_legacy_and_expanded_version_two_files_load_full_and_partial(self):
        for version in [None, 1, 2]:
            for name, original in [(store.STATIC_INDEX_FULL_CACHE_NAME, self.wire), (store.STATIC_INDEX_CACHE_NAME, self.partial_wire)]:
                store._write_cache_payload(self.cache / name, copy.deepcopy(original))
                wire = store._read_cache_payload(self.cache / name)
                if version is None:
                    wire['metadata'].pop('staticIndexVersion')
                else:
                    wire['metadata']['staticIndexVersion'] = version
                store._write_cache_payload(self.cache / name, wire)
            for threshold in [0, 1 << 50]:
                with mock.patch.object(store, '_STATIC_MODULE_STREAM_MIN_BYTES', threshold):
                    self.assert_index(self.load())
            self.path.unlink()
            restored, hit = store.load_cached_static_index(self.root, self.snapshot)
            self.assertEqual(hit, 'partial'); self.assert_index(restored)

    def test_source_edit_partial_restore_matches_fresh_complete_index(self):
        old = self.load()
        self.source.write_text(self.source.read_text().replace('value=models.CharField', 'value=models.DateField'))
        current = snapshot_python_sources(self.root)
        self.assertNotEqual(current.fingerprint, self.snapshot.fingerprint)
        restored, hit = store.load_cached_static_index(self.root, current)
        self.assertEqual(hit, 'partial')
        self.assertEqual(restored.to_cache_dict(), build_static_index(self.root, current.files).to_cache_dict())
        self.assertEqual(restored.find_field('blog.Post', 'value').field_kind, 'DateField')
        self.assert_index(old)

    def test_stale_and_unknown_full_metadata_skip_hydration(self):
        for threshold in [0, 1 << 50]:
            for metadata in [{'schemaVersion': -1}, {'workspaceRoot': '/other'},
                    {'rootTreeFingerprint': 'stale'}, {'staticIndexVersion': 3}]:
                wire = copy.deepcopy(self.wire); wire['metadata'].update(metadata)
                self.row(wire).pop(); self.write(wire)
                with self.subTest(threshold=threshold, metadata=metadata), \
                        mock.patch.object(store, '_STATIC_MODULE_STREAM_MIN_BYTES', threshold), \
                        mock.patch.object(store, 'module_from_row', side_effect=AssertionError('Stale rows hydrated')):
                    self.assertIsNone(self.load())
                self.assertTrue(self.path.exists())

    def test_malformed_rows_and_incomplete_file_coverage_reject_full_cache(self):
        invalid = []
        for length in [13, 15]:
            wire = copy.deepcopy(self.wire); row = self.row(wire)
            wire['payload']['moduleRows']['blog.models'] = row[:length] if length == 13 else row + ['future']
            invalid.append(wire)
        for length in [16, 18]:
            wire = copy.deepcopy(self.wire); field = self.row(wire)[8][0]
            self.row(wire)[8][0] = field[:length] if length == 16 else field + ['future']
            invalid.append(wire)
        missing = copy.deepcopy(self.wire); missing['payload']['moduleRows'].pop('blog.models'); invalid.append(missing)
        bad_field = copy.deepcopy(self.wire); self.row(bad_field)[8][0][5] = 'bad-line'; invalid.append(bad_field)
        for threshold in [0, 1 << 50]:
            for wire in invalid:
                self.write(wire)
                with self.subTest(threshold=threshold), mock.patch.object(store, '_STATIC_MODULE_STREAM_MIN_BYTES', threshold):
                    self.assertIsNone(self.load())
                self.assertFalse(self.path.exists())
        self.assertEqual(self.index.to_cache_dict(), self.expected)

    def test_partial_unknown_version_and_malformed_rows_are_recoverable(self):
        self.path.unlink()
        for metadata in [{'staticIndexVersion': 3}, {'schemaVersion': -1}, {'workspaceRoot': '/other'}]:
            wire = copy.deepcopy(self.partial_wire); wire['metadata'].update(metadata)
            store._write_cache_payload(self.partial_path, wire)
            with mock.patch.object(store, 'module_from_row', side_effect=AssertionError('Invalid partial hydrated')):
                self.assertEqual(store.load_cached_static_index(self.root, self.snapshot), (None, 'miss'))
            self.assertTrue(self.partial_path.exists())
        wire = copy.deepcopy(self.partial_wire)
        wire['payload']['moduleEntries']['blog/models.py']['moduleRow'].pop()
        store._write_cache_payload(self.partial_path, wire)
        self.assertEqual(store.load_cached_static_index(self.root, self.snapshot), (None, 'miss'))
        self.assertFalse(self.partial_path.exists())

    def test_malformed_pending_records_reject_cache_and_preserve_source_recovery(self):
        malformed = [None, {}, False, 0, '', 'unknown-container',
            [None], [7], ['unknown-record'], [False], [{}]]
        for threshold in [0, 1 << 50]:
            for fields in malformed:
                store._write_cache_payload(self.partial_path, self.partial_wire)
                wire = copy.deepcopy(self.wire); self.row(wire)[8] = fields
                self.write(wire)
                with self.subTest(threshold=threshold, fields=fields), \
                        mock.patch.object(store, '_STATIC_MODULE_STREAM_MIN_BYTES', threshold):
                    self.assertIsNone(self.load())
                    self.assertFalse(self.path.exists())
                    restored, hit = store.load_cached_static_index(self.root, self.snapshot)
                    self.assertEqual(hit, 'partial'); self.assert_index(restored)
                    self.assertEqual(restored.fields, self.index.fields)
                    partial_wire = copy.deepcopy(self.partial_wire)
                    partial_wire['payload']['moduleEntries']['blog/models.py']['moduleRow'][8] = fields
                    store._write_cache_payload(self.partial_path, partial_wire)
                    self.assertEqual(store.load_cached_static_index(self.root, self.snapshot), (None, 'miss'))
                    self.assertFalse(self.partial_path.exists())
                    rebuilt = build_static_index(self.root, self.snapshot.files)
                    self.assert_index(rebuilt); self.assertEqual(rebuilt.fields, self.index.fields)
        mixed = copy.deepcopy(self.row())
        mixed[8][0] = canonical_module(self.row())['pendingFields'][0]
        self.assertEqual(records.module_from_row(mixed, None).to_dict(), self.expected['modules']['blog.models'])

    def test_duplicate_payloads_late_metadata_and_changed_codec_select_final_values(self):
        # A smaller complete graph keeps one-byte chunk cases bounded.
        wire = copy.deepcopy(self.wire)
        for row in wire['payload']['moduleRows'].values():
            row[3:6] = [[], {}, []]; row[7:9] = [[], []]; row[13] = None
        expected = copy.deepcopy(wire['payload'])
        expected['modules'] = {name: canonical_module(row) for name, row in expected.pop('moduleRows').items()}
        metadata, payload = json.dumps(wire['metadata']), json.dumps(wire['payload'])
        model = json.dumps(wire['payload']['moduleRows']['blog.models'])
        stale = json.dumps({**wire['metadata'], 'rootTreeFingerprint': 'stale'})
        legacy = json.dumps({**wire['metadata'], 'staticIndexVersion': 1})
        both = {**wire['payload'], 'modules': expected['modules']}
        cases = [
            '{"payload":' + payload + ',"metadata":' + metadata + '}',
            json.dumps(wire).replace('"blog.models": ' + model, '"blog.models":[],"blog.models": ' + model),
            '{"metadata":' + metadata + ',"payload":{"moduleRows":{"blog.models":[]}},"payload":' + payload + '}',
            '{"metadata":' + stale + ',"payload":' + payload + ',"metadata":' + metadata + '}',
            '{"metadata":' + legacy + ',"payload":' + payload + ',"metadata":' + metadata + '}',
            '{"metadata":' + metadata + ',"payload":' + json.dumps(both) + ',"metadata":' + legacy + '}',
        ]
        for threshold in [0, 1 << 50]:
            for chunk in [1, 7, 64, 262144]:
                for raw in cases:
                    self.path.write_text(raw)
                    with self.subTest(threshold=threshold, chunk=chunk), \
                            mock.patch.object(store, '_STATIC_MODULE_STREAM_MIN_BYTES', threshold), \
                            mock.patch.object(store, 'decode_static_modules_stream', partial(decode_static_modules_stream, chunk_size=chunk)):
                        self.assert_index(self.load(), expected)

    def test_invalid_count_precedes_invalid_row_and_final_unexpected_errors_remain_visible(self):
        for threshold in [0, 1 << 50]:
            wire = copy.deepcopy(self.wire); self.row(wire)[9] = [1]
            wire['payload']['pythonFileCount'] = 'bad-count-first'; self.write(wire)
            with mock.patch.object(store, '_STATIC_MODULE_STREAM_MIN_BYTES', threshold):
                self.assertIsNone(self.load())
            self.assertFalse(self.path.exists())
            wire['payload']['pythonFileCount'] = self.index.python_file_count; self.write(wire)
            with mock.patch.object(store, '_STATIC_MODULE_STREAM_MIN_BYTES', threshold), self.assertRaises(AttributeError):
                self.load()
            self.assertTrue(self.path.exists())

    def test_future_shapes_unicode_and_failed_size_hint_keep_json_and_read_contracts(self):
        wire = copy.deepcopy(self.wire)
        future = {'moduleRows': copy.deepcopy(wire['payload']['moduleRows']), 'literal': '한글🙂' * 10000}
        wire['metadata']['future'] = future; wire['payload']['future'] = copy.deepcopy(future)
        self.write(wire)
        raw = store._read_cache_payload(self.path)
        self.assertEqual(raw['metadata']['future'], future); self.assertEqual(raw['payload']['future'], future)
        wire['metadata']['staticIndexVersion'] = 3; self.write(wire)
        self.assertEqual(store._read_cache_payload(self.path), wire)
        for chunk in [65536, 262144]:
            with mock.patch.object(store, 'decode_static_modules_stream', partial(decode_static_modules_stream, chunk_size=chunk)):
                self.assertEqual(store._decode_static_cache_payload(io.StringIO(json.dumps(wire))), wire)
        self.write(self.wire)
        with mock.patch.object(Path, 'stat', side_effect=OSError('size hint unavailable')):
            self.assert_index(self.load())

    def test_full_and_partial_string_sharing_remains_read_local(self):
        for threshold in [0, 1 << 50]:
            self.write(self.wire)
            with mock.patch.object(store, '_STATIC_MODULE_STREAM_MIN_BYTES', threshold):
                first, second = self.load(), self.load()
            self.path.unlink()
            third, hit = store.load_cached_static_index(self.root, self.snapshot); self.assertEqual(hit, 'partial')
            for result in [first, second, third]:
                module = result.modules['blog.models']; field = module.pending_fields[0]
                self.assertIs(module.file_path, field.file_path)
                self.assertIs(module.module_name, field.model_module)
                self.assertIs(module.file_path, module.model_candidates[0].file_path)
                value = result.find_field('blog.Post', 'value'); other = result.find_field('blog.Other', 'value')
                self.assertIs(value.name, other.name); self.assertIs(value.field_kind, other.field_kind)
            self.assertIsNot(first.modules['blog.models'].file_path, second.modules['blog.models'].file_path)

    def test_parallel_restores_and_row_callback_do_not_retain_whole_owners(self):
        with ThreadPoolExecutor(max_workers=2) as pool:
            first, second = list(pool.map(lambda _: self.load(), range(2)))
        self.assert_index(first); self.assert_index(second)
        first.modules['blog.models'].defined_symbols.add('caller_only')
        self.assert_index(second)
        class Hook:
            def __call__(self, value): return value
        for raw in [json.dumps(self.wire), '{"payload":{"moduleRows":']:
            row_hook = Hook(); reference = weakref.ref(row_hook)
            reader = StaticModuleStreamReader(io.StringIO(raw), Hook(), Hook(), 7, Hook(), row_hook)
            try: reader.read()
            except json.JSONDecodeError: pass
            del row_hook
            self.assertIsNone(reference()); self.assertIsNone(reader.restore_module_row)
        class Loader:
            def __call__(self, value): return records.module_from_row(value, None)
        loader = Loader(); reference = weakref.ref(loader)
        restored = StaticIndex.from_cache_dict(self.wire['payload'], _module_row_loader=loader)
        del loader
        self.assertIsNone(reference()); self.assert_index(restored)

    def test_atomic_row_cache_replacement_keeps_one_opened_snapshot(self):
        started, resume = threading.Event(), threading.Event(); original_open = Path.open
        class Held:
            def __init__(self, stream): self.stream, self.first = stream, True
            def __enter__(self): return self
            def __exit__(self, *args): self.stream.close()
            def read(self, size=-1):
                value = self.stream.read(size)
                if self.first:
                    self.first = False; started.set()
                    if not resume.wait(5): raise RuntimeError('Read not resumed')
                return value
        def opened(path, *args, **kwargs):
            value = original_open(path, *args, **kwargs)
            return Held(value) if path == self.path else value
        changed = copy.deepcopy(self.wire); self.row(changed)[3].append('replacement_symbol')
        with mock.patch.object(store, '_STATIC_MODULE_STREAM_MIN_BYTES', 0), \
                mock.patch.object(Path, 'open', opened), \
                mock.patch.object(store, 'decode_static_modules_stream', partial(decode_static_modules_stream, chunk_size=7)), \
                ThreadPoolExecutor(max_workers=1) as pool:
            pending = pool.submit(self.load)
            try:
                self.assertTrue(started.wait(3)); store._write_cache_payload(self.path, changed)
            finally: resume.set()
            previous = pending.result(timeout=5)
        self.assert_index(previous)
        self.assertIn('replacement_symbol', self.load().modules['blog.models'].defined_symbols)

    def test_external_files_shadowed_files_and_parse_failures_keep_complete_coverage(self):
        external = self.root.parent / 'aaa/src/zzpkg'; external.mkdir(parents=True)
        (external / '__init__.py').write_text('')
        model = external / 'models.py'
        model.write_text('from django.db import models\nclass External(models.Model):\n    한글=models.CharField()\n')
        (self.root / 'blog/entities.py').write_text('value=1\n')
        package = self.root / 'blog/entities'; package.mkdir(); (package / '__init__.py').write_text('value=2\n')
        snapshot = snapshot_python_sources(self.root, [external]); index = build_static_index(self.root, snapshot.files)
        self.assertTrue(index.shadowed_files); self.assertTrue(index.unparseable_files)
        store.save_static_index(self.root, snapshot, index)
        restored, hit = store.load_cached_static_index(self.root, snapshot)
        self.assertEqual(hit, 'full'); self.assertEqual(restored.to_cache_dict(), index.to_cache_dict())
        model.write_text(model.read_text().replace('CharField', 'DateField'))
        current = snapshot_python_sources(self.root, [external])
        restored, hit = store.load_cached_static_index(self.root, current)
        self.assertEqual(hit, 'partial')
        self.assertEqual(restored.to_cache_dict(), build_static_index(self.root, current.files).to_cache_dict())
        self.assertEqual(restored.find_field('zzpkg.External', '한글').field_kind, 'DateField')


if __name__ == '__main__':
    unittest.main()
