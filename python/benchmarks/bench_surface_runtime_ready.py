"""Configured full metadata/source-ready checks after runtime snapshot transfer."""
import argparse
import inspect
import json
from pathlib import Path

from benchmarks import bench_ready_startup_phases as ready


def run(models, file_count, output_dir):
    source = inspect.getsource(ready.run)
    marker = '                client.close()'
    assert source.count(marker) == 1
    source = source.replace(marker, marker + "\n                if rows and rows[-1]['phase'] == lifecycle:"
        "\n                    rows[-1]['daemonExitCode'] = client.process.returncode"
        "\n                    assert client.process.returncode == 0")
    namespace = dict(ready.__dict__)
    exec(compile(source, str(Path(ready.__file__)) + ':surface_runtime_ready', 'exec'), namespace)
    result = namespace['run'](models, file_count, output_dir, 'benchmarks.surface_runtime_profile_worker')
    for row in result['rows']:
        log = Path(row['daemonLog']).read_text()
        row['runtimeSurfacePhases'] = [json.loads(line.removeprefix('[surface-runtime:phase] '))
            for line in log.splitlines() if line.startswith('[surface-runtime:phase] ')]
    result['scope'] += (' Thin capture/file timing only, not cProfile or tracemalloc. Capture phase '
        'can wait for the cached-ready parent Django setup; runtime metadata file closes before '
        'worker reads.500model fixture has fields/custom parameterized transforms but no runtime '
        'attached methods; dynamic-member and stale-pyc fidelity are separate probes. Full source '
        'and scalar/FK metadata are checked; all three actual daemons exit0. No paired speedup, '
        'stable SLO/editor or aggregate RSS claim.')
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--models', type=int, default=500)
    parser.add_argument('--files', type=int, default=5000)
    parser.add_argument('--output-dir', type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(run(args.models, args.files, args.output_dir), indent=2))
