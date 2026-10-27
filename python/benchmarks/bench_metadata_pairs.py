"""Paired complete cached graph restoration using a JSON object-pairs reader."""
import argparse
import json
import subprocess
import sys
import types
from pathlib import Path

from benchmarks import bench_metadata_rekey
from benchmarks.metadata_pairs_candidate import decode_metadata_pairs


def worker(files, repetitions):
    source = Path(bench_metadata_rekey.__file__).read_text()
    source = source[:source.index("if __name__ == '__main__':")]
    source = source.replace("'previous-new-dict'", "'current-object-hook'").replace("'candidate-inplace'", "'candidate-object-pairs'")
    module = types.ModuleType('benchmarks._metadata_pairs_harness')
    module.__file__ = str(bench_metadata_rekey.__file__)
    exec(compile(source, module.__file__ + ':pairs', 'exec'), module.__dict__)
    module.decode_metadata_inplace = decode_metadata_pairs
    return module.worker(files, repetitions)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--files', type=int, nargs='+', default=[1000, 5000, 10000])
    parser.add_argument('--repetitions', type=int, default=9)
    parser.add_argument('--worker', action='store_true')
    args = parser.parse_args()
    if args.worker:
        print(json.dumps(worker(args.files[0], args.repetitions)))
    else:
        rows = [json.loads(subprocess.check_output([sys.executable, '-m', 'benchmarks.bench_metadata_pairs',
            '--worker', '--files', str(count), '--repetitions', str(args.repetitions)], text=True)) for count in args.files]
        print(json.dumps({'date': '2026-10-10', 'productionApplied': False, 'rows': rows,
            'scope': 'Nine alternating complete readyconfigured graph cache restores/tier using originalhook andcandidateJSONobjectpairshydration. Read-local key/value/completeimmutablefieldowner/source/runtime/schema guards unchanged. Everygraphwirevalue/pk/scalar/FKalias checked; separatetracedallocationaboveinputowners. No actualstartup/editor/Node/native/aggregate/stablebudget proof.'}, indent=2))
