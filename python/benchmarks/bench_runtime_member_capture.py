"""Cost and transient allocations of the required parent runtime metadata capture."""
import argparse
import gc
import json
import statistics
import sys
import tempfile
import time
import tracemalloc
from pathlib import Path

from benchmarks.bench_reindex import generate_synthetic_project
from django_orm_intellisense.features import orm_members
from django_orm_intellisense.runtime.inspector import inspect_runtime
from django_orm_intellisense.semantic.graph import build_model_graph
from django_orm_intellisense.server.worker_state import runtime_member_state_file
from django_orm_intellisense.static_index.indexer import build_static_index


def run(count, attached):
    with tempfile.TemporaryDirectory(prefix='djls-runtime-member-capture-') as temporary:
        root = Path(temporary)
        files = generate_synthetic_project(root, count)
        apps = sorted({path.parent.name for path in files})
        for name in apps:
            imports = []
            for path in files:
                if path.parent.name != name:
                    continue
                model = 'Model' + path.stem.split('_')[-1]
                if attached:
                    with path.open('a') as stream:
                        stream.write(f'\ndef attached(self) -> {model}:\n    return self\n{model}.attached = attached\n')
                imports.append(f'from .{path.stem} import {model}')
            (root / name / 'models.py').write_text('\n'.join(imports) + '\n')
        (root / 'capture_settings.py').write_text(f'INSTALLED_APPS={apps!r}\nSECRET_KEY="capture"\n'
            'DEFAULT_AUTO_FIELD="django.db.models.BigAutoField"\n'
            'DATABASES={"default":{"ENGINE":"django.db.backends.sqlite3","NAME":":memory:"}}\n')
        sys.path.insert(0, str(root))
        static = build_static_index(root)
        runtime = inspect_runtime('capture_settings')
        assert runtime.bootstrap_status == 'ready', runtime.bootstrap_error
        graph = build_model_graph(static, runtime)
        orm_members.prebuild_runtime_workspace_paths(static, runtime)
        samples = []
        def validate(members):
            assert sum(map(len, members.values())) == (count * 2 if attached else 0)
            if attached:
                for candidate in static.model_candidates:
                    for kind in ('instance', 'model_class'):
                        item, = members[(candidate.label, kind, None)]
                        assert item.name == 'attached' and item.model_label == candidate.label
                        assert item.return_kind == 'instance' and item.return_model_label == candidate.label
        for _ in range(9):
            gc.collect()
            cpu, wall = time.process_time_ns(), time.perf_counter_ns()
            members = orm_members.capture_runtime_member_surface(static, runtime)
            samples.append({'wallMs': (time.perf_counter_ns() - wall) / 1e6,
                            'cpuMs': (time.process_time_ns() - cpu) / 1e6})
            validate(members)
            del members
        gc.collect()
        tracemalloc.start()
        members = orm_members.capture_runtime_member_surface(static, runtime)
        retained, peak = tracemalloc.get_traced_memory()
        tracemalloc.stop()
        validate(members)
        with runtime_member_state_file(members) as path:
            file_bytes = Path(path).stat().st_size
        return {'models': count, 'attachedMethodPerModel': attached, 'samples': samples,
            'summary': {**{key: statistics.median(row[key] for row in samples) for key in ('wallMs', 'cpuMs')},
                'retainedCaptureBytes': retained, 'peakCaptureBytes': peak, 'runtimeStateFileBytes': file_bytes},
            'expectedRuntimeMemberRecords': count * 2 if attached else 0,
            'scope': 'Current actual initialized Django classes and static/graph owners, source membership '
                'prewarmed as in production. Nine uninstrumented parent capture calls, separate '
                'tracemalloc call, every model binding checked. Trace excludes existing Django/input '
                'owners and process transport/file write; not whole startup/editor/aggregate RSS or '
                'a speedup against the previous incomplete worker result.'}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--models', type=int, default=500)
    parser.add_argument('--attached', action='store_true')
    args = parser.parse_args()
    print(json.dumps(run(args.models, args.attached), indent=2))
