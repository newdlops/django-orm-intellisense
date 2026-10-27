"""ABBA comparison of first lookups in ordinary configured deferred daemons.

Application caches and the generated fixture stay outside the development
workspace. A is an archived baseline package; B is the current package. The
existing two-second idle scheduling and one-second registry timeout stay fixed.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import sys
import tarfile
import tempfile
from pathlib import Path

from benchmarks.bench_async_runtime_member_refresh import create_fixture


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def tree(root: Path) -> tuple[str, list[Path]]:
    paths = sorted(root.rglob('*.py'))
    digest = hashlib.sha256()
    for path in paths:
        digest.update(path.relative_to(root).as_posix().encode() + b'\0' + path.read_bytes() + b'\0')
    return digest.hexdigest(), paths


def run(models: int, files: int, output: Path, baseline: Path, smoke: bool) -> dict:
    output.mkdir(parents=True, exist_ok=False)
    repo = Path(__file__).resolve().parents[2]
    baseline_record = json.loads(baseline.read_text())
    baseline_python = Path(baseline_record['pythonBaseline']['pythonPath'])
    baseline_package = baseline_python / 'django_orm_intellisense'
    for name, expected in baseline_record['pythonBaseline']['files'].items():
        assert sha(baseline_package / name) == expected, name
    reproduction = Path(tempfile.mkdtemp(prefix='djls-initial-catalog-repro-', dir='/private/tmp'))
    root = reproduction / 'fixture'
    root.mkdir()
    create_fixture(root, models, files)
    uuid = root / 'app0/model_1.py'
    uuid.write_text(uuid.read_text().replace('class Model1(models.Model):',
        'class Model1(models.Model):\n    key = models.UUIDField(primary_key=True)'))
    source_tree, paths = tree(root)
    assert len(paths) == files
    fixture_archive = output / 'fixture-source.tar.gz'
    with tarfile.open(fixture_archive, 'w:gz') as archive:
        for path in paths:
            archive.add(path, arcname=path.relative_to(root), recursive=False)
    probe = repo / 'scripts/probe-initial-lookup-catalog.cjs'
    rows = []
    for index, variant in enumerate(['baseline', 'current'] if smoke else ['baseline', 'current', 'current', 'baseline']):
        folder = output / f'{index}-{variant}'
        folder.mkdir()
        python_path = baseline_python if variant == 'baseline' else repo / 'python'
        package = python_path / 'django_orm_intellisense'
        package_hashes = {path.relative_to(package).as_posix(): sha(path)
            for path in sorted(package.rglob('*.py'))}
        manifest = {
            'root': str(root), 'cache': str(reproduction / f'{index}-{variant}-cache'),
            'python': sys.executable, 'pythonPath': str(python_path),
            'workerModule': 'django_orm_intellisense', 'variant': variant,
            'models': models, 'pythonFiles': files, 'idleMs': 2000,
            'transportVersion': 1, 'sourceTreeSha256': source_tree,
            'probeSha256': sha(probe), 'driverSha256': sha(Path(__file__)),
            'workerPackageSha256': package_hashes,
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
        rows.append({'index': index, 'variant': variant, 'artifact': str(folder / 'result.json'), 'result': result})
        assert tree(root)[0] == source_tree, 'Fixture changed during cohort'
        for name, expected in package_hashes.items():
            assert sha(package / name) == expected, name
        print(f'[initial-catalog] {index} {variant} cold+cached terminalExit0', file=sys.stderr, flush=True)
    return {
        'models': models, 'pythonFiles': files, 'sourceTreeSha256': source_tree,
        'fixtureArchive': str(fixture_archive), 'fixtureArchiveSha256': sha(fixture_archive),
        'reproductionRoot': str(reproduction), 'order': 'AB' if smoke else 'ABBA',
        'baseline': str(baseline), 'baselineSha256': sha(baseline),
        'driverSha256': sha(Path(__file__)), 'probeSha256': sha(probe), 'python': sys.version,
        'rows': rows, 'sourceTreeUnchangedAfterAllDaemons': True,
        'inheritedDJLSEnvironment': {key: value for key, value in os.environ.items() if key.startswith('DJLS_')},
        'scope': 'Ordinary configured CLI daemons with deferRuntime=true and compact transport v1. '
            'Serial exact positive, negative, instance-custom and UUID queries from initialize through full receipt. '
            'Source archived before measurements; all request results retained; no profiling worker or lock injection. '
            'Both variants retain idle=2000ms and registry mode=full/default lock timeout. '
            'Cold means absent application cache, not cold OS/filesystem cache. Host load uncontrolled. '
            'Editor adoption, physical paint, total memory and broader startup/RPC SLO remain open.',
    }


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--models', type=int, default=500)
    parser.add_argument('--files', type=int, default=5000)
    parser.add_argument('--output-dir', type=Path, required=True)
    parser.add_argument('--baseline', type=Path, default=Path('bench/initial-lookup-catalog-baseline.json'))
    parser.add_argument('--smoke', action='store_true')
    args = parser.parse_args()
    print(json.dumps(run(args.models, args.files, args.output_dir.resolve(), args.baseline.resolve(), args.smoke), indent=2))
