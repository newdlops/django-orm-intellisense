"""Run the configured startup fixture with worker-handoff phase timings."""
import argparse
import json
from pathlib import Path

from benchmarks import bench_ready_startup_phases as ready


def run(models, files, output_dir):
    exits = []
    original_close = ready.Client.close

    def close(client):
        original_close(client)
        exits.append(client.process.returncode)

    ready.Client.close = close
    try:
        result = ready.run(models, files, output_dir,
                           'benchmarks.profile_surface_worker_stages')
    finally:
        ready.Client.close = original_close
    assert exits == [0, 0, 0], exits
    for row in result['rows']:
        lines = Path(row['daemonLog']).read_text().splitlines()
        row['surfacePhaseCosts'] = [json.loads(line.removeprefix(
            '[surface-load:phase-cost] ')) for line in lines
            if line.startswith('[surface-load:phase-cost] ')]
        row['workerPhaseCosts'] = [json.loads(line.removeprefix(
            '[surface-worker:phase-cost] ')) for line in lines
            if line.startswith('[surface-worker:phase-cost] ')]
    result['scope'] += (' Diagnostic-only parent file/state and child restore/build clocks. '
        'Nested phases overlap and must not be summed; this is not ordinary latency '
        'or memory evidence.')
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--models', type=int, default=500)
    parser.add_argument('--files', type=int, default=5000)
    parser.add_argument('--output-dir', type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(run(args.models, args.files, args.output_dir), indent=2))
