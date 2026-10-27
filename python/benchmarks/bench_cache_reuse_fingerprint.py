"""Pair previous/full directory checks and exact-fingerprint short circuit."""
import json
import statistics
import tempfile
import time
import types
from pathlib import Path
from unittest import mock

from benchmarks.bench_reindex import generate_synthetic_project
from django_orm_intellisense.cache import store
from django_orm_intellisense.discovery.workspace import snapshot_python_sources
from django_orm_intellisense.static_index.indexer import build_static_index


def previous_module():
    source = Path(store.__file__).read_text()
    old = '''        if cached_file_fingerprint != entry.fingerprint and not _is_under_unchanged_tree(
            entry.directory_path, unchanged_directories,
        ):'''
    assert source.count(old) == 2
    new = '''        file_is_unchanged = cached_file_fingerprint == entry.fingerprint
        tree_is_unchanged = _is_under_unchanged_tree(entry.directory_path, unchanged_directories)
        if not file_is_unchanged and not tree_is_unchanged:'''
    module = types.ModuleType('django_orm_intellisense.cache._previous_cache_reuse')
    module.__package__ = store.__package__
    exec(compile(source.replace(old, new), str(store.__file__) + ':previous', 'exec'), module.__dict__)
    return module


def run(file_count, repetitions=9):
    with tempfile.TemporaryDirectory(prefix='djls-cache-reuse-cost-') as temporary:
        root = Path(temporary).resolve() / 'project'
        root.mkdir()
        files = generate_synthetic_project(root, file_count // 10)
        count = len(list(root.rglob('*.py')))
        helper = root / 'helpers'
        helper.mkdir()
        for number in range(file_count - count):
            (helper / f'helper_{number}.py').write_text(f'value={number}\n')
        initial = snapshot_python_sources(root)
        index = build_static_index(root, initial.files)
        cache = root.parent / 'cache'
        with mock.patch.object(store, '_workspace_cache_dir', return_value=cache):
            store.save_static_index(root, initial, index)
        files[0].write_text(files[0].read_text().replace('field_0 = models.CharField', 'field_0 = models.TextField'))
        current = snapshot_python_sources(root)
        expected = build_static_index(root, current.files).to_cache_dict()
        previous = previous_module()
        modes = {'previous-always-tree': previous, 'current-exact-file-first': store}
        samples = {mode: [] for mode in modes}
        for round in range(repetitions):
            for mode in list(modes) if round % 2 == 0 else list(reversed(modes)):
                module = modes[mode]
                with mock.patch.object(module, '_workspace_cache_dir', return_value=cache):
                    cpu, started = time.process_time_ns(), time.perf_counter_ns()
                    restored, hit = module.load_cached_static_index(root, current)
                    row = {'wallMs': (time.perf_counter_ns() - started) / 1e6,
                           'cpuMs': (time.process_time_ns() - cpu) / 1e6}
                assert hit == 'partial' and restored.to_cache_dict() == expected
                row['partialFullIndexEqual'] = True
                samples[mode].append(row)
        calls = {}
        for mode, module in modes.items():
            with mock.patch.object(module, '_workspace_cache_dir', return_value=cache):
                with mock.patch.object(module, '_is_under_unchanged_tree', wraps=module._is_under_unchanged_tree) as checked:
                    restored, hit = module.load_cached_static_index(root, current)
                calls[mode] = checked.call_count
        assert calls['previous-always-tree'] == file_count and calls['current-exact-file-first'] == 1
        return {'pythonFiles': file_count, 'models': file_count // 10, 'repetitions': repetitions,
            'samples': samples, 'directoryChecks': calls,
            'summary': {mode: {'wallMedianMs': statistics.median(row['wallMs'] for row in values),
                              'cpuMedianMs': statistics.median(row['cpuMs'] for row in values)}
                        for mode, values in samples.items()}}


if __name__ == '__main__':
    print(json.dumps({'date': '2026-10-09', 'rows': [run(count) for count in [1000, 5000, 10000]],
        'scope': 'Alternating9 actual full+partial cache restore calls after one changed model source in complete1K/5K/10K fixture. Full restored index/fields/wire equals fresh current source each call, schema34/formats/fingerprint2 preserved. Counts directory checks separately. Cache decode/index reconstruction/disk reads included; no runtime/daemon/RPC/wholeheap/stable percentage. Host uncontrolled.'}, indent=2))
