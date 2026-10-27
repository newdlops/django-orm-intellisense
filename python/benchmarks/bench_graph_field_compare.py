"""Use the complete ready-runtime graph fixture to compare full field checks."""
import argparse
import json
import subprocess
import sys
import types
from pathlib import Path

from benchmarks import bench_graph_cache_reuse
from benchmarks.graph_field_compare_candidate import candidate_module
from django_orm_intellisense.cache import store


def worker(files, repetitions):
    # Existing paired harness checks all graph values and owner identities.
    source = Path(bench_graph_cache_reuse.__file__).read_text()
    source = source[:source.index("if __name__ == '__main__':")]
    source = source.replace('previous = previous_module() if final else store', 'previous = store')
    source = source.replace("**({'static_index': index} if reuse else {})", "static_index=index")
    source = source.replace("'previous-independent'", "'previous-dict-check'")
    source = source.replace("assert identities['previous-dict-check'] == 0 and max(identities.values()) > 0",
        "assert identities['previous-dict-check'] == identities['candidate-reuse'] > 0")
    module = types.ModuleType('benchmarks._graph_field_compare_harness')
    exec(compile(source, str(bench_graph_cache_reuse.__file__) + ':field_compare', 'exec'), module.__dict__)
    module.candidate_module = candidate_module
    result = module.worker(files, repetitions, False)
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--files', type=int, nargs='+', default=[1000, 5000, 10000])
    parser.add_argument('--repetitions', type=int, default=9)
    parser.add_argument('--worker', action='store_true')
    args = parser.parse_args()
    if args.worker:
        print(json.dumps(worker(args.files[0], args.repetitions)))
    else:
        rows = []
        for count in args.files:
            output = subprocess.check_output([sys.executable, '-m', 'benchmarks.bench_graph_field_compare',
                '--worker', '--files', str(count), '--repetitions', str(args.repetitions)], text=True)
            rows.append(json.loads(output))
        print(json.dumps({'productionApplied': False, 'rows': rows,
            'scope': f'{args.repetitions} alternating full configured ready-runtime graph cache restores per tier. Compare exact dictionary field equality with direct complete-field comparison; both reuse only the supplied frozen owner and preserve schema/source/runtime guards. Complete graph metadata and identity oracles plus independent allocation probes; no whole-startup/RPC/editor/aggregate-memory claim.'}, indent=2))
