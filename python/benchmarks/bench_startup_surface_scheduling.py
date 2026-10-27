"""Compare existing surface idle-delay controls during real deferred startup.

Runs independent cold/cached daemons in ABBA order with no production patches.
The separate Node client timestamps notification receipt rather than the later
poll that observes it. This is a CLI protocol measurement, not an editor SLO.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import sys
import tarfile
from pathlib import Path

from benchmarks.bench_async_runtime_member_refresh import create_fixture


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def run(models: int, files: int, output_dir: Path, smoke: bool = False) -> dict:
    assert models >= 3
    output_dir.mkdir(parents=True, exist_ok=False)
    root = output_dir / 'fixture'
    root.mkdir()
    source, helper, _ = create_fixture(root, models, files)
    uuid_model = root / 'app0' / 'model_1.py'
    uuid_model.write_text(uuid_model.read_text().replace('class Model1(models.Model):',
        'class Model1(models.Model):\n    key = models.UUIDField(primary_key=True)'))
    # The old bytecode of Model0/helper is deliberately kept by create_fixture.
    # Model1 has no precompiled bytecode before the changed source is imported.
    paths = sorted(root.rglob('*.py'))
    assert len(paths) == files
    digest = hashlib.sha256()
    for path in paths:
        digest.update(path.relative_to(root).as_posix().encode() + b'\0' + path.read_bytes() + b'\0')
    tree_sha = digest.hexdigest()
    fixture_archive = output_dir / 'fixture-source.tar.gz'
    with tarfile.open(fixture_archive, 'w:gz') as archive:
        for path in paths:
            archive.add(path, arcname=path.relative_to(root), recursive=False)
    repo = Path(__file__).resolve().parents[2]
    probe = repo / 'scripts' / 'probe-startup-surface-scheduling.cjs'
    rows = []
    for workload in (['interactive'] if smoke else ['idle', 'interactive']):
        for index, idle_ms in enumerate([2000] if smoke else [2000, 0, 0, 2000]):
            folder = output_dir / f'{workload}-{index}-{idle_ms}ms'
            folder.mkdir()
            manifest = {
                'root': str(root), 'cache': str(folder / 'cache'),
                'python': sys.executable, 'pythonPath': str(repo / 'python'),
                'workerModule': 'django_orm_intellisense',
                'models': models, 'pythonFiles': files, 'idleMs': idle_ms,
                'workload': workload, 'transportVersion': 1,
                'sourceTreeSha256': tree_sha, 'probeSha256': sha(probe),
                'driverSha256': sha(Path(__file__)),
                'productionSha256': {name: sha(repo / name) for name in [
                    'python/django_orm_intellisense/server/app.py',
                    'python/django_orm_intellisense/semantic/graph.py',
                    'python/django_orm_intellisense/static_index/indexer.py',
                    'python/django_orm_intellisense/runtime/source_fields.py',
                    'python/django_orm_intellisense/cache/store.py']},
            }
            manifest_path = folder / 'manifest.json'
            manifest_path.write_text(json.dumps(manifest, indent=2) + '\n')
            completed = subprocess.run(['node', str(probe), str(manifest_path), str(folder)],
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            (folder / 'node-stderr.log').write_text(completed.stderr)
            (folder / 'node-stdout.log').write_text(completed.stdout)
            assert completed.returncode == 0, f'Node probe failed: {folder}: {completed.stderr}'
            result = json.loads(completed.stdout)
            (folder / 'result.json').write_text(json.dumps(result, indent=2) + '\n')
            rows.append({'index': index, 'idleMs': idle_ms, 'workload': workload,
                         'artifact': str(folder / 'result.json'), 'result': result})
            print(f'[startup-scheduling] {workload} {index} idleMs={idle_ms} '
                  'cold+cached terminalExit0', file=sys.stderr, flush=True)
    current_digest = hashlib.sha256()
    for path in sorted(root.rglob('*.py')):
        current_digest.update(path.relative_to(root).as_posix().encode() + b'\0' + path.read_bytes() + b'\0')
    assert current_digest.hexdigest() == tree_sha, 'Source fixture changed during measurements'
    return {
        'models': models, 'pythonFiles': files, 'sourceTreeSha256': tree_sha,
        'fixtureArchive': str(fixture_archive), 'fixtureArchiveSha256': sha(fixture_archive),
        'order': 'smoke' if smoke else 'ABBA', 'driverSha256': sha(Path(__file__)),
        'probeSha256': sha(probe), 'python': sys.version, 'rows': rows,
        'sourceTreeUnchangedAfterAllDaemons': True,
        'inheritedSchedulingEnvironment': {key: value for key, value in os.environ.items()
            if key.startswith('DJLS_SURFACE_')},
        'scope': 'Fresh real configured Python daemons, deferRuntime=true, compact transport v1, '
            'serial Node foreground RPCs from the initial response until full surface receipt. '
            'Both controls use existing environment options; no production scheduling change. '
            'Cold means absent application cache, not cold filesystem or OS page cache. '
            'Host load is uncontrolled. Stable timing, actual editor/adoption, total memory, '
            'parent registry readiness and broad SLO remain open.',
    }


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--models', type=int, default=500)
    parser.add_argument('--files', type=int, default=5000)
    parser.add_argument('--output-dir', type=Path, required=True)
    parser.add_argument('--smoke', action='store_true')
    args = parser.parse_args()
    print(json.dumps(run(args.models, args.files, args.output_dir.resolve(), args.smoke), indent=2))
