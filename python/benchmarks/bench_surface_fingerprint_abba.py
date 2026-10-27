"""Uninstrumented ABBA startup comparison for saved versus recomputed hashes."""
import argparse
import json
from pathlib import Path

from benchmarks.bench_ready_startup_phases import run


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--output-dir', type=Path, required=True)
    parser.add_argument('--models', type=int, default=500)
    parser.add_argument('--files', type=int, default=5000)
    parser.add_argument('--reverse', action='store_true', help='Run candidate/control/control/candidate order.')
    args = parser.parse_args()
    args.output_dir.mkdir(parents=True, exist_ok=True)
    recompute = 'benchmarks.worker_recompute_surface_fingerprints'
    cached = 'django_orm_intellisense'
    modes = ['reuse', 'recompute', 'recompute', 'reuse'] if args.reverse else [
        'recompute', 'reuse', 'reuse', 'recompute']
    workers = {'recompute': recompute, 'reuse': cached}
    order = [(mode, workers[mode]) for mode in modes]
    cohorts = []
    for number, (mode, worker) in enumerate(order, start=1):
        result = run(args.models, args.files, args.output_dir / f'run-{number}-{mode}', worker)
        cohorts.append({'run': number, 'mode': mode, 'rows': result['rows']})
    summary = {
        'models': args.models,
        'pythonFiles': args.files,
        'order': [mode for mode, _ in order],
        'cohorts': cohorts,
        'scope': 'Uninstrumented alternating control/candidate/candidate/control. Each cohort gets a fresh generated workspace/cache and complete first-response plus all-model scalar/FK/catalogue metadata checks. Control uses the same production surface cache loader but intentionally ignores persisted fingerprints and recomputes them; its cache file still carries the small metadata extension. Host uncontrolled; not an aggregate memory/editor/platform/full-goal pass.',
    }
    (args.output_dir / 'summary.json').write_text(json.dumps(summary, indent=2) + '\n')
    print(json.dumps(summary, indent=2))


if __name__ == '__main__':
    main()
