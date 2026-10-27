"""Run whole-buffer encoding guard against the previous preparation path."""
import json
import unittest
from unittest import mock

from django_orm_intellisense.runtime.lookup_catalog import lookup_catalog_json_default
from django_orm_intellisense.server.app import _maybe_compress_ipc_payload
from tests import test_ipc_stream_encoding


def previous(payload, threshold_kb, **kwargs):
    serialized = json.dumps(payload, sort_keys=True, default=lookup_catalog_json_default)
    line, kind = _maybe_compress_ipc_payload(serialized)
    return line, kind, len(serialized), 0


if __name__ == '__main__':
    suite = unittest.TestSuite([test_ipc_stream_encoding.IpcStreamEncodingTests(
        'test_large_message_uses_chunks_instead_of_serializing_entire_payload')])
    with mock.patch.object(test_ipc_stream_encoding, 'encode_ipc_message', previous):
        result = unittest.TextTestRunner(verbosity=1).run(suite)
    raise SystemExit(not result.wasSuccessful())
