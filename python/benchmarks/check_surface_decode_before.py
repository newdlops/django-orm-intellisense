"""Show that prior late compaction left all arrays alive during validation."""
import unittest
from unittest import mock

from django_orm_intellisense.cache import store
from tests.test_surface_decode_compaction import SurfaceDecodeCompactionTests

if __name__ == '__main__':
    suite = unittest.TestSuite([SurfaceDecodeCompactionTests(
        'test_complete_models_compact_during_decode_before_surface_validation')])
    with mock.patch.object(store, '_decode_surface_cache_payload',
            lambda raw, **_: store._decode_cache_payload(raw)):
        result = unittest.TextTestRunner(verbosity=1).run(suite)
    raise SystemExit(not result.wasSuccessful())
