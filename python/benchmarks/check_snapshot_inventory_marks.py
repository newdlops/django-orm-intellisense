"""Candidate full source oracle and existing source-guard regression suite."""
import json
import types
import unittest
from pathlib import Path
from unittest import mock

from benchmarks.snapshot_inventory_marks_candidate import candidate_module
from tests import test_source_snapshot_revalidation


# The oracle prefix has no executable checks until after candidate creation.
oracle_path = Path(__file__).with_name('check_snapshot_bounded_map.py')
source = oracle_path.read_text()
source = source[:source.index('submitted = []')]
module = types.ModuleType('benchmarks._inventory_marks_contracts')
source = source.replace('from benchmarks.snapshot_bounded_map_candidate import candidate_module, bounded_batches',
    'from benchmarks.snapshot_inventory_marks_candidate import candidate_module')
exec(compile(source, str(oracle_path) + ':inventory_marks', 'exec'), module.__dict__)

candidate = candidate_module()
suite = unittest.defaultTestLoader.loadTestsFromTestCase(test_source_snapshot_revalidation.SourceSnapshotRevalidationTests)
with mock.patch.object(test_source_snapshot_revalidation, 'workspace', candidate):
    result = unittest.TextTestRunner(verbosity=1).run(suite)
assert result.wasSuccessful()
print(json.dumps({'candidateOnly': True, 'sourceOracleCases': len(module.checks),
    'existingFreshSourceGuardCases': result.testsRun, 'passed': True,
    'scope': 'Candidate existing12currentstat/replacement/restoredmtime/editable/revoked/overlap/symlink/lexical/deletion/failedstat/deserialized identityguard regressions. Oracle11additionalcases; no production integration/currentafterfinalstat/platform proof.'}))
