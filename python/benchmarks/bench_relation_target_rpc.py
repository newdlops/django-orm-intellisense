"""Actual fresh-daemon relation target RPC; complete prefix results checked."""
import argparse
import json
import statistics
import tempfile
from pathlib import Path

from benchmarks.bench_daemon_lifecycle import Client
from benchmarks.bench_reindex import generate_synthetic_project


def run(count, repetitions):
    with tempfile.TemporaryDirectory(prefix='djls-relation-prefix-rpc-') as temporary:
        root = Path(temporary).resolve() / 'project'
        root.mkdir()
        files = generate_synthetic_project(root, count // 10)
        apps = sorted({file.parent.name for file in files})
        (root / 'rpc_settings.py').write_text(f'INSTALLED_APPS={apps!r}\nSECRET_KEY="relation-rpc"\n'
            'DATABASES={"default":{"ENGINE":"django.db.backends.sqlite3","NAME":":memory:"}}\n')
        for app in apps:
            (root / app / 'models.py').write_text('\n'.join(
                f'from .{file.stem} import Model{int(file.stem.split("_")[-1])}' for file in files if file.parent.name == app)+'\n')
        helper = root / 'helpers'
        helper.mkdir()
        for number in range(count-len(list(root.rglob('*.py')))):
            (helper / f'helper_{number}.py').write_text(f'value={number}\n')
        client = Client(root, root.parent / 'cache', keep_log=True, request_timeout_seconds=120)
        try:
            initialized, initialize_ms = client.request('initialize', {'workspaceRoot': str(root),
                'settingsModule': 'rpc_settings', 'deferRuntime': False})
            assert len(initialized['modelNames']) == count // 10
            full, full_ms = client.request('relationTargets', {'prefix': ''})
            assert len(full['items']) == count // 10
            values = {item['label']: item for item in full['items']}
            assert values['app0.Model0']['source'] == 'runtime'
            samples = {prefix: [] for prefix in ['Model0', 'not_found', 'app0.', '']}
            for _ in range(repetitions):
                for prefix in samples:
                    result, elapsed_ms = client.request('relationTargets', {'prefix': prefix})
                    expected = [item for item in full['items'] if not prefix or any(
                        str(item.get(key) or '').lower().startswith(prefix.lower())
                        for key in ['label', 'objectName', 'module', 'importPath'])]
                    assert result['items'] == expected
                    samples[prefix].append(elapsed_ms)
            log = Path(client.log.name).read_text()
            return {'pythonFiles': count, 'models': count // 10, 'initializeReadyRpcMs': initialize_ms,
                'initialFullListRpcMs': full_ms, 'repetitions': repetitions, 'samplesMs': samples,
                'summary': {prefix: {'medianMs': statistics.median(values), 'maxMs': max(values),
                    'over20Ms': sum(value >= 20 for value in values)} for prefix, values in samples.items()},
                'completePrefixValuesEqual': True, 'daemonLog': client.log.name,
                'serverRelationTimings': [line for line in log.splitlines() if 'relationTargets#' in line]}
        finally:
            client.close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--files', type=int, nargs='+', default=[1000, 5000, 10000])
    parser.add_argument('--repetitions', type=int, default=9)
    args = parser.parse_args()
    print(json.dumps({'productionApplied': True, 'rows': [run(count, args.repetitions) for count in args.files],
        'scope': 'Nine complete actual relationTargets RPCs per four prefixes/tier following ready configured fresh initialization. Full returned values/order compare to initial full snapshot. Includes newline encoding/transport/handler/response decode and possible normal background surface work. Startup single samples,host uncontrolled; no stable all-RPC or VS Code/editor/aggregate memory claim.'}, indent=2))
