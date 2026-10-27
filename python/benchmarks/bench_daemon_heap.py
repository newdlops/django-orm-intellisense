"""Actual daemon RPC allocations/RSS; instrumentation stays in this worker."""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


def worker(root):
    import gc
    import os
    import resource
    import subprocess
    import tracemalloc

    tracemalloc.start(1)
    if os.environ.get('DJLS_BENCH_PREVIOUS_RECORD_LAYOUT') == '1':
        from benchmarks.record_layout_control import install_previous_layout
        install_previous_layout()
    from django_orm_intellisense.server.app import DaemonServer
    if os.environ.get('DJLS_BENCH_WORKER_STATE_FILE') == '1':
        from benchmarks.worker_state_candidate import install
        install()
    if os.environ.get('DJLS_BENCH_HEAP_BOUNDARIES') == '1':
        from benchmarks.heap_boundaries import install
        install()
    if os.environ.get('DJLS_BENCH_CACHE_STREAM_CHUNK'):
        from benchmarks.cache_stream_candidate import candidate_module
        from django_orm_intellisense.cache import store
        candidate = candidate_module(object_depth=2,
            chunk_size=int(os.environ['DJLS_BENCH_CACHE_STREAM_CHUNK']))
        store._read_cache_payload = candidate._read_cache_payload
    if os.environ.get('DJLS_BENCH_ORDINARY_STREAM') == '1':
        from benchmarks.ordinary_cache_stream_candidate import candidate_module
        from django_orm_intellisense.cache import store
        store._read_cache_payload = candidate_module()._read_cache_payload
    if os.environ.get('DJLS_BENCH_GRAPH_ONLY_STREAM') == '1':
        from benchmarks.ordinary_cache_stream_candidate import graph_only_module
        from django_orm_intellisense.cache import store
        store._read_cache_payload = graph_only_module()._read_cache_payload
    if os.environ.get('DJLS_BENCHMARK_PLAIN_CACHE') == '1':
        from django_orm_intellisense.cache import store
        store._decode_cache_payload = lambda value: json.loads(value.read() if hasattr(value, 'read') else value)

    class MeasuredServer(DaemonServer):
        def _handle_request(self, request):
            if request.get('method') != 'benchmarkMemory':
                return super()._handle_request(request)
            params = request.get('params') or {}
            if params.get('collect'):
                gc.collect(2)
            current, peak = tracemalloc.get_traced_memory()
            process_rows = []
            for line in subprocess.check_output(['ps', '-axo', 'pid=,ppid=,rss=,comm='], text=True).splitlines():
                pid, parent, rss, executable = line.split(None, 3)
                process_rows.append((int(pid), int(parent), int(rss) * 1024, executable))
            descendants = {os.getpid()}
            while True:
                expanded = descendants | {pid for pid, parent, _, _ in process_rows if parent in descendants}
                if expanded == descendants:
                    break
                descendants = expanded
            owned_processes = [{'pid': pid, 'parentPid': parent, 'rssBytes': rss,
                                'executable': Path(executable).name}
                               for pid, parent, rss, executable in process_rows
                               if pid in descendants and Path(executable).name != 'ps']
            main_rss = next(row['rssBytes'] for row in owned_processes if row['pid'] == os.getpid())
            stats = tracemalloc.take_snapshot().statistics('lineno')
            result = {
                'phase': params.get('phase'), 'collected': bool(params.get('collect')),
                'tracedCurrentBytes': current, 'tracedPeakSincePreviousCheckpointBytes': peak,
                'tracerBookkeepingBytes': tracemalloc.get_tracemalloc_memory(),
                'rssBytes': main_rss,
                'processTreeRssObservedBytes': sum(row['rssBytes'] for row in owned_processes),
                'ownedProcessRss': owned_processes,
                'maxRssNativeUnits': resource.getrusage(resource.RUSAGE_SELF).ru_maxrss,
                'sourceFiles': self.source_snapshot.file_count if self.source_snapshot else 0,
                'modelCount': len(self.model_graph.nodes_by_label) if self.model_graph else 0,
                'surfaceModels': len(self._last_surface_index or {}),
                'allocationLines': [
                    {'file': str(stat.traceback[0].filename), 'line': stat.traceback[0].lineno,
                     'bytes': stat.size, 'allocations': stat.count}
                    for stat in stats[:30]],
            }
            self._write_response(request.get('id'), result)
            tracemalloc.reset_peak()

    MeasuredServer(root.resolve()).run_stdio()


