"""Full configured startup with thin surface-load and initializer phase observations."""
import argparse
import json
from pathlib import Path

from benchmarks import bench_ready_startup_phases as ready


def run(models, files, output_dir):
    terminal_exits = []
    original_close = ready.Client.close
    def close(client):
        original_close(client)
        terminal_exits.append(client.process.returncode)
    ready.Client.close = close
    try:
        result = ready.run(models, files, output_dir, 'benchmarks.profile_surface_load_worker')
    finally:
        ready.Client.close = original_close
    assert terminal_exits == [0, 0, 0]
    for row, code in zip(result['rows'], terminal_exits):
        row['daemonExitCode'] = code
        row['surfacePhaseCosts'] = [json.loads(line.removeprefix('[surface-load:phase-cost] '))
            for line in Path(row['daemonLog']).read_text().splitlines()
            if line.startswith('[surface-load:phase-cost] ')]
    result['scope'] += (' Thin phase clocks are across all threads; nested and overlapping '
        'rows must not be summed. Not ordinary uninstrumented latency, aggregate memory '
        'or speedup proof. Current-source first response and complete500model metadata checked.')
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--models', type=int, default=500)
    parser.add_argument('--files', type=int, default=5000)
    parser.add_argument('--output-dir', type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(run(args.models, args.files, args.output_dir), indent=2))
