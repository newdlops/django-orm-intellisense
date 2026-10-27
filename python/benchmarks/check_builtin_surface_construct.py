"""Candidate direct-template isolation plus existing member/cache contracts."""
import io
import json
import sys
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest import mock

from benchmarks.builtin_surface_construct_candidate import candidate_module


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'tests'))
import test_member_surface_cache as contracts

candidate = candidate_module()
contracts.orm_members = candidate
names = [
    'test_find_uses_its_own_surface_after_another_owner_populates_or_clears_cache',
    'test_late_old_build_does_not_evict_a_new_owner_surface',
    'test_model_invalidation_retries_an_inflight_surface_before_publishing',
    'test_build_failures_and_repeated_removed_labels_release_inflight_versions',
    'test_cold_and_warm_member_lookup_preserve_duplicate_name_winner',
    'test_member_records_preserve_replace_pickle_and_optional_wire_metadata',
    'test_shared_builtins_preserve_all_receiver_and_manager_metadata',
    'test_shared_builtin_templates_leave_custom_and_foreign_bindings_intact',
    'test_surface_export_uses_shared_metadata_without_materializing_builtins',
]
suite = unittest.TestSuite(contracts.MemberSurfaceCacheTests(name) for name in names)
output = io.StringIO()
result = unittest.TextTestRunner(stream=output).run(suite)
assert result.wasSuccessful(), output.getvalue()

assert not candidate._compact_builtin_items.get()
with mock.patch.object(candidate, '_member_surface', side_effect=ValueError('injected build error')):
    try:
        candidate._compact_member_surface()
    except ValueError:
        pass
    else:
        raise AssertionError('Build failure swallowed')
assert not candidate._compact_builtin_items.get()

token = candidate._compact_builtin_items.set(True)
try:
    with ThreadPoolExecutor(max_workers=1) as executor:
        assert not executor.submit(candidate._compact_builtin_items.get).result(timeout=3)
    assert candidate._compact_builtin_items.get()
finally:
    candidate._compact_builtin_items.reset(token)
assert not candidate._compact_builtin_items.get()

print(json.dumps({'candidateOnly': False, 'productionApplied': True,
    'existingCacheAndCompleteMemberContracts': len(names),
    'failureAndNestedThreadContextIsolation': True, 'passed': True,
    'scope': 'Selected existing actual owner/inflight/duplicate-winner/complete binding/optional wire '
             'metadata/replace/pickle/full export contracts under the candidate module, plus failure '
             'reset and nested thread context isolation. Not actual Django ready startup/editor proof.'}))
