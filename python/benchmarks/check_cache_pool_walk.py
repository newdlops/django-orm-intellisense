"""Check the unadopted post-decode candidate against existing cache contracts."""
import unittest
from unittest import mock

from benchmarks.bench_cache_pool_walk import walk_decoder
from django_orm_intellisense.cache import store
from tests.test_cache_payload_strings import CachePayloadStringTests


if __name__ == '__main__':
    suite = unittest.defaultTestLoader.loadTestsFromTestCase(CachePayloadStringTests)
    with mock.patch.object(store, '_decode_cache_payload', walk_decoder):
        result = unittest.TextTestRunner(verbosity=1).run(suite)
    raise SystemExit(not result.wasSuccessful())
