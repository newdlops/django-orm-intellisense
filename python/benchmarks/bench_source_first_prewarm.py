"""Paired ordinary cached full-ready runs for source-first prewarm scheduling."""
import argparse
import inspect
import json
from pathlib import Path

from benchmarks import bench_static_stream_ready as paired


def ready_source():
    source = inspect.getsource(paired.ready.run)
    marker = '                encoded = json.dumps(full).encode()'
    assert source.count(marker) == 1
    source = source.replace(marker, '''                lookup, lookup_ms = client.request('resolveLookupPath', {
                    'baseModelLabel': label, 'value': 'field_0__field_size__exact', 'method': 'filter'})
                assert lookup['resolved'], lookup
                registry_deadline = time.perf_counter() + 30
                while 'runtime_field_registry(background) ready' not in Path(client.log.name).read_text():
                    assert time.perf_counter() < registry_deadline, 'Parent runtime registry did not finish'
                    time.sleep(0.01)
                registry_ready_ms = (time.perf_counter() - client.started) * 1000
''' + marker)
    marker = "'completeModelScalarAndFkMetadata': True, 'payload': str(payload),"
    assert source.count(marker) == 1
    return source.replace(marker, "'completeModelScalarAndFkMetadata': True, 'payload': str(payload), "
        "'firstPostReadyCustomLookupRpcMs': lookup_ms, 'firstPostReadyCustomLookupResolved': True, "
        "'fullSurfaceAndParentRegistryReadyFromClientStartMs': registry_ready_ms, "
        "'parentRegistryReadyBeforeShutdown': True,")


def run(models, files, output_dir, repetitions):
    source = inspect.getsource(paired.run)
    for old, new in [
        ('DJLS_BENCH_STATIC_LEGACY_RESTORE', 'DJLS_BENCH_SOURCE_FIRST_PREVIOUS'),
        ('benchmarks.static_stream_restore_worker', 'benchmarks.source_first_prewarm_worker'),
        ('source = inspect.getsource(ready.run)', 'source = ready_source()'),
    ]:
        assert source.count(old) == 1
        source = source.replace(old, new)
    namespace = {**paired.__dict__, 'ready_source': ready_source}
    exec(compile(source, str(Path(paired.__file__)) + ':source_first_prewarm', 'exec'), namespace)
    result = namespace['run'](models, files, output_dir, repetitions)
    for row in result['rows']:
        if row['phase'].startswith('cached-'):
            assert 'load_cached_surface_index(background)' in Path(row['daemonLog']).read_text()
            row['actualOrdinarySurfaceCacheHit'] = True
    result['productionApplied'] = False
    cached = [row for row in result['rows'] if row['phase'].startswith('cached-')]
    for mode in ('previous', 'current'):
        result['summary'][mode].update({key: paired.statistics.median(
            row[key] for row in cached if row['mode'] == mode) for key in (
                'firstPostReadyCustomLookupRpcMs',
                'fullSurfaceAndParentRegistryReadyFromClientStartMs')})
    result['scope'] = ('Candidate scheduling only; actual sequential configured Django daemons '
        'on one source/cache, rotating ordinary cached hits. Both modes use the same candidate '
        'wrapper/bootstrap. Previous starts parent Django setup while surface-path warming '
        'runs concurrently; candidate warms the foreground source/dependency caches before '
        'Django setup in the existing prewarm thread. All work, stat/path validation, metadata '
        'and IPC retained. Entire cached response equals except health.startedAt; all model, '
        'scalar/FK/custom output and current-source cold/edit assertions remain. No aggregate '
        'RSS, all-lookup/editor latency, stable SLO or same-process dynamic refresh claim. '
        'Measure the first custom lookup after full publication and wait for actual parent '
        'runtime-registry readiness before shutdown; a daemon thread still importing Django '
        'cannot be counted as complete preparation just because cached surface is public.')
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--models', type=int, default=500)
    parser.add_argument('--files', type=int, default=5000)
    parser.add_argument('--repetitions', type=int, default=3)
    parser.add_argument('--output-dir', type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(run(args.models, args.files, args.output_dir, args.repetitions), indent=2))
