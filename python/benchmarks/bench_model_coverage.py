"""Profile model coverage compute at 1000 models and 10000 files; excludes IPC."""
import cProfile
import json
import pstats
import sys
import tempfile
import time
from pathlib import Path
from benchmarks.bench_reindex import generate_synthetic_project
from django_orm_intellisense.static_index.indexer import build_static_index
from django_orm_intellisense.semantic.graph import build_model_graph
from django_orm_intellisense.runtime.inspector import create_pending_runtime_inspection
from django_orm_intellisense.server.app import DaemonServer


if __name__ == '__main__':
    with tempfile.TemporaryDirectory(prefix='djls-model-profile-') as folder:
        root = Path(folder)
        generate_synthetic_project(root, 1000)
        padding = root / 'helpers'
        padding.mkdir()
        for number in range(10000 - len(list(root.rglob('*.py')))):
            (padding / f'helper_{number}.py').write_text('value = 1\n')
        index = build_static_index(root, sorted(root.rglob('*.py')))
        runtime = create_pending_runtime_inspection(None)
        graph = build_model_graph(index, runtime)
        stdout = sys.stdout
        try:
            server = DaemonServer(root)
        finally:
            sys.stdout = stdout
        server.runtime_inspection = runtime
        server.static_index = index
        server.model_graph = graph
        server._last_surface_index = {}
        server._last_static_fallback = server._build_static_fallback(model_graph=graph, surface_index={})
        path = root / 'new_model.py'
        result = []
        for phase in ('create', 'delete'):
            if phase == 'create':
                path.write_text('from django.db import models\nclass NewEntry(models.Model):\n    body = models.TextField()\n    class Meta:\n        app_label = "extra"\n')
            else:
                path.unlink()
            profiler = cProfile.Profile()
            start = time.perf_counter()
            profiler.enable()
            outcome = server._compute_reindex(file_path=path, static_index=server.static_index,
                runtime=runtime, previous_model_graph=server.model_graph,
                existing_surface=server._last_surface_index, previous_static_fallback=server._last_static_fallback)
            profiler.disable()
            elapsed = (time.perf_counter() - start) * 1000
            server._commit_reindex(outcome)
            stats = pstats.Stats(profiler)
            result.append({'phase': phase, 'profiledComputeMs': elapsed,
                'models': len(outcome.model_graph.nodes_by_label), 'affected': len(outcome.affected_labels),
                'top': [{'file': key[0], 'line': key[1], 'function': key[2],
                         'calls': value[1], 'ownMs': value[2] * 1000, 'cumulativeMs': value[3] * 1000}
                        for key, value in sorted(stats.stats.items(), key=lambda pair: pair[1][3], reverse=True)[:25]]})
        print(json.dumps(result, indent=2))
