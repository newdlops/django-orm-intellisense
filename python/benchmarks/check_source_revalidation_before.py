"""Run allocation guard with the previous full snapshot rebuilding behavior."""
import unittest
from unittest import mock

from benchmarks.bench_snapshot_identity_overhead import previous_module
from django_orm_intellisense.discovery import workspace
from tests.test_source_snapshot_revalidation import SourceSnapshotRevalidationTests


original = previous_module().snapshot_python_sources


def without_reuse(*args, **kwargs):
    kwargs.pop('previous_snapshot', None)
    return original(*args, **kwargs)


if __name__ == '__main__':
    suite = unittest.TestSuite([SourceSnapshotRevalidationTests(
        'test_unchanged_snapshot_reuses_allocations_only_after_stat_of_every_current_file')])
    with mock.patch.object(workspace, 'snapshot_python_sources', without_reuse):
        result = unittest.TextTestRunner(verbosity=1).run(suite)
    raise SystemExit(not result.wasSuccessful())
