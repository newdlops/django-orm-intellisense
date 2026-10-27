"""Prove the new storage guard against the previous record decorators."""
import unittest

from benchmarks.record_layout_control import install_previous_layout

install_previous_layout()
from tests.test_compact_records import CompactRecordTests

if __name__ == '__main__':
    suite = unittest.TestSuite([CompactRecordTests(
        'test_compact_records_pickle_copy_and_field_enumeration_preserve_values')])
    result = unittest.TextTestRunner(verbosity=1).run(suite)
    raise SystemExit(not result.wasSuccessful())
