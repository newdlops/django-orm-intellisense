"""Pair complete current inventory/stat scans and a single membership table."""
import argparse
import json
import os
import types
from pathlib import Path

from benchmarks import bench_snapshot_bounded_map
from benchmarks.snapshot_inventory_marks_candidate import candidate_module


def run(files, repetitions, delay):
    source = Path(bench_snapshot_bounded_map.__file__).read_text()
    source = source[:source.index("if __name__ == '__main__':")]
    final = os.environ.get('DJLS_BENCH_CURRENT_INVENTORY_MARKS') == '1'
    source = source.replace("'current-eager-map'", "'previous-two-membership-sets'" if final else "'current-two-membership-sets'").replace("'candidate-bounded-map'", "'current-membership-marks'" if final else "'candidate-membership-marks'")
    if final:
        source = source.replace("modes = {'previous-two-membership-sets': workspace.snapshot_python_sources,", "previous_owner = candidate_module(previous=True)\n        modes = {'previous-two-membership-sets': previous_owner.snapshot_python_sources,")
    module = types.ModuleType('benchmarks._inventory_marks_harness')
    module.__file__ = str(bench_snapshot_bounded_map.__file__)
    exec(compile(source, module.__file__ + ':inventory_marks', 'exec'), module.__dict__)
    module.candidate_module = candidate_module
    return module.run(files, repetitions, delay)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--files', type=int, nargs='+', default=[1000, 5000, 10000])
    parser.add_argument('--repetitions', type=int, default=9)
    parser.add_argument('--delay', type=float, default=0)
    args = parser.parse_args()
    print(json.dumps({'date': '2026-10-10', 'productionApplied': os.environ.get('DJLS_BENCH_CURRENT_INVENTORY_MARKS') == '1',
        'rows': [run(count, args.repetitions, args.delay) for count in args.files],
        'scope': 'Alternating9wholeunchangedcurrentinventory/stat/fingerprint/order/owner scanspertier. Candidateusesonesourcepath->observedbooltableinsteadexpectedset+secondobservedstringset; samefreshwalk/stat/64filebatch8workers/unsafe fallback. Completesnapshot/currentowner equalityeachcall; separatelytracedfunctionpeak. Optional0.2msstatdelay, noactualstartup/allraces/platform/trueaggregatepeak proof.'}, indent=2))
