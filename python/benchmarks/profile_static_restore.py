"""Single-thread diagnostic profile of full static cache restoration."""
import cProfile
import json
import pstats
import tempfile
from pathlib import Path
from unittest import mock

from benchmarks.bench_reindex import generate_synthetic_project
from django_orm_intellisense.cache import store
from django_orm_intellisense.discovery.workspace import snapshot_python_sources
from django_orm_intellisense.static_index.indexer import build_static_index


with tempfile.TemporaryDirectory(prefix='djls-static-restore-profile-') as temporary:
    root = Path(temporary).resolve() / 'workspace'
    root.mkdir()
    generate_synthetic_project(root, 500)
    helpers = root / 'helpers'
    helpers.mkdir()
    for number in range(5000 - len(list(root.rglob('*.py')))):
        (helpers / f'helper_{number}.py').write_text(f'value={number}\n')
    snapshot = snapshot_python_sources(root)
    expected = build_static_index(root, snapshot.files)
    with mock.patch.object(store, '_workspace_cache_dir', return_value=root.parent / 'cache'):
        store.save_static_index(root, snapshot, expected)
        profiler = cProfile.Profile()
        restored, hit = profiler.runcall(store.load_cached_static_index, root, snapshot)
    assert hit == 'full' and restored.to_cache_dict() == expected.to_cache_dict()
    assert restored.fields == expected.fields
    rows = [{'file': key[0], 'line': key[1], 'function': key[2],
             'calls': value[1], 'selfMs': value[2] * 1000, 'cumulativeMs': value[3] * 1000}
            for key, value in pstats.Stats(profiler).stats.items()]
    print(json.dumps({'pythonFiles': 5000, 'models': 500, 'completeStaticWireAndFieldsEqual': True,
        'bySelfTime': sorted(rows, key=lambda row: row['selfMs'], reverse=True)[:25],
        'byCumulativeTime': sorted(rows, key=lambda row: row['cumulativeMs'], reverse=True)[:25],
        'scope': 'One instrumented synchronous full static cache restore. Includes decode, module/model reconstruction, field resolution. cProfile wall cumulative includes descendants and must not be summed; not ordinary latency, whole startup/CPU share/heap or stable timing.'}, indent=2))
