"""Paired actual configured ready startups on one unchanged source/cache."""
import argparse
import copy
import inspect
import json
import statistics
from pathlib import Path

from benchmarks import bench_ready_startup_phases as ready


def run(models, file_count, output_dir, repetitions):
    sequence = [('cold', 'current')]
    for revision in range(repetitions):
        modes = ['previous', 'current'] if revision % 2 == 0 else ['current', 'previous']
        sequence.extend((f'cached-{revision}-{mode}', mode) for mode in modes)
    sequence.append(('same_size_source_edit', 'current'))
    source = inspect.getsource(ready.run)
    old = "for lifecycle in ['cold', 'cached', 'same_size_source_edit']:"
    assert source.count(old) == 1
    source = source.replace(old, 'for lifecycle, mode in paired_sequence:')
    old = 'keep_log=True, worker_module=worker_module)'
    assert source.count(old) == 1
    source = source.replace(old, 'keep_log=True, worker_module=worker_module, '
        "worker_environment={'DJLS_BENCH_STATIC_LEGACY_RESTORE': '1' if mode == 'previous' else '0'})")
    old = "rows.append({'phase': lifecycle, 'initializeRpcMs': rpc_ms,"
    assert source.count(old) == 1
    source = source.replace(old, "rows.append({'phase': lifecycle, 'mode': mode, 'initializeRpcMs': rpc_ms,")
    old = '                client.close()'
    assert source.count(old) == 1
    source = source.replace(old, old + "\n                if rows and rows[-1]['phase'] == lifecycle:"
        "\n                    rows[-1]['daemonExitCode'] = client.process.returncode"
        "\n                    assert client.process.returncode == 0")
    namespace = {**ready.__dict__, 'paired_sequence': sequence}
    exec(compile(source, str(Path(ready.__file__)) + ':paired_static_stream', 'exec'), namespace)
    result = namespace['run'](models, file_count, output_dir, 'benchmarks.static_stream_restore_worker')
    cached = [row for row in result['rows'] if row['phase'].startswith('cached-')]
    reference = None
    for row in cached:
        payload = copy.deepcopy(json.loads(Path(row['payload']).read_text()))
        payload['health'].pop('startedAt')
        if reference is None:
            reference = payload
        else:
            assert payload == reference, row['phase']
        row['completeResponseEqualExceptDaemonStartedAt'] = True
    result['productionApplied'] = True
    result['pairedCachedRepetitions'] = repetitions
    result['summary'] = {mode: {key: statistics.median(row[key] for row in cached if row['mode'] == mode)
        for key in ['initializeRpcMs', 'fullSurfaceReadyFromClientStartMs']}
        for mode in ['previous', 'current']}
    result['scope'] = ('Sequential fresh configured daemons on one source/cache; rotating paired cached '
        'runs compare previous whole JSON static restore against current streaming restore, with actual '
        'production classes/IPC/three source passes. Entire cached response equal except daemon startedAt; '
        'all 500 model/scalar/FK/custom output checks and current same-size edit first response. '
        'Ordinary timings on uncontrolled host, not stable SLO or aggregate process memory.')
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--models', type=int, default=500)
    parser.add_argument('--files', type=int, default=5000)
    parser.add_argument('--repetitions', type=int, default=5)
    parser.add_argument('--output-dir', type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(run(args.models, args.files, args.output_dir, args.repetitions), indent=2))
