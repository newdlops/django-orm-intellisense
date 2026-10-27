"""Incremental gzip keeps complete canonical JSON and atomic line framing."""
import base64
import gzip
import io
import json
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest import mock

from django_orm_intellisense.runtime.lookup_catalog import LookupTypeTable, lookup_catalog_json_default
from django_orm_intellisense.server import app
from django_orm_intellisense.server.ipc_encoding import encode_ipc_message
from tests.test_static_fallback_surface_gap import _make_server


class IpcStreamEncodingTests(unittest.TestCase):
    def decoded(self, line, kind):
        if kind is None:
            return line.encode('utf-8')
        envelope = json.loads(line)
        self.assertEqual(envelope['_enc'], 'gzip+b64')
        self.assertNotIn('\n', line)
        return gzip.decompress(base64.b64decode(envelope['data']))

    def assert_wire(self, payload, threshold):
        expected = json.dumps(payload, sort_keys=True, default=lookup_catalog_json_default).encode()
        line, kind, chars, compression = encode_ipc_message(payload, threshold)
        self.assertEqual(self.decoded(line, kind), expected)
        self.assertEqual(chars, len(expected))
        self.assertEqual(kind, 'gzip+b64' if threshold > 0 and len(expected) >= threshold*1024 else None)
        self.assertEqual(compression, 0)

    def test_threshold_below_equal_above_and_disabled_preserve_exact_bytes(self):
        overhead = len(json.dumps({'value': ''}, sort_keys=True))
        for count in [1023, 1024, 1025, 20000]:
            payload = {'value': 'x' * (count-overhead)}
            for threshold in [-1, 0, 1, 256]:
                with self.subTest(count=count, threshold=threshold):
                    self.assert_wire(payload, threshold)

    def test_full_unicode_future_nested_custom_catalogue_and_chunk_boundaries(self):
        types = LookupTypeTable.from_types({'root': {'fieldKind': 'CharField', 'lookups': ['exact'],
            'transforms': {'custom': 'output'}}, 'output': {'fieldKind': 'DateField', 'lookups': ['range'], 'transforms': {}}})
        payload = {'event': 'surfaceIndexChanged', 'params': {'types': types, 'large': '한글 🐍\n"\\' * 10000,
            'surfaceIndex': {f'app.Model{number}': {'instance': {'field': ('scalar', None, 'field', 'CharField')},
                'future': {'args': [None, True, False, 12, 1.5, {'__proto__': ['a', None]}]}}
                for number in range(257)}, 'list': list(range(257))}}
        self.assert_wire(payload, 1)
        self.assert_wire(payload, 0)

    def test_large_message_uses_chunks_instead_of_serializing_entire_payload(self):
        payload = {'event': 'surfaceIndexChanged', 'params': {'surfaceIndex': {
            f'app.Model{number}': {'instance': {f'field_{field}': ['scalar', None, 'field', 'CharField']
                for field in range(20)}} for number in range(300)}}}
        expected = json.dumps(payload, sort_keys=True).encode()
        original = json.JSONEncoder.encode
        encoded_objects = []

        def encode(encoder, value):
            encoded_objects.append(value)
            if value is payload:
                raise AssertionError('Whole raw notification encoded at once')
            return original(encoder, value)

        with mock.patch.object(json.JSONEncoder, 'encode', encode):
            line, kind, chars, _ = encode_ipc_message(payload, 1)
        self.assertGreater(len(encoded_objects), 1)
        self.assertEqual(self.decoded(line, kind), expected)
        self.assertEqual(chars, len(expected))

    def test_serialization_error_writes_no_partial_stdout_frame(self):
        server = _make_server(Path('/workspace'))
        server._real_stdout = io.StringIO()
        circular = {}
        circular['self'] = circular
        for value, error in [(object(), TypeError), (circular, ValueError)]:
            with self.assertRaises(error):
                server._write_response(10, {'unsupported': value})
        self.assertEqual(server._real_stdout.getvalue(), '')

    def test_parallel_preparation_keeps_independent_state_and_one_line_per_message(self):
        server = _make_server(Path('/workspace'))
        server._real_stdout = io.StringIO()
        values = [{'owner': number, 'padding': '한글' * 10000} for number in range(8)]
        with mock.patch.object(app, '_IPC_COMPRESS_MIN_KB', 1), ThreadPoolExecutor(max_workers=4) as pool:
            tasks = [pool.submit(server._write_response, number, payload) for number, payload in enumerate(values)]
            for task in tasks:
                task.result(timeout=5)
        lines = server._real_stdout.getvalue().splitlines()
        self.assertEqual(len(lines), len(values))
        decoded = [json.loads(self.decoded(line, 'gzip+b64')) for line in lines]
        self.assertEqual({value['id'] for value in decoded}, set(range(8)))
        for value in decoded:
            self.assertEqual(value['result'], values[value['id']])

    def test_profile_reports_compression_separately_and_exact_raw_size(self):
        payload = {'id': 1, 'result': {'padding': 'x' * 50000}}
        server = _make_server(Path('/workspace'))
        with mock.patch.object(app, '_IPC_COMPRESS_MIN_KB', 1), \
                mock.patch.dict('os.environ', {'DJLS_PROFILE_SURFACE_ADOPTION': '1'}):
            prepared = server._prepare_message(payload)
        self.assertGreater(prepared.compression_ms, 0)
        self.assertGreaterEqual(prepared.json_ms, 0)
        self.assertEqual(prepared.raw_size_kb, len(json.dumps(payload, sort_keys=True))/1024)
        self.assertEqual(json.loads(self.decoded(prepared.line, prepared.encoding)), payload)

    def test_blocked_publication_excludes_other_messages_until_delimiter_and_flush(self):
        for threshold in [0, 1]:
            with self.subTest(threshold=threshold):
                server = _make_server(Path('/workspace'))
                entered = threading.Event()
                release = threading.Event()
                fragments = []
                flushes = []

                class Output:
                    def write(self, text):
                        fragments.append(text)
                        if not entered.is_set():
                            entered.set()
                            if not release.wait(timeout=5):
                                raise TimeoutError('Blocked test publication was not released')
                        return len(text)

                    def flush(self):
                        flushes.append(len(fragments))

                server._real_stdout = Output()
                values = [{'owner': owner, 'padding': '한글'*10000} for owner in range(4)]
                attempted = [threading.Event() for _ in range(3)]

                def publish(owner):
                    if owner:
                        attempted[owner-1].set()
                    server._write_response(owner, values[owner])

                with mock.patch.object(app, '_IPC_COMPRESS_MIN_KB', threshold), ThreadPoolExecutor(max_workers=4) as pool:
                    first = pool.submit(publish, 0)
                    try:
                        self.assertTrue(entered.wait(timeout=5))
                        others = [pool.submit(publish, owner) for owner in range(1, 4)]
                        for event in attempted:
                            self.assertTrue(event.wait(timeout=5))
                        self.assertTrue(all(not future.done() for future in others), 'Another publication escaped the held write lock')
                    finally:
                        release.set()
                    for future in [first, *others]:
                        future.result(timeout=5)
                lines = ''.join(fragments).splitlines()
                self.assertEqual(len(lines), 4)
                self.assertEqual(len(flushes), 4)
                for line in lines:
                    value = json.loads(self.decoded(line, 'gzip+b64' if threshold else None))
                    self.assertEqual(value['result'], values[value['id']])


if __name__ == '__main__':
    unittest.main()