def run(models, file_count, plain_cache=False):
    import tempfile
    from benchmarks.bench_daemon_lifecycle import Client
    from benchmarks.bench_reindex import generate_synthetic_project

    with tempfile.TemporaryDirectory(prefix='djls-daemon-heap-') as temporary:
        root = Path(temporary).resolve() / 'workspace'
        root.mkdir()
        files = generate_synthetic_project(root, models)
        generated_count = len(list(root.rglob('*.py')))
        assert file_count >= generated_count
        helpers = root / 'helpers'
        helpers.mkdir()
        for number in range(file_count - generated_count):
            (helpers / f'helper_{number}.py').write_text(f'value = {number}\n')
        cache = root.parent / 'cache'
        phases = []
        for lifecycle in ['cold', 'cached']:
            client = Client(root, cache, request_timeout_seconds=120,
                            worker_module='benchmarks.bench_daemon_heap', keep_log=True,
                            worker_environment={'DJLS_BENCHMARK_PLAIN_CACHE': '1' if plain_cache else '0'})
            try:
                checkpoints = []

                def checkpoint(phase):
                    result, _ = client.request('benchmarkMemory', {'phase': phase, 'collect': True})
                    checkpoints.append(result)
                    return result

                baseline = checkpoint('baseline')
                initialized, initialize_ms = client.request('initialize',
                    {'workspaceRoot': str(root), 'deferRuntime': True})
                assert len(initialized['modelNames']) == models
                field_kinds = ['CharField', 'IntegerField', 'BooleanField', 'DateTimeField',
                               'FloatField', 'DecimalField', 'UUIDField', 'DateField']
                for number in range(models):
                    label = f'app{number // 50}.Model{number}'
                    details = initialized['staticFallback'][label]['fieldDetails']
                    for field in range(15):
                        assert details[f'field_{field}']['fieldKind'] == field_kinds[field % 8]
                    for relation in range(2):
                        target = (number + relation + 1) % models
                        assert details[f'fk_{relation}']['relatedModelLabel'] == f'app{target // 50}.Model{target}'
                del initialized
                checkpoint('initialized')
                # Normal idle/on-demand production work publishes the full surface.
                client.request('resolveOrmMember', {'modelLabel': 'app0.Model0',
                    'receiverKind': 'instance', 'name': 'field_0'})
                surface = client.wait_for_notification('surfaceIndexChanged',
                    lambda params: len(params.get('surfaceIndex') or {}) == models,
                    timeout_seconds=120)
                assert len(surface['surfaceIndex']) == models
                for number in range(models):
                    label = f'app{number // 50}.Model{number}'
                    members = surface['surfaceIndex'][label]['instance']
                    for field in range(15):
                        assert members[f'field_{field}'][3] == field_kinds[field % 8]
                    for relation in range(2):
                        target = (number + relation + 1) % models
                        assert members[f'fk_{relation}'][1] == f'app{target // 50}.Model{target}'
                del surface
                full = checkpoint('full_surface')
                assert full['sourceFiles'] == file_count and full['surfaceModels'] == models
                for _ in range(100):
                    lookup, _ = client.request('resolveLookupPath', {'baseModelLabel': 'app0.Model0',
                        'value': 'field_0__icontains', 'method': 'filter'})
                    assert lookup['resolved']
                checkpoint('100_lookups')
                if lifecycle == 'cached':
                    original = files[0].read_text()
                    for revision in range(20):
                        kind = 'DateField' if revision % 2 == 0 else 'CharField'
                        text = original.replace('models.CharField(max_length=255)', 'models.DateField()') if kind == 'DateField' else original
                        files[0].write_text(text)
                        updated, _ = client.request('reindexFile', {'filePath': str(files[0])})
                        assert updated['changedLabels']
                        lookup, _ = client.request('resolveLookupPath', {'baseModelLabel': 'app0.Model0',
                            'value': 'field_0__exact', 'method': 'filter'})
                        assert lookup['terminalType']['outputFieldKind'] == kind
                        del updated
                        if revision in (0, 9, 19):
                            checkpoint(f'{revision + 1}_saves')
                    assert files[0].read_text() == original
                for point in checkpoints:
                    point['workspaceTracedDeltaBytes'] = point['tracedCurrentBytes'] - baseline['tracedCurrentBytes']
                    point['peakAboveBaselineBytes'] = point['tracedPeakSincePreviousCheckpointBytes'] - baseline['tracedCurrentBytes']
                    point['rssDeltaBytes'] = point['rssBytes'] - baseline['rssBytes']
                phases.append({'lifecycle': lifecycle, 'instrumentedInitializeRpcMs': initialize_ms,
                               'daemonLog': client.log.name, 'checkpoints': checkpoints})
            except BaseException:
                print(f'[heap benchmark] worker log retained: {client.log.name}', file=sys.stderr)
                print(Path(client.log.name).read_text(), file=sys.stderr)
                raise
            finally:
                client.close()
        return {'models': models, 'pythonFiles': file_count, 'phases': phases,
                'cacheDecoder': 'plain-control' if plain_cache else 'production-metadata-sharing',
                'scalarFieldChecksPerInitialization': models * 15,
                'relationTargetChecksPerInitialization': models * 2,
                'metadataVerified': True,
                'scope': 'Fresh actual Python daemon processes and newline JSON RPC, cold/cached initialize, complete normal surface publication,100 real lookups and20 cached saves with exact field-kind checks. Tracemalloc starts before importing the server and includes main-process Python allocations across threads, retained response/serialization objects and reporting overhead. Explicit GC is diagnostic. Main and live descendant RSS include tracer/native/module/allocator costs; process-tree RSS is an observed checkpoint value, not an aggregate peak. ru_maxrss remains in platform-native units. Excludes Node/VS Code heap, worker allocations outside the main tracer, configured Django runtime, C allocations absent from tracemalloc, imports preceding tracing, and stable/uninstrumented latency claims. Peak checkpoints reset after each report; allocation-line snapshots describe retained allocations, not peak contributors.'}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--stdio', action='store_true')
    parser.add_argument('--workspace', default='.')
    parser.add_argument('--models', type=int, default=100)
    parser.add_argument('--files', type=int, default=1000)
    parser.add_argument('--plain-cache', action='store_true')
    args = parser.parse_args()
    if args.stdio:
        worker(Path(args.workspace))
    else:
        if args.models < 3 or args.files < args.models:
            parser.error('At least3 models and enough files are required')
        print(json.dumps(run(args.models, args.files, args.plain_cache), indent=2))
