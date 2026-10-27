"""Warm surface construction/fingerprint/file allocations, excluding Django capture."""
import argparse
import gc
import json
import pickle
import statistics
import sys
import tempfile
import time
import tracemalloc
from pathlib import Path

from benchmarks.bench_reindex import generate_synthetic_project
from django_orm_intellisense.features import orm_members
from django_orm_intellisense.runtime.inspector import inspect_runtime
from django_orm_intellisense.runtime.source_imports import current_workspace_source_imports
from django_orm_intellisense.semantic.graph import build_model_graph
from django_orm_intellisense.server import runtime_members
from django_orm_intellisense.static_index.indexer import build_static_index


def run(models, repetitions):
    with tempfile.TemporaryDirectory(prefix='djls-refresh-surface-storage-') as temporary:
        root = Path(temporary).resolve()
        files = generate_synthetic_project(root, models)
        apps = sorted({file.parent.name for file in files})
        for app in apps:
            (root / app / 'models.py').write_text('\n'.join(f'from .{file.stem} import Model{file.stem.split("_")[-1]}'
                for file in files if file.parent.name == app) + '\n')
        (root / 'bench_settings.py').write_text(f'INSTALLED_APPS={apps!r}\nSECRET_KEY="storage"\n'
            'DEFAULT_AUTO_FIELD="django.db.models.BigAutoField"\n'
            'DATABASES={"default":{"ENGINE":"django.db.backends.sqlite3","NAME":":memory:"}}\n')
        sys.path.insert(0, str(root))
        static = build_static_index(root)
        with current_workspace_source_imports((root,)):
            runtime = inspect_runtime('bench_settings')
            graph = build_model_graph(static, runtime)
            snapshot = orm_members.capture_current_runtime_members(static, runtime, graph)
        static._runtime_member_snapshot = snapshot
        baseline = orm_members.prebuild_member_surface_cache(static, runtime, graph)
        old_fingerprints = orm_members.fingerprint_surface_index(baseline)
        path = root / 'result.pickle'
        def construct(mode):
            orm_members._surface_cache = orm_members._MemberSurfaceCache()
            started, cpu = time.perf_counter_ns(), time.process_time_ns()
            surface = (orm_members.prebuild_member_surface_cache(static, runtime, graph) if mode == 'full'
                else orm_members.build_surface_index(static, runtime, graph, labels={'app0.Model0'}))
            fingerprints = orm_members.fingerprint_surface_index(surface)
            result = runtime_members.RuntimeMemberRefresh(snapshot, surface, fingerprints, complete=mode == 'full')
            with path.open('wb') as stream:
                pickle.dump(result, stream, protocol=pickle.HIGHEST_PROTOCOL)
            return result, {'wallMs': (time.perf_counter_ns() - started) / 1e6,
                'processCpuMs': (time.process_time_ns() - cpu) / 1e6, 'resultFileBytes': path.stat().st_size}
        rows = []
        for mode in ('full', 'selective'):
            samples = []
            for _ in range(repetitions):
                result, sample = construct(mode)
                surface, fingerprints = runtime_members.compose_runtime_member_surface(static, graph, result,
                    baseline, old_fingerprints)
                assert surface == baseline and fingerprints == old_fingerprints
                samples.append(sample)
            del result, surface, fingerprints
            orm_members._surface_cache = orm_members._MemberSurfaceCache()
            gc.collect()
            tracemalloc.start()
            result, traced = construct(mode)
            retained, peak = tracemalloc.get_traced_memory()
            tracemalloc.stop()
            rows.append({'mode': mode, 'samples': samples,
                'medianWallMs': statistics.median(item['wallMs'] for item in samples),
                'medianProcessCpuMs': statistics.median(item['processCpuMs'] for item in samples),
                'tracedRetainedBytes': retained, 'tracedPeakBytes': peak,
                'tracedResultFileBytes': traced['resultFileBytes'], 'composedCompleteSurfaceEqual': True})
    return {'models': models, 'repetitions': repetitions, 'rows': rows,
        'scope': 'Warm loaded index/Django classes/current runtime records and prior full table are outside '
            'measurement. Separate untraced timing samples and one traced construction/fingerprint/direct-file '
            'sample per mode; global member cache reset before each build. All composed surface/fingerprint '
            'entries equal the full baseline. Field/builtin fixture has no dynamically attached methods; '
            'actual dynamic/named/canonical fidelity is checked separately. Not fresh capture/import/source '
            'guards, process-tree RSS, daemon/editor latency or aggregate peak-memory proof.'}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--models', type=int, default=500)
    parser.add_argument('--repetitions', type=int, default=9)
    args = parser.parse_args()
    print(json.dumps(run(args.models, args.repetitions), indent=2))
