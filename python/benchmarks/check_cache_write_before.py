"""Reproduce the prior shared-temp cache writer concurrency failure."""
import unittest
from unittest import mock

from benchmarks.cache_write_control import previous_write_cache_payload
from django_orm_intellisense.cache import store
from tests.test_cache_write_atomic import CacheWriteAtomicTests

if __name__ == '__main__':
    suite = unittest.TestSuite([CacheWriteAtomicTests(
        'test_concurrent_writers_have_distinct_complete_temps_and_readers_keep_old_until_commit')])
    with mock.patch.object(store, '_write_cache_payload', previous_write_cache_payload):
        result = unittest.TextTestRunner(verbosity=1).run(suite)
    raise SystemExit(not result.wasSuccessful())
