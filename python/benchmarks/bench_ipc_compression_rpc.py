"""Actual daemon RPC responses and complete values at each gzip level."""
import argparse
import gzip
import hashlib
import json
import statistics
import tempfile
from pathlib import Path

from benchmarks.bench_daemon_lifecycle import Client
from benchmarks.bench_reindex import generate_synthetic_project


def run(count, repetitions):
    with tempfile.TemporaryDirectory(prefix='djls-ipc-level-rpc-') as temporary:
        root = Path(temporary).resolve() / 'project'
        root.mkdir()
        files = generate_synthetic_project(root, count // 10)
        apps = sorted({file.parent.name for file in files})
        (root / 'level_settings.py').write_text(f'INSTALLED_APPS={apps!r}\nSECRET_KEY="levels"\n'
            'DATABASES={"default":{"ENGINE":"django.db.backends.sqlite3","NAME":":memory:"}}\n')
        for app in apps:
            (root / app / 'models.py').write_text('\n'.join(
                f'from .{file.stem} import Model{int(file.stem.split("_")[-1])}' for file in files if file.parent.name == app)+'\n')
        helper = root / 'helpers'
        helper.mkdir()
        for number in range(count-len(list(root.rglob('*.py')))):
            (helper / f'helper_{number}.py').write_text(f'value={number}\n')
        rows = []
        expected = None
        for level in [6, 3, 1]:
            client = Client(root, root.parent / f'cache-level-{level}', keep_log=True,
                request_timeout_seconds=120, worker_module='benchmarks.ipc_compression_level_worker',
                worker_environment={'DJLS_BENCH_IPC_LEVEL': str(level), 'DJLS_PROFILE_SURFACE_ADOPTION': '1'})
            try:
                initialized, initialize_ms = client.request('initialize', {'workspaceRoot': str(root),
                    'settingsModule': 'level_settings', 'deferRuntime': False})
                assert len(initialized['modelNames']) == count // 10
                full, initial_ms = client.request('relationTargets', {'prefix': ''})
                assert len(full['items']) == count // 10
                if expected is None: expected = full
                else: assert full == expected
                values = [item for item in full['items'] if item['objectName'] == 'Model0']
                assert len(values) == 1 and values[0]['source'] == 'runtime'
                samples = {'': [], 'Model0': []}
                for _ in range(repetitions):
                    for prefix in samples:
                        result, elapsed = client.request('relationTargets', {'prefix': prefix})
                        assert result['items'] == (expected['items'] if not prefix else values)
                        samples[prefix].append(elapsed)
                raw = json.dumps({'id': 1, 'result': full}, sort_keys=True).encode()
                archive = Path('bench') / f'ipc-compression-rpc-{count}-level{level}-relations.json.gz'
                archive.write_bytes(gzip.compress(raw))
            finally:
                client.close()
            assert client.process.returncode == 0
            log_path = Path('bench') / f'ipc-compression-rpc-{count}-level{level}-daemon.log'
            log_path.write_bytes(Path(client.log.name).read_bytes())
            log = log_path.read_text()
            rows.append({'level': level, 'initializeReadyRpcMs': initialize_ms,
                'initialFullListRpcMs': initial_ms, 'samplesMs': samples,
                'summary': {prefix: {'medianMs': statistics.median(values), 'maxMs': max(values),
                    'atOrAbove20Ms': sum(value >= 20 for value in values)} for prefix, values in samples.items()},
                'completeAllLevelAndPrefixValuesEqual': True, 'relationPayloadArchive': str(archive),
                'relationPayloadSha256': hashlib.sha256(raw).hexdigest(),
                'daemonExitCode': client.process.returncode, 'daemonLog': str(log_path),
                'writeProfiles': [json.loads(line.split('[ipc:profile] ', 1)[1]) for line in log.splitlines() if '[ipc:profile] ' in line]})
        return {'pythonFiles': count, 'models': count // 10, 'repetitions': repetitions, 'levels': rows}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--files', type=int, nargs='+', default=[1000, 5000, 10000])
    parser.add_argument('--repetitions', type=int, default=9)
    args = parser.parse_args()
    print(json.dumps({'date': '2026-10-10', 'productionApplied': False,
        'rows': [run(count, args.repetitions) for count in args.files],
        'scope': 'Fresh configured ready daemon per level/tier, actual ordinary relationTargets full/selective RPC includes encode/compress/pipe/base64/gunzip/JSONdecode and normal background surface work. Nine serial full/selective calls perlevel after initial fullreference. Every value/order acrosslevel/prefix equal and exit0required. Instrumented writeprofiles, fixed6/3/1ordering/coldcache/hostuncontrolled; not stablepaired startup, editor/Node/trueaggregatepeak or save correctness proof.'}, indent=2))
