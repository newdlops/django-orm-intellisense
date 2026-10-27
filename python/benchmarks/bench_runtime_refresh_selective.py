"""Rotating actual full/selective daemon comparison with whole payload checks."""
import argparse
import gzip
import json
import os
import statistics
from pathlib import Path

from benchmarks.bench_async_runtime_member_refresh import run as run_daemons


def read(path):
    with gzip.open(path, 'rt') as stream:
        return json.load(stream)


def normalize(value, root):
    if isinstance(value, dict):
        return {key: normalize(item, root) for key, item in value.items()}
    if isinstance(value, list):
        return [normalize(item, root) for item in value]
    if isinstance(value, str) and (value == root or value.startswith(root + os.sep)):
        return '$FIXTURE_ROOT' + value[len(root):]
    return value


def run(models, files, output_dir, repetitions):
    output_dir.mkdir(parents=True, exist_ok=True)
    pairs = []
    old_environment = os.environ.get('DJLS_BENCH_FORCE_FULL_REFRESH')
    try:
        for repetition in range(repetitions):
            modes = ('full', 'selective') if repetition % 2 == 0 else ('selective', 'full')
            pair = {}
            for mode in modes:
                os.environ['DJLS_BENCH_FORCE_FULL_REFRESH'] = '1' if mode == 'full' else '0'
                result = run_daemons(models, files, output_dir / f'{repetition}-{mode}',
                    'benchmarks.runtime_refresh_surface_mode_worker')
                path = output_dir / f'{repetition}-{mode}.json'
                path.write_text(json.dumps(result, indent=2) + '\n')
                pair[mode] = result
                print(f'[selective-refresh] repetition={repetition} mode={mode} daemons=2 exit0',
                    file=__import__('sys').stderr, flush=True)
            for before, after in zip(pair['full']['rows'], pair['selective']['rows']):
                assert before['phase'] == after['phase']
                first, second = read(before['payload']), read(after['payload'])
                first_root, second_root = first['health']['workspaceRoot'], second['health']['workspaceRoot']
                first['health'].pop('startedAt')
                second['health'].pop('startedAt')
                assert normalize(first, first_root) == normalize(second, second_root), before['phase']
            pairs.append(pair)
    finally:
        if old_environment is None:
            os.environ.pop('DJLS_BENCH_FORCE_FULL_REFRESH', None)
        else:
            os.environ['DJLS_BENCH_FORCE_FULL_REFRESH'] = old_environment
    samples = {mode: [row['asyncReadyFromFirstEditMs'] for pair in pairs
        for row in pair[mode]['rows'] if row['phase'] == 'replaced'] for mode in ('full', 'selective')}
    return {'models': models, 'pythonFiles': files, 'repetitions': repetitions, 'pairs': pairs,
        'secondEditReadyMs': samples, 'secondEditReadyMedianMs': {mode: statistics.median(rows) for mode, rows in samples.items()},
        'wholePayloadEqualExceptFixtureRootAndStartedAt': True,
        'scope': 'Sequential rotating full-surface control versus selective refresh in shared production '
            'source/capture/epoch/IPC machinery. Each mode has actual cold/cached daemons plus two paired '
            'source/helper edits; only second edit has an established full runtime baseline. All full '
            'payload fields compared after explicit fixture-root normalization and health.startedAt removal. '
            'No other fields/hashes omitted. Ordinary lookups and parent registry completion checked by '
            'underlying driver. Host uncontrolled; no stable SLO/editor or aggregate-peak-memory proof.'}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--models', type=int, default=500)
    parser.add_argument('--files', type=int, default=5000)
    parser.add_argument('--repetitions', type=int, default=3)
    parser.add_argument('--output-dir', type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(run(args.models, args.files, args.output_dir, args.repetitions), indent=2))
